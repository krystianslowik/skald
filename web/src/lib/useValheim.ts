import { useCallback, useEffect, useRef, useState } from "react";
import { capRecent } from "@server/history";
import { UNSTORED_EVENTS, type AgentEvent, type ApiState, type LiveMessage, type LogLine } from "../types";
import { getLogs, getState, Unauthorized } from "./api";
import { applyEvent } from "./apply";
import { getLivePositions, setLivePositions, setPositionsSink, watchingPositions } from "./live";

const MAX_LOGS = 1500;

/**
 * The live log tail, kept outside React state: log lines are the most frequent
 * event, and only the Chronicle shows them, so only the Chronicle subscribes
 * (useSyncExternalStore). The rest of the dashboard does not re-render per line.
 */
export interface LogStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): LogLine[];
}

export function createLogStore(initial: LogLine[] = []): LogStore & { set(next: (l: LogLine[]) => LogLine[]): void } {
  let lines = initial;
  const listeners = new Set<() => void>();
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

export interface Valheim {
  state: ApiState | null;
  logs: LogStore;
  /** Live link to the agent (WebSocket up and the server reports the agent reachable). */
  online: boolean;
  /** Last agent `action` events, newest first. */
  lastAction: AgentEvent | null;
}

export function useValheim(onUnauthorized: () => void): Valheim {
  const [state, setState] = useState<ApiState | null>(null);
  const [logs] = useState(createLogStore);
  // "connecting" counts as fine so the outage banner does not flash on page load.
  const [ws, setWs] = useState<"connecting" | "up" | "down">("connecting");
  const [agentUp, setAgentUp] = useState(true);
  const [lastAction, setLastAction] = useState<AgentEvent | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unauth = useRef(onUnauthorized);
  unauth.current = onUnauthorized;

  const refresh = useCallback(async () => {
    try {
      const s = await getState();
      setState((prev) => (prev ? share(prev, s) : s));
      setAgentUp(s.online);
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

  /** History (rankings, saga) is derived server-side; re-read it shortly after notable events. */
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(refreshIfShown, 1500);
  }, [refreshIfShown]);

  useEffect(() => {
    void refresh();
    getLogs(500).then((l) => logs.set(() => l)).catch(() => undefined);
    const poll = setInterval(refreshIfShown, 60_000);
    const onVisible = () => {
      if (document.hidden || !missed.current) return;
      missed.current = false;
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh, refreshIfShown, logs]);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let sock: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onEvent = (ev: AgentEvent) => {
      if (ev.type === "log") {
        const line = String(ev.data.line ?? "");
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
        const players = ev.type === "player_leave" ? live.players.filter((p) => p.name !== ev.data.name) : [];
        if (players.length !== live.players.length) setLivePositions({ t: live.t, players });
      }
      setState((s) => {
        if (!s) return s;
        const next = applyEvent(s, ev);
        if (ev.type === "player_count" || UNSTORED_EVENTS.includes(ev.type)) return next;
        return { ...next, history: { ...next.history, events: capRecent([ev, ...next.history.events]) } };
      });
      if (ev.type !== "player_count" && !UNSTORED_EVENTS.includes(ev.type)) refreshSoon();
    };

    const connect = () => {
      if (typeof WebSocket === "undefined") return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      // topics=: positions only after a subscribe; a server older than that sends them anyway.
      const s = new WebSocket(`${proto}//${location.host}/live?topics=`);
      sock = s;
      s.onopen = () => {
        attempt = 0;
        if (cancelled) return;
        setWs("up");
        if (watchingPositions()) tell(s, true);
      };
      s.onmessage = (m) => {
        if (cancelled) return;
        let msg: LiveMessage;
        try {
          msg = JSON.parse(String(m.data)) as LiveMessage;
        } catch {
          return;
        }
        if (msg.type === "event") onEvent(msg.event);
        else if (msg.type === "positions") {
          // One still on its way after the last watcher left must not bring the markers back.
          if (watchingPositions()) setLivePositions({ t: msg.t, players: msg.players });
        }
        else {
          setAgentUp(msg.online);
          setState((s) => (s ? share(s, { ...s, ...msg.state, online: msg.online }) : s));
        }
      };
      s.onclose = () => {
        if (cancelled) return;
        setWs("down");
        // A closed socket may mean an expired session; /api/state tells us.
        void refresh();
        const delay = Math.min(30_000, 1000 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
    };

    const tell = (s: WebSocket, on: boolean) => s.send(JSON.stringify({ type: on ? "subscribe" : "unsubscribe", topic: "positions" }));
    // A socket still connecting subscribes in onopen; a closed one on the next.
    setPositionsSink((on) => {
      if (sock && sock.readyState === WebSocket.OPEN) tell(sock, on);
    });

    connect();
    return () => {
      cancelled = true;
      setPositionsSink(null);
      if (timer) clearTimeout(timer);
      sock?.close();
    };
  }, [refresh, refreshSoon, logs]);

  return { state, logs, online: ws !== "down" && agentUp, lastAction };
}
