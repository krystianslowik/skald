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

/**
 * Where the world's day stands now (agent `world.clock`). netTime reaches disk
 * only with a save, so the agent extrapolates while players are on; a
 * dedicated server's world only advances with someone connected.
 */
export interface WorldClock {
  netTime: number;
  day: number;
  /** Time of day, 0..1: netTime mod the 1800 s day. */
  dayFraction: number;
  /** Approximate: the middle half of the day counts as daylight. */
  daylight: boolean;
  /** False when nobody is connected: the world is asleep, time frozen. */
  advancing: boolean;
  /** netTime per wall second between the last two saves seen; null until two. */
  rate: number | null;
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
  world: {
    sizeBytes: number;
    lastSaveAt: string | null;
    lastSaveMs: number;
    meta: WorldMeta | null;
    /** null when the save is unreadable; missing from agents older than 0.5.0. */
    clock?: WorldClock | null;
  };
  backups: Backup[];
  /** `version`: the agent's Skald release ("dev" for local builds); missing from agents older than 2026.10.0. */
  agent: { startedAt: string; lastLogAt: string | null; version?: string };
  /** null when the agent has no writable SETTINGS_DIR (or predates the feature). */
  settings?: SettingsSummary | null;
  /** Item icons from the operator's own game files; null when the agent has no ICONS_DIR (or predates 0.7.0). */
  icons?: IconsInfo | null;
  /** The world generator's terrain (`skald-terrain`); null without one and without a readable save (or before 0.7.0). */
  terrain?: TerrainInfo | null;
  /** The compatibility check with the game build; null from agents older than 2026.10.12. */
  compat?: CompatView | null;
}

// ---- compatibility check (agent GET /compat, /state.compat) -----------------

/** pending: waits for something that comes on its own; pending and skipped do not count toward the overall status. */
export type CompatStatus = "ok" | "warn" | "fail" | "pending" | "skipped";
export const COMPAT_CHECKS = ["version", "save", "terrain", "bridge", "logs"] as const;
export type CompatCheckName = (typeof COMPAT_CHECKS)[number];
/** start: first build since the agent started; update: a new build; save: the first save by an updated build; manual: an admin. */
export type CompatTrigger = "start" | "update" | "save" | "manual";

/** One graded part. `reason` is a short code; `detail` the numbers behind it (no names, ids or paths). */
export interface CompatCheck {
  name: CompatCheckName;
  status: CompatStatus;
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface CompatResult {
  build: string;
  networkVersion: number;
  /** The build checked before this one; missing on the very first check. */
  previousBuild?: string;
  previousNetworkVersion?: number;
  /** This build replaced `previousBuild`. */
  updated: boolean;
  trigger: CompatTrigger;
  startedAt: string;
  checkedAt: string;
  status: "ok" | "warn" | "fail";
  /** The newest save is from before the update; the save is checked again after the first save. */
  awaitingSave: boolean;
  generation: number;
  checks: CompatCheck[];
}

export interface CompatView {
  /** A check waits for the world or the map right now. */
  running: boolean;
  /** The last completed check; null before the first. */
  result: CompatResult | null;
}

/** The agent's terrain image and what a terrain run should sample (`/state.terrain`). */
export interface TerrainInfo {
  /** The agent has a TERRAIN_DIR. */
  enabled: boolean;
  /** An image for this world can be served. */
  available: boolean;
  /** A run is due: no grids yet, another seed, or an older game build. */
  stale: boolean;
  reason?: "missing" | "unreadable" | "world" | "seed" | "worldGenVersion" | "gameBuild";
  build?: string;
  resolution?: number;
  radius?: number;
  request: { seedName: string; seedHash: number; worldGenVersion: number; gameBuild: string } | null;
}

/** GET /api/terrain.json: where the terrain image sits. North up, spanning [-radius, radius] on both axes. */
export interface TerrainDoc {
  build: string;
  stale: boolean;
  reason?: string;
  seedHash: number;
  worldGenVersion: number;
  gameBuild: string;
  resolution: number;
  radius: number;
  waterLevel: number;
  renderedAt: string;
  biomes: string[];
}

/** The agent's item icon sheet (`/state.icons`). */
export interface IconsInfo {
  available: boolean;
  /** The game build the sheet was made from; the sheet's cache key. */
  build?: string;
  count: number;
}

/**
 * GET /api/icons/map.json: where each item's icon sits in the sheet.
 * `items[prefab]` is the cell's top-left corner in px; every cell is `size` px.
 */
export interface IconMap {
  version: number;
  build: string;
  size: number;
  columns: number;
  width: number;
  height: number;
  count: number;
  items: Record<string, [number, number]>;
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
  | "settings_apply"
  | "admin"
  | "compat"
  | "positions";

/** High-frequency types that are broadcast live but never stored in history. */
export const UNSTORED_EVENTS: readonly AgentEventType[] = ["log", "net_stats", "positions", "compat"];

/**
 * A bridge read (for example the map's terrain tiles) that reached the admin
 * audit trail. Reads are not admin commands: they are never stored, shown or
 * notified, even when the bridge turns one away with "too many requests".
 */
export function isBridgeRead(ev: AgentEvent): boolean {
  return ev.type === "admin" && typeof ev.data.command === "string" && ev.data.command.startsWith("GET ");
}

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
  /** This skald-web's Skald release ("dev" for local builds). Always set by the server; optional for test fixtures. */
  webVersion?: string;
};

export type Locale = "en" | "pl";

/** GET /api/config: public, readable before login (the login screen needs it). */
export interface PublicConfig {
  locale: Locale;
}

export type LiveMessage =
  /** `stored`: the event went into the history (repeats of an unchanged value do not), so the saga shows it. */
  | { type: "event"; event: AgentEvent; stored?: boolean }
  /** The derived rankings and 7-day series after stored events; the saga is kept from the events themselves. */
  | { type: "history"; players: History["players"]; online7d: History["online7d"] }
  /**
   * The agent's state. From the hub, `changed` lists the top-level slices
   * that differ from the last state it sent (absent: treat all as new); on
   * the wire such a message is `partial` and carries only those slices.
   */
  | { type: "state"; state: AgentState; online: boolean; changed?: StateSlice[] }
  | { type: "positions"; t: number; players: LivePlayer[] };

/** A top-level part of the agent's state; `now` is not one (it moves on every read). */
export type StateSlice = Exclude<keyof AgentState, "now">;

/**
 * A message as it travels on /live. A `partial` state holds only the slices
 * that changed: a page merges it over what it has (pages from before
 * 2026.10.8 already merge every state that way).
 */
export type LiveWireMessage =
  | Exclude<LiveMessage, { type: "state" }>
  | { type: "state"; state: AgentState; online: boolean }
  | { type: "state"; state: Partial<AgentState>; online: boolean; partial: true };

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
    icons: null,
    terrain: null,
    compat: null,
  };
}

// ---- world map (agent GET /map, web GET /api/map) --------------------------

/** World metres rounded to whole metres: x east, z north, origin at the centre. */
export interface MapPoint {
  x: number;
  z: number;
}

export interface MapMeta {
  seedName: string;
  seed: number;
  worldGenVersion: number;
  day: number;
  netTime: number;
  generation: number;
  savedAt: string;
  generatedAt: string;
  /** Names (owners, portal tags, pin names) were exported (agent MAP_SHOW_NAMES). */
  showNames: boolean;
}

/**
 * Zone grid, `size` x `size` zones of `zoneSize` m, row-major from zone
 * (`min`, `min`) east then north. `data` is base64, one byte per zone:
 * 0 never generated, 1 generated and empty (water), 2..255 log object density.
 */
export interface MapLand {
  zoneSize: number;
  min: number;
  size: number;
  data: string;
}

/**
 * Union of the cartography tables' explored masks: `size` x `size` pixels of
 * `metersPerPixel`, centred on the origin, row-major from the south-west.
 * `rle` (base64) is LEB128 run lengths alternating unexplored/explored,
 * starting with unexplored.
 */
export interface MapExplored {
  available: boolean;
  tables: number;
  size: number;
  metersPerPixel: number;
  pixels: number;
  rle: string;
}

export interface MapPin extends MapPoint {
  type: number;
  kind: string;
  name: string;
}

export interface MapPortal extends MapPoint {
  id: string;
  kind: string;
  tag: string;
  pairedWith?: string;
}

export interface MapTombstone extends MapPoint {
  owner: string;
  /** In-game day of the death; -1 when unknown. */
  day: number;
  /** What the grave holds, in slot order (absent from older agents). */
  items?: MapItem[];
}

export interface MapBed extends MapPoint {
  owner: string;
}

export interface MapVehicle extends MapPoint {
  /** Its entry in `storage` when a player built it. */
  id?: string;
  kind: string;
}

/**
 * One stack in a container. `name` is the item prefab ("#hash" when the agent
 * does not know it), `type` the game's item type ("Material", "Helmet", ...).
 * `quality` is absent at 1; `durability` is set only for things that wear;
 * `crafter` only with MAP_SHOW_NAMES. `x`, `y` is the slot.
 */
export interface MapItem {
  name: string;
  type?: string;
  stack: number;
  quality?: number;
  durability?: number;
  crafter?: string;
  x: number;
  y: number;
}

export type MapContainerKind = "chest" | "cart" | "ship";

/**
 * A chest, cart or ship a player built, with its inventory. World chests are
 * never listed. `id` is the prefab and rounded position; `width` x `height`
 * the inventory grid (0 x 0 for a raft). `unreadable`: the inventory did not
 * decode and `items` is empty. `y` is the height in metres (0.05 m steps)
 * that tells apart chests stacked on one spot; missing from agents older than
 * 0.8.6.
 */
export interface MapContainer extends MapPoint {
  id: string;
  kind: MapContainerKind;
  prefab: string;
  y?: number;
  width: number;
  height: number;
  items: MapItem[];
  unreadable?: boolean;
}

export interface MapBase extends MapPoint {
  pieces: number;
  zones: number;
  hasBed: boolean;
  stations: string[];
}

export type MapLocationKind = "start" | "boss" | "trader" | "dungeon";

export interface MapLocation extends MapPoint {
  kind: MapLocationKind;
  name: string;
  /** The game has built it (its zone was loaded). */
  placed: boolean;
  /** Inside the explored mask or within 64 m of a player-built piece. */
  explored: boolean;
}

export interface MapTerrainEdit extends MapPoint {
  cells: number;
}

export interface MapStats {
  zdos: number;
  chunks: number;
  chunksParsed: number;
  chunksFailed: number;
  pieces: number;
  generatedZones: number;
  locationsTotal: number;
  locationsPlaced: number;
  buildSeconds: number;
}

/** Agent GET /map. */
export interface MapSnapshot {
  meta: MapMeta;
  land: MapLand;
  explored: MapExplored;
  pins: MapPin[];
  portals: MapPortal[];
  tombstones: MapTombstone[];
  beds: MapBed[];
  vehicles: MapVehicle[];
  bases: MapBase[];
  locations: MapLocation[];
  terrainEdits: MapTerrainEdit[];
  /** Player-built containers (absent from older agents). */
  storage?: MapContainer[];
  stats: MapStats;
}

/** Web GET /api/map: the snapshot after the spoiler setting was applied. */
export interface ApiMap extends MapSnapshot {
  storage: MapContainer[];
  /** MAP_SPOILERS: unexplored locations are kept. */
  spoilers: boolean;
  /** Locations dropped because nobody has found them yet. */
  hiddenLocations: number;
}

/** Web GET /api/storage: the containers alone, for the village stores. */
export interface ApiStorage {
  generation: number;
  savedAt: string;
  showNames: boolean;
  containers: MapContainer[];
}

/** How a built piece is drawn on a floor plan. */
export type PieceKind = "wall" | "floor" | "roof" | "door" | "stair" | "beam" | "pole" | "fence" | "station" | "furniture" | "storage" | "light" | "portal" | "plant" | "other";

/**
 * A prefab on a floor plan: its plan-view rectangle in metres along the
 * piece's local x and z, the pitch of a roof in degrees (0 for anything
 * else), and whether the agent knows it (unknown ones are "#hash", 1 x 1 m).
 */
export type PiecePrefab = [name: string, kind: PieceKind, width: number, depth: number, slope: number, known: boolean];

/**
 * One built piece: index into `prefabs`, position and height in metres, yaw
 * in whole degrees clockwise seen from above (local +x points along
 * (cos yaw, -sin yaw) in world x, z), flags bit 0 for a piece tilted more
 * than 10 degrees.
 */
export type PieceRow = [prefab: number, x: number, z: number, y: number, yaw: number, flags: number];

/** Agent GET /pieces and web GET /api/pieces: what players built inside a box. */
export interface ApiPieces {
  generation: number;
  bbox: [x0: number, z0: number, x1: number, z1: number];
  prefabs: PiecePrefab[];
  pieces: PieceRow[];
  count: number;
  /** More pieces lie in the box than one answer carries (20,000). */
  truncated: boolean;
}

/** What a world object on the nature layer is. */
export type NatureCategory = "tree" | "stump" | "log" | "rock" | "bush" | "ore" | "pickable";

/**
 * A nature prefab: its category, a short species ("beech", "copper",
 * "raspberry", ...) and its plan-view size in metres at scale 1 (a tree's
 * crown, a log's length, a rock's width), a drawing hint.
 */
export type NatureKind = [name: string, category: NatureCategory, species: string, size: number];

/**
 * One object: index into `kinds`, position in metres (0.1 m), yaw in whole
 * degrees clockwise seen from above, and its scale (1 when the save holds
 * none). Its drawn size is the kind's size times the scale.
 */
export type NatureRow = [kind: number, x: number, z: number, yaw: number, scale: number];

/**
 * Agent GET /nature: the trees, stumps, logs, rocks, bushes, ore and
 * pickables the world generated inside a box. Without `spoilers` only those
 * on explored land or near a base are sent.
 */
export interface ApiNature {
  generation: number;
  bbox: [x0: number, z0: number, x1: number, z1: number];
  spoilers: boolean;
  kinds: NatureKind[];
  items: NatureRow[];
  count: number;
  /** More objects lie in the box than one answer carries (30,000). */
  truncated: boolean;
}

// ---- admin (the Skald bridge plugin, through the agent) --------------------

/**
 * Commands the panel may send (agent POST /bridge/{command}). The agent keeps
 * the same allow-list; `ack-build` lets commands run on a game build that is
 * not on the tested list. The agent owns it: its allowlist_test.go fails when
 * this list and agent/internal/bridge Commands drift apart.
 */
export const ADMIN_COMMANDS = [
  "broadcast",
  "save",
  "kick",
  "ban",
  "unban",
  "time",
  "skip-to-morning",
  "time-freeze",
  "time-resume",
  "event-start",
  "event-stop",
  "spawn",
  "teleport",
  "globalkey-set",
  "globalkey-remove",
  "creature-spawn",
  "creature-kill",
  "creature-tame",
  "heal",
  "status",
  "repair",
  "fill",
  "fill-kilns",
  "fill-smelters",
  "fill-fermenters",
  "grow",
  "map-reveal",
  "map-pins",
  "chest-add",
  "ack-build",
] as const;
export type AdminCommand = (typeof ADMIN_COMMANDS)[number];

/** Read-only bridge calls (agent GET /bridge/{name}). */
export const ADMIN_READS = ["time", "events", "globalkeys", "locations", "bans", "stations"] as const;
export type AdminRead = (typeof ADMIN_READS)[number];

/** Why the bridge cannot take commands right now. */
export type BridgeReason = "off" | "unreachable" | "disabled" | "token" | "loading" | "restarting" | "agent";

/** Agent GET /bridge/status. */
export interface BridgeStatus {
  available: boolean;
  reason?: BridgeReason;
  message?: string;
  plugin?: string;
  gameBuild?: string;
  worldLoaded: boolean;
  timeFrozen: boolean;
  /** The game build is on the agent's tested list. */
  tested: boolean;
  /** An admin confirmed this untested build from the panel. */
  acknowledged: boolean;
  testedBuilds: string[];
  commands: string[];
}

/** The Discord notification kinds; DISCORD_NOTIFY and the admin sheet pick from these. */
export const NOTIFY_KINDS = ["join", "leave", "death", "raid", "server", "join_code", "version", "compat", "failure"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/**
 * GET /api/admin/notify: Discord notifications as the admin sheet shows them.
 * The webhook URL is a secret and never comes back, only `masked`.
 */
/** PUT /api/admin/notify: fields left out keep their value. */
export type NotifyChange = { url?: string; enabled?: boolean; kinds?: NotifyKind[] };

export interface NotifyConfig {
  /** "env": DISCORD_WEBHOOK_URL is set and wins, read-only in the panel. */
  source: "env" | "panel";
  /** The webhook in a form that cannot be used, e.g. "discord.com/api/webhooks/…6789/AbCd…"; null when none is set. */
  masked: string | null;
  enabled: boolean;
  kinds: NotifyKind[];
}

/** GET /api/admin/status: the bridge and whether this browser may command it. */
export interface AdminStatus {
  bridge: BridgeStatus;
  /** ADMIN_PASSWORD_HASH is set: the panel password alone only views. */
  required: boolean;
  /** This browser holds an admin session (always true when not required). */
  unlocked: boolean;
  /** Idle timeout of an admin session, in ms. */
  idleMs: number;
  /** Discord notifications go out (a webhook from the environment or the panel, turned on); the URL never leaves the server. */
  notifyConfigured: boolean;
  /** A newer Skald release than this skald-web; null when none is known or the check is off. */
  update?: { version: string; url: string } | null;
}

/** A connected player as the agent serves it: never a platform or peer id. */
export interface LivePlayer {
  name: string;
  platform: Platform;
  x: number;
  z: number;
  health: number | null;
  maxHealth: number | null;
}

/** A ban list entry by opaque id; the platform id stays in the agent. */
export interface BanEntry {
  id: string;
  platform: Platform;
  name?: string;
}

/** GET /api/admin/catalog: what can be named in commands, cached for a minute. */
export interface AdminCatalog {
  /** Random events (raids) the world can start. */
  events: string[];
  /** The one running, if any. */
  currentEvent: { name: string; elapsed: number; duration: number } | null;
  globalKeys: string[];
  /** Teleport spot aliases (spawn, eikthyr, haldor, ...). */
  spots: string[];
  /** What the fill commands can put where, read from the game (bridge 0.3.0+; empty before). */
  stations: FillStations;
}

/** Agent GET /bridge/stations: kilns, smelters and fermenters with the items each one takes, in the game's order. */
export interface FillStations {
  kilns: { prefab: string; inputs: string[] }[];
  smelters: { prefab: string; fuel: string | null; inputs: string[] }[];
  /** Mead bases each fermenter takes (bridge 0.4.0+; empty before). */
  fermenters: { prefab: string; inputs: string[] }[];
}

/** One admin command's outcome as the panel gets it. */
export interface AdminResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** Seconds to wait, with a 429 (`busy`, `rate_limited`). */
  retryAfter?: number;
}

// ---- admin: access lists and world restore (agent files, no bridge needed) ---

/** The game's two list files. */
export const ACCESS_LISTS = ["admins", "bans"] as const;
export type AccessListName = (typeof ACCESS_LISTS)[number];
export const ACCESS_OPS = ["add", "remove"] as const;
export type AccessOp = (typeof ACCESS_OPS)[number];

/**
 * One list entry. `id` is the raw platform id: only ever served to an admin
 * session (GET /api/admin/access), never in events or /api/state.
 */
export interface AccessEntry {
  id: string;
  platform: Platform;
  name?: string;
  /** False for a line in a format the agent does not recognise. */
  known: boolean;
}

export interface AccessList {
  entries: AccessEntry[];
  /** A change applies to the running game at once (bans through the bridge). */
  live: boolean;
}

/** A player at the fire, as the lists see them: never an id. */
export interface AccessOnline {
  name: string;
  platform: Platform;
  admin: boolean;
  banned: boolean;
  /** The agent knows this player's platform id: one tap adds them. */
  canAdd: boolean;
}

/** GET /api/admin/access. */
export interface AccessState {
  /** The agent may write the config volume. */
  writable: boolean;
  running: boolean;
  admins: AccessList;
  bans: AccessList;
  online: AccessOnline[];
}

/** When a list change takes effect: now (bridge), at the next restart, or at the next start. */
export type AccessApplies = "now" | "restart" | "start";

export type RestoreSource = "image" | "skald";

/** Pre-restore copies Skald writes before replacing the world. */
export const SKALD_BACKUP_NAME = /^pre-restore-\d{8}-\d{6}\.zip$/;

export interface RestoreBackup {
  name: string;
  source: RestoreSource;
  sizeBytes: number;
  modifiedAt: string;
}

/** GET /api/admin/restore. */
export interface RestoreInfo {
  world: string;
  /** Why a restore cannot run at all; absent when it can. */
  reason?: "noworld" | "readonly";
  /** A restore is running now. */
  running: boolean;
  playersOnline: boolean;
  backups: RestoreBackup[];
}

/** Steps of a restore, as `admin` events with command "restore". */
export type RestoreStep = "begin" | "safety" | "stop" | "extract" | "start" | "done" | "rollback";
