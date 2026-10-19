import { useCallback, useEffect, useRef, useState } from "react";
import { capRecent } from "@server/history";
import type { AgentEvent, ApiState, LiveWireMessage, LogLine } from "../types";
import { getLogs, getState, Unauthorized } from "./api";
import { applyEvent, playerKey } from "./apply";
import { getLivePositions, setLivePositions, setPositionsSink, watchingPositions } from "./live";

const MAX_LOGS = 1500;
/** Hidden at least this long, the page reads state and the log tail again on return. */
const LONG_AWAY_MS = 30_000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

/**
 * The live log tail, kept outside React state: log lines are the most frequent
 * event, and only the Chronicle shows them, so only the Chronicle subscribes
 * (useSyncExternalStore). The rest of the dashboard does not re-render per line.
 * While it is mounted it also `watch`es: only then does the server send lines.
 */
export interface LogStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): LogLine[];
  /** Asks the server for live lines until the returned function is called. */
  watch?(): () => void;
}

export interface LiveLogStore extends LogStore {
  set(next: (l: LogLine[]) => LogLine[]): void;
  watch(): () => void;
  watching(): boolean;
  /** Where the first watcher and the last one going are reported (the /live socket). */
  setSink(fn: ((on: boolean) => void) | null): void;
}

export function createLogStore(initial: LogLine[] = []): LiveLogStore {
  let lines = initial;
  const listeners = new Set<() => void>();
  let watchers = 0;
  let sink: ((on: boolean) => void) | null = null;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => lines,
    set(next) {
      lines = next(lines);
      for (const l of listeners) l();
    },
    watch() {
      watchers += 1;
      if (watchers === 1) sink?.(true);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        watchers -= 1;
        if (watchers === 0) sink?.(false);
      };
    },
    watching: () => watchers > 0,
    setSink(fn) {
      sink = fn;
    },
  };
}

/**
 * Keeps the previous object for every top-level slice that did not change (and
 * the previous state itself when nothing did), so memoized planks skip.
 */
export function share(prev: ApiState, next: ApiState): ApiState {
  const out = { ...next } as Record<string, unknown>;
  const old = prev as unknown as Record<string, unknown>;
  let changed = Object.keys(old).length !== Object.keys(out).length;
  for (const k of Object.keys(out)) {
    const a = old[k];
    const b = out[k];
    if (a === b) continue;
    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null && JSON.stringify(a) === JSON.stringify(b)) out[k] = a;
    else changed = true;
  }
  return changed ? (out as unknown as ApiState) : prev;
}

/** Adds a stored event to the newest-first saga where its time puts it (a late or replayed one lands lower). */
export function addEvent(events: AgentEvent[], ev: AgentEvent): AgentEvent[] {
  const at = Date.parse(ev.ts);
  const i = events.findIndex((e) => Date.parse(e.ts) <= at);
  return capRecent(i < 0 ? [...events, ev] : [...events.slice(0, i), ev, ...events.slice(i)]);
}

export interface Valheim {
  state: ApiState | null;
  logs: LogStore;
  /** Live link to the agent (WebSocket up and the server reports the agent reachable). */
  online: boolean;
  /** Last agent `action` events, newest first. */
  lastAction: AgentEvent | null;
  /** Reconnects and reads state now instead of waiting out the backoff. */
  retry?: () => void;
}

export function useValheim(onUnauthorized: () => void): Valheim {
  const [state, setState] = useState<ApiState | null>(null);
  const [logs] = useState(createLogStore);
  // "connecting" counts as fine so the outage banner does not flash on page load.
  const [ws, setWs] = useState<"connecting" | "up" | "down">("connecting");
  const [agentUp, setAgentUp] = useState(true);
  const [lastAction, setLastAction] = useState<AgentEvent | null>(null);
  const unauth = useRef(onUnauthorized);
  unauth.current = onUnauthorized;

  /** Set by the socket effect: what a wake from "online" does. */
  const kick = useRef<() => void>(() => undefined);
  const retry = useCallback(() => kick.current(), []);

  /** Bumped by every stored event and history delta from the socket. */
  const liveGen = useRef(0);
  const refresh = useCallback(async function read(again = true): Promise<void> {
    const gen = liveGen.current;
    try {
      const s = await getState();
      setState((prev) => (prev ? share(prev, s) : s));
      setAgentUp(s.online);
      // Derived before a delta that arrived meanwhile, so it just undid that delta: read once more.
      if (again && gen !== liveGen.current) await read(false);
    } catch (e) {
      if (e instanceof Unauthorized) unauth.current();
    }
  }, []);

  /**
   * A hidden tab (a phone with the app in the background) does not refetch:
   * the socket keeps the live parts current, and the first look back catches
   * up on the rest with one request.
   */
  const missed = useRef(false);
  const refreshIfShown = useCallback(() => {
    if (document.hidden) missed.current = true;
    else void refresh();
  }, [refresh]);

  /** Log lines appended from the socket so far, and the latest tail request. */
  const liveLines = useRef(0);
  const logRequest = useRef(0);

  /**
   * Replaces the log tail with the server's last lines (appending would keep a
   * gap). Lines the socket delivered while the request was out stay on top
   * unless the server's tail already has them; an older response is dropped.
   */
  const reloadLogs = useCallback(() => {
    const req = ++logRequest.current;
    const seen = liveLines.current;
    getLogs(500)
      .then((l) => {
        if (req !== logRequest.current) return;
        const since = liveLines.current - seen;
        logs.set((cur) => {
          if (since === 0) return l;
          const have = new Set(l.map((x) => `${x.ts}\n${x.line}`));
          const merged = l.concat(cur.slice(-since).filter((x) => !have.has(`${x.ts}\n${x.line}`)));
          return merged.length > MAX_LOGS ? merged.slice(merged.length - MAX_LOGS) : merged;
        });
      })
      .catch(() => undefined);
  }, [logs]);

  useEffect(() => {
    void refresh();
    const poll = setInterval(refreshIfShown, 60_000);
    return () => {
      clearInterval(poll);
    };
  }, [refresh, refreshIfShown]);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let sock: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Set once a socket closes: what happened until the next one opens never reached us.
    let dropped = false;
    let hiddenAt: number | null = document.hidden ? Date.now() : null;
    // The Chronicle asked for lines while no socket was open: the tail is read again once one is.
    let logsPending = logs.watching();

    /** /live does not replay what was missed: read state and, if shown, the log tail again. */
    const resync = () => {
      missed.current = false;
      void refresh();
      if (logs.watching()) reloadLogs();
    };

    /** `stored`: the server kept it in the history, so the saga gains a line; rankings follow as a "history" message. */
    const onEvent = (ev: AgentEvent, stored: boolean) => {
      if (ev.type === "log") {
        const line = String(ev.data.line ?? "");
        liveLines.current += 1;
        logs.set((l) => {
          const next = l.length >= MAX_LOGS ? l.slice(l.length - MAX_LOGS + 1) : l.slice();
          next.push({ ts: ev.ts, line });
          return next;
        });
        return;
      }
      if (ev.type === "action") setLastAction(ev);
      // Markers leave with their players, and all of them with the server.
      if (ev.type === "player_leave" || (ev.type === "server_state" && ev.data.status !== "running")) {
        const live = getLivePositions();
        // By id: another player sharing the name keeps their marker.
        const players = ev.type === "player_leave" ? live.players.filter((p) => (p.id ?? p.name) !== playerKey(ev.data)) : [];
        if (players.length !== live.players.length) setLivePositions({ t: live.t, players });
      }
      setState((s) => {
        if (!s) return s;
        const next = applyEvent(s, ev);
        if (!stored || ev.type === "player_count" || ev.type === "player_platform") return next;
        return { ...next, history: { ...next.history, events: addEvent(next.history.events, ev) } };
      });
    };

    const connect = () => {
      if (typeof WebSocket === "undefined") return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      // topics=: positions only after a subscribe; a server older than that sends them anyway.
      // logtopic=1: log lines only after a subscribe too (only the Chronicle shows them).
      // history=1: this page applies "history" deltas, so the server sends them.
      const s = new WebSocket(`${proto}//${location.host}/live?topics=&history=1&logtopic=1`);
      sock = s;
      // A socket replaced by wake() may still report late; only the current one counts.
      const stale = () => cancelled || s !== sock;
      s.onopen = () => {
        if (stale()) return;
        attempt = 0;
        setWs("up");
        if (watchingPositions()) tell(s, true);
        if (logs.watching()) tell(s, true, "logs");
        const gap = logsPending;
        logsPending = false;
        if (!dropped) {
          if (gap && logs.watching()) reloadLogs();
          return;
        }
        dropped = false;
        // Events that passed while the socket was down are only in /api/state.
        resync();
      };
      s.onmessage = (m) => {
        if (stale()) return;
        let msg: LiveWireMessage;
        try {
          msg = JSON.parse(String(m.data)) as LiveWireMessage;
        } catch {
          return;
        }
        if (msg.type === "event") {
          if (msg.stored) liveGen.current += 1;
          onEvent(msg.event, msg.stored === true);
        } else if (msg.type === "history") {
          liveGen.current += 1;
          const { players, online7d } = msg;
          setState((s) => (s ? share(s, { ...s, history: { ...s.history, players, online7d } }) : s));
        } else if (msg.type === "positions") {
          // One still on its way after the last watcher left must not bring the markers back.
          if (watchingPositions()) setLivePositions({ t: msg.t, players: msg.players });
        } else if (msg.type === "state") {
          // Newer than a /api/state read still on its way, which must not undo
          // it: the hub does not send these slices again.
          if ("partial" in msg) liveGen.current += 1;
          setAgentUp(msg.online);
          // A `partial` state holds only the slices that changed; a whole one replaces them all.
          setState((s) => (s ? share(s, { ...s, ...msg.state, online: msg.online }) : s));
        }
      };
      s.onclose = () => {
        if (stale()) return;
        dropped = true;
        setWs("down");
        // A closed socket may mean an expired session; /api/state tells us.
        void refresh();
        const delay = Math.min(30_000, 1000 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
    };

    const tell = (s: WebSocket, on: boolean, topic = "positions") => s.send(JSON.stringify({ type: on ? "subscribe" : "unsubscribe", topic }));
    // A socket still connecting subscribes in onopen; a closed one on the next.
    setPositionsSink((on) => {
      if (sock && sock.readyState === WS_OPEN) tell(sock, on);
    });
    // Lines that passed while nobody watched never came: the tail is read again
    // (after the subscribe, so nothing falls between the two).
    logs.setSink((on) => {
      const st = sock?.readyState;
      if (st === WS_OPEN) tell(sock!, on, "logs");
      if (!on) return;
      // Without an open socket the tail is read now (a socket that never opens
      // still shows it) and once more when one opens, for the lines in between.
      if (st !== WS_OPEN) logsPending = true;
      reloadLogs();
    });

    /**
     * Back in front (a phone unlocked, a tab shown, a page restored from the
     * back-forward cache) or back online. The backoff grown while asleep no
     * longer applies: a dead or doubtful socket is replaced at once, and the
     * new one resyncs when it opens. A short look away keeps a healthy socket
     * and only catches up on state a hidden poll skipped.
     */
    const wake = (e: Event) => {
      if (cancelled) return;
      if (document.hidden) {
        hiddenAt ??= Date.now();
        return;
      }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      attempt = 0;
      // Back online, out of the back-forward cache or after a long sleep, a
      // socket that looks open may be one the phone lost without a close.
      const suspect = e.type === "online" || (e as PageTransitionEvent).persisted === true || away >= LONG_AWAY_MS;
      const st = sock?.readyState;
      // A retry stuck connecting since before the sleep is not trusted either.
      const healthy = st === WS_OPEN || (st === WS_CONNECTING && !dropped);
      if (healthy && !suspect) {
        if (missed.current) {
          missed.current = false;
          void refresh();
        }
        return;
      }
      if (timer) clearTimeout(timer);
      timer = null;
      dropped = true;
      const old = sock;
      connect();
      old?.close();
    };
    // The new socket reads state again when it opens.
    kick.current = () => wake(new Event("online"));
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);

    connect();
    return () => {
      cancelled = true;
      setPositionsSink(null);
      logs.setSink(null);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("online", wake);
      if (timer) clearTimeout(timer);
      sock?.close();
    };
  }, [refresh, reloadLogs, logs]);

  return { state, logs, online: ws !== "down" && agentUp, lastAction, retry };
}
