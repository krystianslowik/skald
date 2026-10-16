import { useCallback, useEffect, useRef, useState } from "react";
import { capRecent } from "@server/history";
import { UNSTORED_EVENTS, type AgentEvent, type ApiState, type LiveMessage, type LogLine } from "../types";
import { getLogs, getState, Unauthorized } from "./api";
import { applyEvent } from "./apply";
import { getLivePositions, setLivePositions } from "./live";

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

  /** History (rankings, saga) is derived server-side; re-read it shortly after notable events. */
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void refresh(), 1500);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    getLogs(500).then((l) => logs.set(() => l)).catch(() => undefined);
    const poll = setInterval(() => void refresh(), 60_000);
    return () => {
      clearInterval(poll);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh, logs]);

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
      sock = new WebSocket(`${proto}//${location.host}/live`);
      sock.onopen = () => {
        attempt = 0;
        if (!cancelled) setWs("up");
      };
      sock.onmessage = (m) => {
        if (cancelled) return;
        let msg: LiveMessage;
        try {
          msg = JSON.parse(String(m.data)) as LiveMessage;
        } catch {
          return;
        }
        if (msg.type === "event") onEvent(msg.event);
        else if (msg.type === "positions") setLivePositions({ t: msg.t, players: msg.players });
        else {
          setAgentUp(msg.online);
          setState((s) => (s ? share(s, { ...s, ...msg.state, online: msg.online }) : s));
        }
      };
      sock.onclose = () => {
        if (cancelled) return;
        setWs("down");
        // A closed socket may mean an expired session; /api/state tells us.
        void refresh();
        const delay = Math.min(30_000, 1000 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      sock?.close();
    };
  }, [refresh, refreshSoon, logs]);

  return { state, logs, online: ws !== "down" && agentUp, lastAction };
}
