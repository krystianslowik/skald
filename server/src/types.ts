// Shared wire types. Kept free of Bun/Node imports: the web package compiles
// this file through its `@server/*` path alias.

export type ServerStatus = "starting" | "running" | "stopping" | "stopped" | "unknown";
export type PlayfabState = "ok" | "connecting" | "error";
export type ActionName = "backup" | "restart" | "update";

export const ACTION_NAMES: readonly ActionName[] = ["backup", "restart", "update"];

export interface Player {
  name: string;
  since: string;
}

/** Backup file names the agent produces; anything else never reaches it. */
export const BACKUP_NAME = /^worlds-\d{8}-\d{6}\.zip$/;

export interface Backup {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

/** Latest "Connections N ZDOS:..." summary from the server log. */
export interface NetStats {
  connections: number;
  zdos: number;
  sent: number;
  recv: number;
}

/** Decoded from the newest save generation (`_main.<N>.fwl2` + `.db2`). */
export interface WorldMeta {
  name: string;
  seedName: string;
  seed: number;
  worldGenVersion: number;
  /** In-game seconds since world creation. */
  netTime: number;
  /** floor(netTime / 1800); mapping to the in-game day counter is unverified. */
  day: number;
  savedAt: string;
}

export interface AgentState {
  now: string;
  server: {
    name: string;
    world: string;
    args: string;
    status: ServerStatus;
    processes: Record<string, string>;
    serverStartedAt: string | null;
    version: string;
    networkVersion: number;
    joinCode: string;
    joinCodeAt: string | null;
    playersReported: number;
    playfab: PlayfabState;
    netStats: NetStats | null;
  };
  players: Player[];
  world: { sizeBytes: number; lastSaveAt: string | null; lastSaveMs: number; meta: WorldMeta | null };
  backups: Backup[];
  agent: { startedAt: string; lastLogAt: string | null };
}

export type AgentEventType =
  | "log"
  | "join_code"
  | "player_count"
  | "player_join"
  | "player_leave"
  | "death"
  | "world_saved"
  | "version"
  | "server_state"
  | "playfab"
  | "action"
  | "raid"
  | "net_stats";

/** High-frequency types that are broadcast live but never stored in history. */
export const UNSTORED_EVENTS: readonly AgentEventType[] = ["log", "net_stats"];

export interface AgentEvent {
  seq: number;
  ts: string;
  type: AgentEventType;
  data: Record<string, unknown>;
}

export interface LogLine {
  ts: string;
  line: string;
}

export interface PlayerStats {
  name: string;
  sessions: number;
  playtimeMs: number;
  deaths: number;
  lastSeen: string;
  online: boolean;
}

/**
 * An achievement; `earnedAt` is null while it is still locked. Labels live in
 * the web app's dictionaries, keyed by `id`.
 */
export interface Badge {
  id: string;
  earnedAt: string | null;
}

/** Playtime on one calendar day (`YYYY-MM-DD`) in the configured time zone. */
export interface DailyPlay {
  day: string;
  ms: number;
}

/** GET /api/players[/:name]: everything the profile sheet shows. */
export interface PlayerProfile {
  name: string;
  online: boolean;
  firstSeen: string;
  lastSeen: string;
  playtimeMs: number;
  sessions: number;
  longestSessionMs: number;
  deaths: number;
  /** Deaths per hour of playtime; 0 without playtime. */
  deathsPerHour: number;
  /** Consecutive local days played, ending today (or yesterday if not yet today). */
  currentStreak: number;
  longestStreak: number;
  /** The last 30 local days, oldest first, zero days included. */
  daily: DailyPlay[];
  badges: Badge[];
}

/** One step of the players-online series: from `ts` on, `count` players. */
export type SeriesPoint = [ts: number, value: number];

export interface History {
  players: PlayerStats[];
  events: AgentEvent[];
  online7d: SeriesPoint[];
}

export interface Metrics {
  cpu: SeriesPoint[];
  memory: SeriesPoint[];
  rx: SeriesPoint[];
  tx: SeriesPoint[];
}

/** GET /api/state: the agent's state, plus what the web tier adds. */
export type ApiState = AgentState & {
  online: boolean;
  history: History;
  /** False when PROM_URL is unset: the charts explain how to enable them. */
  metricsConfigured: boolean;
  /** null when Prometheus is configured but did not answer. */
  metrics: Metrics | null;
};

export type Locale = "en" | "pl";

/** GET /api/config: public, readable before login (the login screen needs it). */
export interface PublicConfig {
  locale: Locale;
}

export type LiveMessage =
  | { type: "event"; event: AgentEvent }
  | { type: "state"; state: AgentState; online: boolean };

export interface ActionResult {
  ok: boolean;
  message: string;
}

export function emptyAgentState(now = new Date()): AgentState {
  return {
    now: now.toISOString(),
    server: {
      name: "",
      world: "",
      args: "",
      status: "unknown",
      processes: {},
      serverStartedAt: null,
      version: "",
      networkVersion: 0,
      joinCode: "",
      joinCodeAt: null,
      playersReported: 0,
      playfab: "connecting",
      netStats: null,
    },
    players: [],
    world: { sizeBytes: 0, lastSaveAt: null, lastSaveMs: 0, meta: null },
    backups: [],
    agent: { startedAt: now.toISOString(), lastLogAt: null },
  };
}
