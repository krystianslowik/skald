import type { Hub } from "./hub";
import type { AgentState, LiveMessage, LiveWireMessage } from "./types";

/**
 * One browser socket on /live. Everything but positions and log lines goes
 * to every socket. Positions go only to sockets that asked for them:
 *
 * - `/live?topics=` (current web): none until `{type:"subscribe",topic:"positions"}`,
 *   until `{type:"unsubscribe",topic:"positions"}` again; `?topics=positions`
 *   subscribes from the start.
 * - `/live` with no `topics` (a web build from before this): positions all
 *   along, as it always had.
 *
 * Log lines (`log` events) work the same way with the topic `logs`, but only
 * for a socket opened with `logtopic=1` (current web): none until it
 * subscribes, or from the start with `logs` in `topics`. Without `logtopic=1`
 * (a web build from before 2026.10.8) a socket gets every line, as it always did.
 *
 * `history=1`: the page applies "history" deltas (the rankings after stored
 * events); a page without it refetches /api/state instead.
 *
 * A state from a poll carries only the slices that changed, marked
 * `partial`; the first state on a socket is always whole.
 */
export interface LiveSocketData {
  positions: boolean;
  logs: boolean;
  history: boolean;
  unsubscribe?: () => void;
  unwatch?: () => void;
  send?: (m: LiveMessage) => void;
}

export interface LiveSocket {
  data: LiveSocketData;
  /** `compress`: deflate the frame when the browser negotiated permessage-deflate. */
  send(s: string, compress?: boolean): unknown;
}

/** Topics a socket may subscribe to. */
const TOPICS = new Set(["positions", "logs"]);
/** A client message is a few dozen bytes; anything much longer is not one. */
const MAX_MESSAGE = 256;

/** Socket options for /live in `Bun.serve`. */
export const LIVE_WEBSOCKET = {
  // Clients only ever send a short subscribe or unsubscribe.
  maxPayloadLength: 4096,
  // JSON compresses well, and browsers ask for permessage-deflate on their own.
  // Shared compressor: no per-socket memory and no context carried between
  // messages, so one message's size says nothing about another's content.
  perMessageDeflate: true,
} as const;

export function liveSocketData(url: URL): LiveSocketData {
  const topics = url.searchParams.get("topics");
  const list = topics === null ? [] : topics.split(",");
  const history = url.searchParams.get("history") === "1";
  const logs = url.searchParams.get("logtopic") !== "1" || list.includes("logs");
  return { positions: topics === null || list.includes("positions"), logs, history };
}

/** What goes on the wire for one hub message: a state from a poll holds only the slices that changed. */
export function wire(m: LiveMessage): LiveWireMessage {
  if (m.type !== "state") return m;
  const { changed, ...whole } = m;
  if (!changed) return whole;
  // A slice the agent no longer sends goes out as null (JSON drops undefined), so the page forgets it.
  const state: Record<string, unknown> = {};
  for (const k of changed) state[k] = m.state[k] ?? null;
  return { type: "state", state: state as Partial<AgentState>, online: m.online, partial: true };
}

export function liveSocket(hub: Hub) {
  const watch = (ws: LiveSocket, on: boolean) => {
    if (on && !ws.data.unwatch && ws.data.send) ws.data.unwatch = hub.watchPositions(ws.data.send);
    if (!on && ws.data.unwatch) {
      ws.data.unwatch();
      ws.data.unwatch = undefined;
    }
  };
  return {
    open(ws: LiveSocket): void {
      const send = (m: LiveMessage) => {
        if (m.type === "event" && m.event.type === "log" && !ws.data.logs) return;
        // Every frame, short ones too: Safari (WebKit) drops the socket with a
        // protocol error when an uncompressed frame follows compressed ones.
        ws.send(JSON.stringify(wire(m)), true);
      };
      ws.data.send = send;
      send({ type: "state", state: hub.getState(), online: hub.online });
      ws.data.unsubscribe = hub.subscribe(send, { history: ws.data.history });
      watch(ws, ws.data.positions);
    },
    message(ws: LiveSocket, raw: string | Buffer): void {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      if (text.length > MAX_MESSAGE) return;
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;
      const { type, topic } = msg as { type?: unknown; topic?: unknown };
      if (typeof topic !== "string" || !TOPICS.has(topic)) return;
      if (type !== "subscribe" && type !== "unsubscribe") return;
      if (topic === "logs") ws.data.logs = type === "subscribe";
      else watch(ws, type === "subscribe");
    },
    close(ws: LiveSocket): void {
      ws.data.unsubscribe?.();
      watch(ws, false);
    },
  };
}
