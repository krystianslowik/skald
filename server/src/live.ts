import type { Hub } from "./hub";
import type { LiveMessage } from "./types";

/**
 * One browser socket on /live. Everything but positions goes to every
 * socket. Positions go only to sockets that asked for them:
 *
 * - `/live?topics=` (current web): none until `{type:"subscribe",topic:"positions"}`,
 *   until `{type:"unsubscribe",topic:"positions"}` again; `?topics=positions`
 *   subscribes from the start.
 * - `/live` with no `topics` (a web build from before this): positions all
 *   along, as it always had.
 */
export interface LiveSocketData {
  positions: boolean;
  unsubscribe?: () => void;
  unwatch?: () => void;
  send?: (m: LiveMessage) => void;
}

export interface LiveSocket {
  data: LiveSocketData;
  send(s: string): unknown;
}

/** Topics a socket may subscribe to. */
const TOPICS = new Set(["positions"]);
/** A client message is a few dozen bytes; anything much longer is not one. */
const MAX_MESSAGE = 256;

export function liveSocketData(url: URL): LiveSocketData {
  const topics = url.searchParams.get("topics");
  if (topics === null) return { positions: true };
  return { positions: topics.split(",").includes("positions") };
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
      const send = (m: LiveMessage) => ws.send(JSON.stringify(m));
      ws.data.send = send;
      send({ type: "state", state: hub.getState(), online: hub.online });
      ws.data.unsubscribe = hub.subscribe(send);
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
      if (type === "subscribe") watch(ws, true);
      else if (type === "unsubscribe") watch(ws, false);
    },
    close(ws: LiveSocket): void {
      ws.data.unsubscribe?.();
      watch(ws, false);
    },
  };
}
