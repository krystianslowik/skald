// Shared wire types. Kept free of Bun/Node imports: the web package compiles
// this file through its `@server/*` path alias.

export type ServerStatus = "starting" | "running" | "stopping" | "stopped" | "unknown";
export type PlayfabState = "ok" | "connecting" | "error";
export type ActionName = "backup" | "restart" | "update";

export const ACTION_NAMES: readonly ActionName[] = ["backup", "restart", "update"];

/** Platform type from the PlayFab handshake; the raw platform ID is never sent. */
export type Platform = "xbox" | "steam" | "playstation" | "nintendo" | "unknown";

export interface Player {
  name: string;
  since: string;
  /** Missing from agents older than 0.4.0. */
  platform?: Platform;
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
  /** floor(netTime / 1800); matches the game's own day counter. */
  day: number;
  savedAt: string;
  /**
   * Non-default world modifiers the world was created with (its starting
   * `preset` key), e.g. `{ resources: "muchmore", portals: "casual" }`.
   * null when unreadable; missing from agents older than 0.4.0.
   */
  modifiers?: Record<string, string> | null;
  /** Other starting keys, e.g. `teleportall`, `resourcerate 200`. */
  worldKeys?: string[] | null;
  /** Players the world remembers (count only). */
  knownPlayers?: number;
  /** Current global keys (`defeated_eikthyr`, `killedtroll`, ...); null when unreadable. */
  globalKeys?: string[] | null;
  /** The boss path in order; null when the global keys are unreadable. */
  bosses?: { key: string; defeated: boolean }[] | null;
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
  /** null when the agent has no writable SETTINGS_DIR (or predates the feature). */
  settings?: SettingsSummary | null;
}

/** The settings part of the agent's /state: enough for the header chips. */
export interface SettingsSummary {
  enabled: boolean;
  /** Saved after the running server started: a restart applies it. */
  pending: boolean;
  /** An apply-when-empty is waiting for the last player to leave. */
  armed: boolean;
  passwordSet: boolean;
}

/** Saved server settings without the password (agent GET /settings `current`). */
export interface SettingsCurrent {
  name: string;
  public: boolean;
  /** One of PRESETS in settings.ts; "normal" for none. */
  preset: string;
  /** Overrides on top of the preset, by modifier name. Absent = preset's value. */
  modifiers: Partial<Record<string, string>>;
  keys: string[];
  /** Seconds; 1800 is the game's default. */
  saveInterval: number;
  /** SERVER_ARGS tokens Skald does not manage; read-only, kept on save. */
  unmanaged: string[];
}

/** Body of PUT /api/settings. Leave `password` out to keep the current one. */
export interface SettingsInput {
  name: string;
  password?: string;
  public: boolean;
  preset: string;
  modifiers: Record<string, string>;
  keys: string[];
  saveInterval: number;
}

export type HookStatus = "ok" | "missing" | "unknown";

/** GET /api/settings. */
export interface SettingsView {
  current: SettingsCurrent;
  pending: boolean;
  /** What the running server was started with. */
  effective: { name: string; public: boolean; args: string };
  password: { set: boolean };
  apply: { armed: boolean; since: string | null };
  /** Whether the game confirmed reading the settings at its last start. */
  hook: HookStatus;
  updatedAt: string | null;
}

export type ApplyMode = "now" | "when_empty";

/** One settings call, proxied to the agent (or answered by the mock). */
export type SettingsRequest =
  | { op: "get" }
  | { op: "password" }
  | { op: "put"; body: unknown }
  | { op: "apply"; mode: ApplyMode }
  | { op: "cancel" };

export type AgentEventType =
  | "log"
  | "join_code"
  | "player_count"
  | "player_join"
  | "player_leave"
  | "death"
  | "world_saved"
  | "world_backup"
  | "version"
  | "server_state"
  | "playfab"
  | "action"
  | "raid"
  | "net_stats"
  | "settings_changed"
  | "settings_apply";

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
  /** Platform of the latest join that carried one; null when never seen. */
  platform: Platform | null;
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
    settings: null,
  };
}
