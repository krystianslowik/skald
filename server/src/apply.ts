import type { AgentEvent, AgentState } from "./types";

/**
 * Applies one live agent event to the last known state. Used by the hub (so
 * /api/state is never staler than the event stream) and by the browser.
 */
export function applyEvent<S extends AgentState>(s: S, ev: AgentEvent): S {
  const d = ev.data;
  switch (ev.type) {
    case "join_code":
      return { ...s, server: { ...s.server, joinCode: String(d.code ?? ""), joinCodeAt: ev.ts } };
    case "player_join": {
      const name = String(d.name ?? "");
      if (!name || s.players.some((p) => p.name === name)) return s;
      return { ...s, players: [...s.players, { name, since: ev.ts }] };
    }
    case "player_leave":
      return { ...s, players: s.players.filter((p) => p.name !== d.name) };
    case "player_count": {
      const count = Number(d.count);
      return { ...s, players: count === 0 ? [] : s.players, server: { ...s.server, playersReported: count } };
    }
    case "world_saved":
      return { ...s, world: { ...s.world, lastSaveAt: ev.ts, lastSaveMs: Number(d.ms) || 0 } };
    case "version":
      return { ...s, server: { ...s.server, version: String(d.version ?? ""), networkVersion: Number(d.networkVersion) || 0 } };
    case "server_state": {
      const status = String(d.status) as AgentState["server"]["status"];
      const players = status === "running" ? s.players : [];
      const serverStartedAt = status === "running" && s.server.status !== "running" ? ev.ts : s.server.serverStartedAt;
      return { ...s, players, server: { ...s.server, status, serverStartedAt } };
    }
    case "net_stats":
      return {
        ...s,
        server: {
          ...s.server,
          netStats: { connections: Number(d.connections) || 0, zdos: Number(d.zdos) || 0, sent: Number(d.sent) || 0, recv: Number(d.recv) || 0 },
        },
      };
    case "playfab":
      return { ...s, server: { ...s.server, playfab: String(d.state) as AgentState["server"]["playfab"] } };
    default:
      return s;
  }
}
