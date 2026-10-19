import { isPlatform, type AgentEvent, type AgentState, type CompatResult } from "./types";

/**
 * Which online player a join, leave or platform event is about: its id, or
 * its name from agents that send no id. Two players whose characters share
 * a name have different ids.
 */
export function playerKey(d: Record<string, unknown>): string {
  return typeof d.id === "string" && d.id ? d.id : typeof d.name === "string" ? d.name : "";
}

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
      const key = playerKey(d);
      if (!name || s.players.some((p) => (p.id ?? p.name) === key)) return s;
      const platform = isPlatform(d.platform) ? d.platform : undefined;
      const id = typeof d.id === "string" && d.id ? { id: d.id } : {};
      return { ...s, players: [...s.players, platform ? { ...id, name, since: ev.ts, platform } : { ...id, name, since: ev.ts }] };
    }
    case "player_leave": {
      const key = playerKey(d);
      return { ...s, players: s.players.filter((p) => (p.id ?? p.name) !== key) };
    }
    case "player_platform": {
      // The admin plugin corrected the platform the log guessed.
      const key = playerKey(d);
      const platform = d.platform;
      if (!isPlatform(platform) || !s.players.some((p) => (p.id ?? p.name) === key)) return s;
      return { ...s, players: s.players.map((p) => ((p.id ?? p.name) === key ? { ...p, platform } : p)) };
    }
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
    case "compat": {
      // The agent sends the last result with every step: the one before while it runs.
      const result = d.result && typeof d.result === "object" ? (d.result as CompatResult) : (s.compat?.result ?? null);
      return { ...s, compat: { running: d.running === true, result } };
    }
    case "playfab":
      return { ...s, server: { ...s.server, playfab: String(d.state) as AgentState["server"]["playfab"] } };
    case "settings_changed":
      if (!s.settings) return s;
      return { ...s, settings: { ...s.settings, pending: true, passwordSet: s.settings.passwordSet || (Array.isArray(d.changedKeys) && d.changedKeys.includes("password")) } };
    case "settings_apply": {
      if (!s.settings) return s;
      const st = String(d.state);
      if (st === "armed") return { ...s, settings: { ...s.settings, armed: true } };
      if (st === "cancelled" || st === "applying" || st === "failed") return { ...s, settings: { ...s.settings, armed: false } };
      // applied: the restart picked the files up; /state brings the new name.
      if (st === "applied") return { ...s, settings: { ...s.settings, armed: false, pending: false } };
      return s;
    }
    default:
      return s;
  }
}
