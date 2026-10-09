import { useCallback, useEffect, useRef, useState } from "react";
import { UNSTORED_EVENTS, type AgentEvent, type ApiState, type LiveMessage, type LogLine } from "../types";
import { getLogs, getState, Unauthorized } from "./api";
import { applyEvent } from "./apply";

const MAX_LOGS = 1500;

export interface Valheim {
  state: ApiState | null;
  logs: LogLine[];
  /** Live link to the agent (WebSocket up and the server reports the agent reachable). */
  online: boolean;
  /** Last agent `action` events, newest first. */
  lastAction: AgentEvent | null;
}

export function useValheim(onUnauthorized: () => void): Valheim {
  const [state, setState] = useState<ApiState | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
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
      setState(s);
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
    getLogs(500).then(setLogs).catch(() => undefined);
    const poll = setInterval(() => void refresh(), 60_000);
    return () => {
      clearInterval(poll);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let sock: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onEvent = (ev: AgentEvent) => {
      if (ev.type === "log") {
        const line = String(ev.data.line ?? "");
        setLogs((l) => {
          const next = l.length >= MAX_LOGS ? l.slice(l.length - MAX_LOGS + 1) : l.slice();
          next.push({ ts: ev.ts, line });
          return next;
        });
        return;
      }
      if (ev.type === "action") setLastAction(ev);
      setState((s) => {
        if (!s) return s;
        const next = applyEvent(s, ev);
        if (ev.type === "player_count" || UNSTORED_EVENTS.includes(ev.type)) return next;
        return { ...next, history: { ...next.history, events: [ev, ...next.history.events].slice(0, 200) } };
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
        else {
          setAgentUp(msg.online);
          setState((s) => (s ? { ...s, ...msg.state, online: msg.online } : s));
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
  }, [refresh, refreshSoon]);

  return { state, logs, online: ws !== "down" && agentUp, lastAction };
}
