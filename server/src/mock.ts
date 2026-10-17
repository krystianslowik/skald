import { VERSION } from "./buildinfo";
import { BRIDGE_PLUGIN_VERSION } from "./bridgeplugin";
import type { ActionResponse, AgentAsset, AgentSource, BridgeRequest, MapSourceResult, PiecesBox, Proxied, TerrainTileRef, ToolsRequest } from "./agent";
import { mockMap } from "./mapmock";
import { mockNature, natureIn } from "./mocknature";
import { mockPieces, piecesIn } from "./mockpieces";
import { mockIcons, type MockIcons } from "./mockicons";
import { MOCK_TERRAIN_RADIUS, MOCK_TILE_BUILD, mockTerrain, mockTerrainTile, mockTilesDoc, packHeights } from "./mockterrain";
import { addDays, calendar } from "./profiles";
import { buildArgs, changedKeys, normalize, parseArgs, validateSettings } from "./settings";
import type {
  ActionName,
  AgentEvent,
  AgentEventType,
  AgentState,
  ApplyMode,
  BridgeStatus,
  FillStations,
  LogLine,
  MapItem,
  MapSnapshot,
  Metrics,
  Platform,
  RestoreInfo,
  RestoreStep,
  SeriesPoint,
  SettingsCurrent,
  SettingsInput,
  SettingsRequest,
  SettingsView,
} from "./types";
import { ADMIN_COMMANDS } from "./types";

/**
 * Fake agent for `MOCK_AGENT=1`: a living server with a week of seeded history,
 * players drifting in and out, deaths, saves, chatty logs, and working actions.
 * Development only; never wired in when MOCK_AGENT is unset.
 */

const NAMES = ["Ragnar", "Freya", "Bjorn", "Astrid"];
/** Each warrior's platform. PlayStation and Switch prefixes are not confirmed on a real server yet. */
const PLATFORM: Record<string, { platform: Platform; prefix: string }> = {
  Ragnar: { platform: "xbox", prefix: "Xbox" },
  Freya: { platform: "steam", prefix: "Steam" },
  Bjorn: { platform: "playstation", prefix: "PlayStation" },
  Astrid: { platform: "nintendo", prefix: "Nintendo" },
};
const platformOf = (name: string): Platform => PLATFORM[name]?.platform ?? "unknown";
const MIN = 60_000;
const HOUR = 60 * MIN;
/** The real agent waits 60 s of an empty server; the mock waits a few seconds so the flow can be watched. */
const MOCK_EMPTY_MS = 6_000;

/** Where the mock's players roam: the mock map's bases and a few landmarks. */
const HAUNTS: [number, number][] = [
  [220, -340],
  [260, -300],
  [330, 140],
  [-860, 420],
  [-1460, 980],
  [0, 0],
  [1580, 1720],
];
const SPOTS: Record<string, [number, number]> = {
  spawn: [0, 0],
  eikthyr: [330, 140],
  elder: [-1180, 760],
  bonemass: [-2100, 1500],
  moder: [2400, 2900],
  yagluth: [-3900, -3100],
  queen: [4100, -2600],
  fader: [-5200, 4400],
  haldor: [-860, 420],
  hildir: [1900, -1200],
  bogwitch: [-2600, 2200],
};
const MOCK_EVENTS = ["army_bonemass", "army_eikthyr", "army_goblin", "army_moder", "army_theelder", "blobs", "bats", "foresttrolls", "skeletons", "surtlings", "wolves"];
/** The fill commands' stations, as the plugin reads them from the game's prefabs. */
const MOCK_STATIONS: FillStations = {
  kilns: [{ prefab: "charcoal_kiln", inputs: ["Wood", "FineWood", "RoundLog"] }],
  smelters: [
    { prefab: "smelter", fuel: "Coal", inputs: ["CopperOre", "TinOre", "IronScrap", "SilverOre"] },
    { prefab: "blastfurnace", fuel: "Coal", inputs: ["BlackMetalScrap", "FlametalOreNew"] },
  ],
  fermenters: [
    {
      prefab: "fermenter",
      inputs: ["MeadBaseTasty", "MeadBaseHealthMinor", "MeadBaseStaminaMinor", "MeadBasePoisonResist", "MeadBaseFrostResist", "MeadBaseHealthMedium", "MeadBaseStaminaMedium", "MeadBaseEitrMinor"],
    },
  ],
};
/** What the mock's "plugin" says it was tested on. */
const MOCK_BUILD = "l-1.0.17";

// Fictional platform ids for the fake admin and ban lists.
const MOCK_ID = /^([XVSNA]_[0-9]{1,24}|(Xbox|Steam|PlayStation|Nintendo)_[0-9]{1,24}|7656119[0-9]{10})$/;
const MOCK_IDS_BY_NAME: Record<string, string> = {
  Ragnar: "Xbox_2533274900000001",
  Freya: "Steam_76561190000000002",
  Hrafn: "Steam_76561190000000005",
  Sigrun: "Xbox_2533274900000004",
};

/** One account's forms fold together, as in the agent: V_n = Steam_n, X_n = Xbox_n. */
function accessKey(id: string): string {
  const i = id.indexOf("_");
  if (i < 0) return /^7656119\d{10}$/.test(id) ? `steam:${id}` : id.toLowerCase();
  const pre = id.slice(0, i).toLowerCase();
  const num = id.slice(i + 1);
  if (pre === "v" || pre === "steam") return `steam:${num}`;
  if (pre === "x" || pre === "xbox") return `xbox:${num}`;
  return id.toLowerCase();
}

const MOCK_KNOWN_IDS: Record<string, string> = Object.fromEntries(Object.entries(MOCK_IDS_BY_NAME).map(([name, id]) => [accessKey(id), name]));

function idPlatform(id: string): Platform {
  const k = accessKey(id);
  return k.startsWith("steam:") ? "steam" : k.startsWith("xbox:") ? "xbox" : id.startsWith("S_") ? "playstation" : id.startsWith("N_") ? "nintendo" : "unknown";
}

function maskId(id: string): string {
  const i = id.indexOf("_");
  return `${i > 0 ? id.slice(0, i + 1) : ""}***${id.slice(i + 1).slice(-4)}`;
}

interface MockPos {
  x: number;
  z: number;
  tx: number;
  tz: number;
  health: number;
  maxHealth: number;
}

const NOISE = [
  "Dungeon loaded 0",
  "Found location of type Eikthyrnir",
  "Update PlayFab entity token",
  "RPC_ServerSyncedPlayerData from client",
  "Saving {n} zdos",
  "Loaded {n} portals",
  "Console: Spawned Greyling at (412, 31, -88)",
  "Checking for any blocked players in the historical player list...",
  "Lobby 00000000-0000-0000-0000-000000000001.r-20260101 for world 'Midgard' and network 00000000-0000-0000-0000-000000000002|REDACTED refreshed",
  "Connected portals {n}:{k} <-> {n}:{k}",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `MM/DD/YYYY HH:MM:SS: text`, the way Valheim prints its own lines. */
function valheimLine(at: number, text: string): string {
  const d = new Date(at);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}: ${text}`;
}

function newJoinCode(): string {
  return String(100000 + Math.floor(Math.random() * 900000));
}

/** A tiny but valid zip (one stored text file) standing in for a world backup. */
export function mockZip(name: string, at: Date): Uint8Array {
  const enc = new TextEncoder();
  const file = enc.encode("README.txt");
  const data = enc.encode(`Backup ${name}\nWorld "Midgard", generated by MOCK_AGENT.\n`);
  const crc = Bun.hash.crc32(data);
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  const date = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const localLen = 30 + file.length + data.length;
  const centralLen = 46 + file.length;
  const out = new Uint8Array(localLen + centralLen + 22);
  const v = new DataView(out.buffer);
  // local file header
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(10, time, true);
  v.setUint16(12, date, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, data.length, true);
  v.setUint32(22, data.length, true);
  v.setUint16(26, file.length, true);
  out.set(file, 30);
  out.set(data, 30 + file.length);
  // central directory
  const c = localLen;
  v.setUint32(c, 0x02014b50, true);
  v.setUint16(c + 4, 20, true);
  v.setUint16(c + 6, 20, true);
  v.setUint16(c + 12, time, true);
  v.setUint16(c + 14, date, true);
  v.setUint32(c + 16, crc, true);
  v.setUint32(c + 20, data.length, true);
  v.setUint32(c + 24, data.length, true);
  v.setUint16(c + 28, file.length, true);
  out.set(file, c + 46);
  // end of central directory
  const e = c + centralLen;
  v.setUint32(e, 0x06054b50, true);
  v.setUint16(e + 8, 1, true);
  v.setUint16(e + 10, 1, true);
  v.setUint32(e + 12, centralLen, true);
  v.setUint32(e + 16, c, true);
  return out;
}

export class MockAgent implements AgentSource {
  private events: AgentEvent[] = [];
  private seq = 0;
  private subs = new Set<(e: AgentEvent) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private busy = false;
  private readonly startedAt = new Date().toISOString();
  private state: AgentState;
  // Server settings, as the agent keeps them in server.json.
  private settingsCur: SettingsCurrent;
  private serverPass = "hearth-77";
  private settingsUpdatedAt: string | null = null;
  private armedSince: string | null = null;
  private emptySince: number | null = null;
  private lastLeave = 0;
  /** Peer id per online name, for the abandoned-object lines on leave. */
  private uids = new Map<string, number>();
  private effective: SettingsView["effective"];
  /** World map: built once, re-stamped with the save generation. */
  private mapBase: MapSnapshot | null = null;
  private iconSet: MockIcons | null = null;
  private mapGeneration = 1;
  /** Chest contents changed by chest-add since the last save, by container id. */
  private chestLive = new Map<string, MapItem[]>();
  private piecesAll: ReturnType<typeof mockPieces> | null = null;
  private natureAll: ReturnType<typeof mockNature> | null = null;
  private tiles = new Map<string, Uint8Array>();
  // The fake bridge plugin.
  private pos = new Map<string, MockPos>();
  private bans: { id: string; platform: Platform; name?: string }[] = [{ id: "5e1d0c3b2a190807", platform: "steam", name: "Hrafn" }, { id: "0f9e8d7c6b5a4f3e", platform: "xbox" }];
  private event: { name: string; at: number; duration: number } | null = null;
  private frozen = false;
  private acked = false;
  private lastPositions = "";
  /** The positions lease, as on the agent (no expiry: the hub renews and ends it). */
  private watched = false;
  // The fake agent file tools.
  private access = { admins: ["V_76561190000000002", "X_1234500000000003"], bans: ["Steam_76561190000000005", "Xbox_2533274900000009"] };
  private skaldBackups: { name: string; sizeBytes: number; modifiedAt: string }[] = [];
  private restoring = false;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly timeZone = "UTC",
    /** How the fake bridge behaves: on, off (not installed), disabled (after a patch), untested (unknown build). */
    private readonly bridgeMode = "on",
  ) {
    const now = this.clock();
    this.state = {
      now: new Date(now).toISOString(),
      server: {
        name: "My Valheim",
        world: "Midgard",
        args: "-crossplay -modifier raids less -modifier deathpenalty casual",
        status: "running",
        // As the community image runs them: the game, its helpers, a one-shot
        // bootstrap that has already finished, and the container's plumbing.
        processes: { crond: "RUNNING", syslogd: "RUNNING", "valheim-bootstrap": "EXITED", "valheim-server": "RUNNING", "valheim-updater": "RUNNING", "valheim-backup": "RUNNING" },
        serverStartedAt: new Date(now - 3 * HOUR - 17 * MIN).toISOString(),
        version: "l-1.0.17",
        networkVersion: 40,
        joinCode: "482915",
        joinCodeAt: new Date(now - 3 * HOUR - 15 * MIN).toISOString(),
        playersReported: 2,
        playfab: "ok",
        netStats: null,
      },
      // Two warriors already at the fire when the dev server starts.
      players: [
        { name: "Ragnar", since: new Date(now - 72 * MIN).toISOString(), platform: "xbox" },
        { name: "Freya", since: new Date(now - 38 * MIN).toISOString(), platform: "steam" },
      ],
      world: {
        sizeBytes: 48_213_771,
        lastSaveAt: new Date(now - 11 * MIN).toISOString(),
        lastSaveMs: 87,
        meta: {
          name: "Midgard",
          seedName: "ZbzIWkK5KK",
          seed: 353373721,
          worldGenVersion: 2,
          netTime: 41 * 1800 + 734,
          day: 41,
          savedAt: new Date(now - 11 * MIN).toISOString(),
          // Created with resources much more and casual portals, which the
          // launch arguments leave out: the settings sheet notices.
          modifiers: { deathpenalty: "casual", portals: "casual", raids: "less", resources: "muchmore" },
          worldKeys: ["resourcerate 200", "teleportall"],
          knownPlayers: 4,
          globalKeys: ["activebosses 0", "defeated_eikthyr", "killedtroll", "defeated_gdking", "killed_surtling", "defeated_bonemass"],
          bosses: [
            { key: "defeated_eikthyr", defeated: true },
            { key: "defeated_gdking", defeated: true },
            { key: "defeated_bonemass", defeated: true },
            { key: "defeated_dragon", defeated: false },
            { key: "defeated_goblinking", defeated: false },
            { key: "defeated_queen", defeated: false },
            { key: "defeated_fader", defeated: false },
          ],
        },
      },
      backups: Array.from({ length: 6 }, (_, i) => {
        const at = now - (i + 1) * 6 * HOUR - 13 * MIN;
        const d = new Date(at);
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}00`;
        return { name: `worlds-${stamp}.zip`, sizeBytes: 41_000_000 - i * 1_350_000, modifiedAt: d.toISOString() };
      }),
      agent: { startedAt: this.startedAt, lastLogAt: null, version: VERSION },
      settings: { enabled: true, pending: false, armed: false, passwordSet: true },
    };
    this.settingsCur = { name: this.state.server.name, public: true, ...parseArgs(this.state.server.args) };
    this.effective = { name: this.state.server.name, public: true, args: this.state.server.args };
    this.seedHistory(now);
  }

  start(): void {
    const at = (ms: number, fn: () => void) => this.timers.push(setTimeout(fn, ms));
    at(400, () => this.log("Valheim version: l-1.0.17 (network version 40)"));
    at(600, () => this.emit("version", { version: "l-1.0.17", networkVersion: 40 }));
    at(900, () => this.log(`Session "My Valheim" with join code ${this.state.server.joinCode} and IP 203.0.113.10:2456 is active with 2 player(s)`));
    at(4000, () => this.join("Bjorn"));
    at(9000, () => this.join("Astrid"));
    at(16000, () => this.death("Freya"));
    at(22000, () => this.raid("army_eikthyr"));
    at(45000, () => this.leave("Astrid"));
    this.loop(2200, () => this.noise());
    this.loop(10000, () => this.netStats());
    this.loop(60000, () => this.save());
    this.loop(14000, () => this.drift());
    this.loop(1000, () => this.watchEmpty());
    // Live positions every 2 s, like the agent's poll; the walk is stepped every half second.
    const walk = setInterval(() => this.walk(0.5), 500);
    const sample = setInterval(() => this.samplePositions(), 2000);
    this.timers.push(walk as unknown as ReturnType<typeof setTimeout>, sample as unknown as ReturnType<typeof setTimeout>);
  }

  stop(): void {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
  }

  async getState(): Promise<AgentState> {
    const now = this.clock();
    const st = structuredClone({ ...this.state, now: new Date(now).toISOString() });
    const meta = st.world.meta;
    if (meta) {
      // The world only moves with someone on it; between saves it is extrapolated, as the agent does.
      const advancing = st.players.length > 0;
      const from = Math.max(Date.parse(meta.savedAt), ...st.players.map((p) => Date.parse(p.since)));
      const netTime = meta.netTime + (advancing ? Math.max(0, Math.min(7200, (now - from) / 1000)) : 0);
      const dayFraction = Math.round(((netTime % 1800) / 1800) * 1000) / 1000;
      st.world.clock = { netTime, day: Math.floor(netTime / 1800), dayFraction, daylight: dayFraction >= 0.25 && dayFraction < 0.75, advancing, rate: advancing ? 1 : 0 };
    }
    const icons = this.icons();
    st.icons = { available: true, build: icons.build, count: Object.keys(JSON.parse(icons.map).items).length };
    st.terrain = {
      enabled: true,
      available: true,
      stale: false,
      build: "mock-terrain-1",
      resolution: 1024,
      radius: MOCK_TERRAIN_RADIUS,
      request: meta ? { seedName: meta.seedName, seedHash: meta.seed, worldGenVersion: meta.worldGenVersion, gameBuild: st.server.version } : null,
    };
    return st;
  }

  async map(etag: string | null): Promise<MapSourceResult> {
    const tag = `"mock-map-${this.mapGeneration}"`;
    if (etag === tag) return { status: 304, etag: tag, body: null };
    this.mapBase ??= mockMap({ now: this.clock() });
    const meta = this.state.world.meta;
    const body: MapSnapshot = {
      ...this.mapBase,
      meta: { ...this.mapBase.meta, generation: this.mapGeneration, netTime: meta?.netTime ?? 0, day: meta?.day ?? 0, savedAt: meta?.savedAt ?? this.mapBase.meta.savedAt },
    };
    return { status: 200, etag: tag, body };
  }

  /** Floor plans: the mock's bases, cut to the box like the agent does (gzip is the web tier's job). */
  async pieces(box: PiecesBox, etag: string | null): Promise<Response> {
    this.mapBase ??= mockMap({ now: this.clock() });
    this.piecesAll ??= mockPieces(this.mapBase.storage ?? []);
    // Like the agent's: what was built and the box, not the save generation.
    const tag = `"mock-pieces-${box.join(",")}"`;
    if (etag === tag) return new Response(null, { status: 304, headers: { ETag: tag } });
    return new Response(JSON.stringify(piecesIn(this.piecesAll, box, this.mapGeneration)), { headers: { ETag: tag, "Content-Type": "application/json" } });
  }

  /** Nature round the mock's bases, cut to the box like the agent does. */
  async nature(box: PiecesBox, spoilers: boolean, etag: string | null): Promise<Response> {
    this.natureAll ??= mockNature();
    // Like the agent's: the world's objects, the box and whether spoilers were asked for.
    const tag = `"mock-nature-${box.join(",")}-${spoilers ? 1 : 0}"`;
    if (etag === tag) return new Response(null, { status: 304, headers: { ETag: tag } });
    return new Response(JSON.stringify(natureIn(this.natureAll, box, this.mapGeneration, spoilers)), { headers: { ETag: tag, "Content-Type": "application/json" } });
  }

  /** A generated sheet for every item the mock map holds. */
  private icons(): MockIcons {
    this.mapBase ??= mockMap({ now: this.clock() });
    const names = [...(this.mapBase.storage ?? []).flatMap((c) => c.items), ...this.mapBase.tombstones.flatMap((t) => t.items ?? [])].map((i) => i.name);
    this.iconSet ??= mockIcons(names);
    return this.iconSet;
  }

  /** Tiles from the mock's noise, gzipped like the agent's, a few kept. */
  async terrainTile(t: TerrainTileRef, etag: string | null): Promise<Response> {
    if (t.v !== MOCK_TILE_BUILD) return new Response('{"ok":false}', { status: 404 });
    const tag = `"tt-${t.v}-${t.z}-${t.x}-${t.y}"`;
    if (etag === tag) return new Response(null, { status: 304, headers: { ETag: tag } });
    const key = `${t.z}/${t.x}/${t.y}`;
    let body = this.tiles.get(key);
    if (!body) {
      const raw = mockTerrainTile(t.z, t.x, t.y);
      if (!raw) return new Response('{"ok":false}', { status: 404 });
      body = Bun.gzipSync(packHeights(raw) as Uint8Array<ArrayBuffer>, { level: 9 });
      if (this.tiles.size > 256) this.tiles.delete(this.tiles.keys().next().value!);
      this.tiles.set(key, body);
    }
    // MOCK_TILE_DELAY_MS imitates the bridge sampling a tile, for the perf harness.
    const delay = Number(process.env.MOCK_TILE_DELAY_MS ?? 0);
    if (delay > 0) await Bun.sleep(delay);
    return new Response(body, { headers: { ETag: tag, "Content-Type": "application/octet-stream" } });
  }

  async asset(path: AgentAsset, etag: string | null): Promise<Response> {
    if (path === "terrain/tiles.json") {
      if (process.env.MOCK_TILES === "off") return new Response('{"ok":false}', { status: 404 });
      return new Response(mockTilesDoc(), { headers: { "Content-Type": "application/json" } });
    }
    if (path === "terrain.png" || path === "terrain.json") {
      const t = mockTerrain();
      const tag = `"t-${t.build}"`;
      if (path === "terrain.json") return new Response(t.json, { headers: { "Content-Type": "application/json" } });
      if (etag === tag) return new Response(null, { status: 304, headers: { ETag: tag } });
      return new Response(t.png, { headers: { ETag: tag, "Content-Type": "image/png" } });
    }
    const set = this.icons();
    const tag = `"${set.build}"`;
    if (etag === tag) return new Response(null, { status: 304, headers: { ETag: tag } });
    // The mock's sheet is a PNG under the same route: browsers go by Content-Type.
    if (path === "icons/map.json") return new Response(set.map, { headers: { ETag: tag, "Content-Type": "application/json" } });
    return new Response(set.sheet, { headers: { ETag: tag, "Content-Type": "image/png" } });
  }

  async getLogs(limit: number): Promise<LogLine[]> {
    return this.events
      .filter((e) => e.type === "log")
      .slice(-limit)
      .map((e) => ({ ts: e.ts, line: String(e.data.line) }));
  }

  async action(name: ActionName): Promise<ActionResponse> {
    if (this.busy) return { status: 409, body: { ok: false, message: "another action is in progress" } };
    this.busy = true;
    const done = (ms: number, fn: () => void) => this.timers.push(setTimeout(() => {
      fn();
      this.busy = false;
    }, ms));
    if (name === "backup") {
      this.log("valheim-backup: Backing up Valheim server worlds to /config/backups");
      done(3000, () => {
        const d = new Date(this.clock());
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        this.state.backups.unshift({ name: `worlds-${stamp}.zip`, sizeBytes: 41_650_000, modifiedAt: d.toISOString() });
        this.emit("action", { name, ok: true, message: "sent HUP to valheim-backup" });
      });
    } else if (name === "update") {
      this.log("valheim-updater: Checking for Valheim server updates");
      done(2500, () => {
        this.log("valheim-updater: Valheim server is already the latest version");
        this.emit("action", { name, ok: true, message: "sent HUP to valheim-updater" });
      });
    } else {
      this.restart(done);
    }
    return { status: 200, body: { ok: true, message: name === "restart" ? "restart started" : `sent HUP to valheim-${name === "backup" ? "backup" : "updater"}` } };
  }

  /** Stop, start, new join code; any saved settings take effect on the way. */
  private restart(done: (ms: number, fn: () => void) => void, mode?: ApplyMode): void {
    this.setStatus("stopping");
    this.timers.push(setTimeout(() => {
      for (const p of [...this.state.players]) this.leave(p.name);
      this.setStatus("stopped");
    }, 1500));
    this.timers.push(setTimeout(() => {
      this.setStatus("starting");
      if (this.settingsUpdatedAt) this.log("INFO - Skald settings applied");
    }, 3500));
    done(6500, () => {
      this.state.server.serverStartedAt = new Date(this.clock()).toISOString();
      const applied = this.state.settings?.pending ?? false;
      if (applied) {
        this.effective = { name: this.settingsCur.name, public: this.settingsCur.public, args: buildArgs(this.settingsCur) };
        this.state.server.name = this.effective.name;
        this.state.server.args = this.effective.args;
        this.state.settings = { ...this.state.settings!, pending: false };
      }
      this.bootComplete(newJoinCode());
      this.emit("action", { name: "restart", ok: true, message: "restart complete" });
      if (mode) this.emit("settings_apply", { state: "applied", mode });
      else if (applied && this.armedSince) {
        // Applied by the restart rune while an apply-when-empty waited.
        this.disarm();
        this.emit("settings_apply", { state: "applied", mode: "when_empty" });
      }
    });
  }

  async settings(req: SettingsRequest): Promise<Proxied> {
    switch (req.op) {
      case "get":
        return { status: 200, body: this.settingsView() };
      case "password":
        return { status: 200, body: { password: this.serverPass } };
      case "put":
        return this.putSettings(req.body);
      case "apply":
        return this.applySettings(req.mode);
      case "cancel":
        if (this.armedSince) {
          this.disarm();
          this.emit("settings_apply", { state: "cancelled", mode: "when_empty" });
        }
        return { status: 200, body: this.settingsView() };
    }
  }

  private settingsView(): SettingsView {
    return {
      current: structuredClone(this.settingsCur),
      pending: this.state.settings?.pending ?? false,
      effective: { ...this.effective },
      password: { set: true },
      apply: { armed: this.armedSince !== null, since: this.armedSince },
      hook: this.settingsUpdatedAt && !this.state.settings?.pending ? "ok" : "unknown",
      updatedAt: this.settingsUpdatedAt,
    };
  }

  private putSettings(raw: unknown): Proxied {
    const b = raw as Partial<SettingsInput>;
    if (typeof b.name !== "string" || typeof b.public !== "boolean" || (b.password !== undefined && typeof b.password !== "string")) {
      return { status: 400, body: { ok: false, message: "bad request body" } };
    }
    const input: SettingsInput = {
      name: b.name,
      password: b.password,
      public: b.public,
      preset: typeof b.preset === "string" ? b.preset : "normal",
      modifiers: b.modifiers && typeof b.modifiers === "object" ? b.modifiers : {},
      keys: Array.isArray(b.keys) ? b.keys.map(String) : [],
      saveInterval: Number(b.saveInterval) || 0,
    };
    const errors = validateSettings(this.settingsCur, this.serverPass, input);
    if (Object.keys(errors).length > 0) return { status: 400, body: { ok: false, message: "invalid settings", errors } };
    const next = normalize(input, this.settingsCur.unmanaged);
    const pwChanged = input.password !== undefined && input.password !== this.serverPass;
    const changed = changedKeys(this.settingsCur, next, pwChanged);
    if (changed.length > 0) {
      this.settingsCur = next;
      if (pwChanged) this.serverPass = input.password!;
      this.settingsUpdatedAt = new Date(this.clock()).toISOString();
      this.state.settings = { ...this.state.settings!, pending: true };
      this.emit("settings_changed", { changedKeys: changed });
    }
    return { status: 200, body: this.settingsView() };
  }

  private applySettings(mode: ApplyMode): Proxied {
    if (mode === "now") {
      if (this.busy) return { status: 409, body: { ok: false, message: "another action is in progress" } };
      this.disarm();
      this.fireApply("now");
      return { status: 200, body: { ok: true, message: "restart started" } };
    }
    if (!this.state.settings?.pending) return { status: 409, body: { ok: false, message: "nothing to apply" } };
    if (!this.armedSince) {
      this.armedSince = new Date(this.clock()).toISOString();
      this.state.settings = { ...this.state.settings, armed: true };
      this.emit("settings_apply", { state: "armed", mode: "when_empty", since: this.armedSince });
      this.lastLeave = this.clock();
    }
    return { status: 200, body: this.settingsView() };
  }

  private fireApply(mode: ApplyMode): void {
    this.busy = true;
    this.emit("settings_apply", { state: "applying", mode });
    this.emit("action", { name: "restart", ok: true, message: "restart started" });
    this.restart((ms, fn) => this.timers.push(setTimeout(() => {
      fn();
      this.busy = false;
    }, ms)), mode);
  }

  private disarm(): void {
    this.armedSince = null;
    this.emptySince = null;
    if (this.state.settings) this.state.settings = { ...this.state.settings, armed: false };
  }

  /** The agent's apply-when-empty watcher, on a short mock window. */
  private watchEmpty(): void {
    if (!this.armedSince) return;
    const now = this.clock();
    if (this.state.server.status !== "running" || this.state.players.length > 0) {
      this.emptySince = null;
      // The evening winds down while it waits: someone walks off every few seconds.
      if (this.state.players.length > 0 && now - this.lastLeave >= 2500) {
        this.lastLeave = now;
        this.leave(this.state.players[0]!.name);
      }
      return;
    }
    this.emptySince ??= now;
    if (now - this.emptySince < MOCK_EMPTY_MS || this.busy) return;
    this.disarm();
    this.fireApply("when_empty");
  }

  // ---- the fake bridge ------------------------------------------------------

  async bridge(req: BridgeRequest): Promise<Proxied> {
    const ok = (data: unknown): Proxied => ({ status: 200, body: { ok: true, data } });
    const fail = (status: number, error: string): Proxied => ({ status, body: { ok: false, error } });
    if (this.bridgeMode === "off") return { status: 404, body: { ok: false, message: "not found" } };
    if (req.op === "status") return { status: 200, body: this.bridgeStatus() };
    if (this.bridgeMode === "disabled") return fail(503, "bridge disabled: game API binding failed (ZNet.Kick), game build l-1.0.18");
    if (this.state.server.status !== "running") return fail(502, "bridge unavailable");
    switch (req.op) {
      case "players":
        return ok({ players: this.livePlayers().map((p) => ({ ...p, y: 34, hasCharacter: true })) });
      case "read":
        switch (req.name) {
          case "time": {
            const c = (await this.getState()).world.clock;
            return ok({ day: c?.day ?? 0, dayFraction: c?.dayFraction ?? 0, netTimeSeconds: c?.netTime ?? 0, dayLengthSeconds: 1800, timeSkipping: false });
          }
          case "events":
            this.expireEvent();
            return ok({
              current: this.event ? { name: this.event.name, position: { x: 220, y: 34, z: -340 }, elapsed: Math.round((this.clock() - this.event.at) / 1000), duration: this.event.duration } : null,
              available: MOCK_EVENTS,
            });
          case "globalkeys":
            return ok([...(this.state.world.meta?.globalKeys ?? [])].sort());
          case "locations":
            return ok({ aliases: Object.keys(SPOTS), locations: ["Eikthyrnir", "GDKing", "Vendor_BlackForest", "StartTemple"] });
          case "bans":
            return ok(this.bans);
          case "stations":
            return ok(MOCK_STATIONS);
        }
        return fail(404, "unknown read");
      case "run":
        return this.runBridge(req.command, req.body, req.actor);
    }
  }

  private bridgeStatus(): BridgeStatus {
    const untested = this.bridgeMode === "untested";
    // The agent's allow-list, as GET /bridge/status lists it (ack-build is the agent's own).
    const base = { testedBuilds: [MOCK_BUILD], commands: ADMIN_COMMANDS.filter((c) => c !== "ack-build") as string[], timeFrozen: this.frozen };
    if (this.bridgeMode === "disabled") return { ...base, available: false, reason: "disabled" as const, message: "bridge disabled: game API binding failed (ZNet.Kick), game build l-1.0.18", worldLoaded: false, tested: false, acknowledged: false };
    if (this.state.server.status !== "running") return { ...base, available: false, reason: "restarting" as const, worldLoaded: false, tested: false, acknowledged: false };
    return { ...base, available: true, plugin: BRIDGE_PLUGIN_VERSION, gameBuild: untested ? "l-1.0.18" : MOCK_BUILD, worldLoaded: true, tested: !untested, acknowledged: untested && this.acked };
  }

  private livePlayers() {
    return this.state.players.map((p) => {
      const at = this.posOf(p.name);
      return { name: p.name, platform: p.platform ?? "unknown", x: Math.round(at.x * 10) / 10, z: Math.round(at.z * 10) / 10, health: Math.round(at.health), maxHealth: at.maxHealth };
    });
  }

  private posOf(name: string): MockPos {
    let p = this.pos.get(name);
    if (!p) {
      const [hx, hz] = HAUNTS[Math.floor(Math.random() * 2)]!;
      p = { x: hx + (Math.random() - 0.5) * 60, z: hz + (Math.random() - 0.5) * 60, tx: hx, tz: hz, health: 40 + Math.random() * 60, maxHealth: name === "Ragnar" ? 120 : 100 };
      this.pos.set(name, p);
    }
    return p;
  }

  /** Each player walks towards a target near a haunt, picks another on arrival. */
  private walk(dt: number): void {
    for (const pl of this.state.players) {
      const p = this.posOf(pl.name);
      const dx = p.tx - p.x;
      const dz = p.tz - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 3) {
        const [hx, hz] = Math.random() < 0.97 ? [p.x, p.z] : HAUNTS[Math.floor(Math.random() * HAUNTS.length)]!;
        // Wander, but drift back home when too far from any haunt.
        const home = HAUNTS[0]!;
        const far = Math.hypot(p.x - home[0], p.z - home[1]) > 400 && Math.random() < 0.2;
        p.tx = (far ? home[0] : hx) + (Math.random() - 0.5) * 120;
        p.tz = (far ? home[1] : hz) + (Math.random() - 0.5) * 120;
        continue;
      }
      // Walking pace, a run now and then; long trips go by "portal".
      if (d > 600) {
        p.x = p.tx + (Math.random() - 0.5) * 20;
        p.z = p.tz + (Math.random() - 0.5) * 20;
        continue;
      }
      const speed = (Math.random() < 0.3 ? 7 : 4) * dt;
      p.x += (dx / d) * Math.min(d, speed);
      p.z += (dz / d) * Math.min(d, speed);
      p.health = Math.min(p.maxHealth, Math.max(5, p.health + (Math.random() - 0.35) * 2));
    }
    for (const name of [...this.pos.keys()]) if (!this.state.players.some((p) => p.name === name)) this.pos.delete(name);
  }

  private samplePositions(): void {
    if (this.bridgeMode === "off" || this.bridgeMode === "disabled" || this.state.server.status !== "running") return;
    // Like the agent: nothing while nobody watches, and one empty list to clear the markers.
    const players = this.watched ? this.livePlayers() : [];
    const key = JSON.stringify(players);
    if (key === this.lastPositions || (this.lastPositions === "" && players.length === 0)) return;
    this.lastPositions = key;
    // Volatile, like the agent's: seq 0, not kept for replay.
    const ev: AgentEvent = { seq: 0, ts: new Date(this.clock()).toISOString(), type: "positions", data: { t: this.clock(), players } };
    for (const fn of this.subs) fn(ev);
  }

  private expireEvent(): void {
    if (this.event && this.clock() - this.event.at > this.event.duration * 1000) this.event = null;
  }

  /** One admin command: a plausible answer, the plugin's audit lines, and the agent's `admin` event. */
  private runBridge(command: string, body: Record<string, unknown>, actor: string): Proxied {
    const fail = (status: number, error: string): Proxied => {
      this.log(`[Info   :Skald Bridge] [SkaldBridge] audit actor=${actor} cmd=POST /v1/${command} result=error ${error}`);
      this.emit("admin", { ...summary, actor, command, result: "error", error });
      return { status, body: { ok: false, error } };
    };
    const summary = mockSummary(body);
    if (this.bridgeMode === "untested" && !this.acked && command !== "ack-build") {
      return { status: 409, body: { ok: false, error: "untested game build l-1.0.18: confirm it in the admin panel first" } };
    }
    if (command === "ack-build") {
      if (body.build !== "l-1.0.18" && body.build !== MOCK_BUILD) return { status: 409, body: { ok: false, error: `the server runs ${this.bridgeStatus().gameBuild}` } };
      this.acked = true;
      this.emit("admin", { actor, command, result: "ok", build: body.build });
      return { status: 200, body: { ok: true, data: { build: body.build } } };
    }
    this.log(`[Info   :Skald Bridge] [SkaldBridge] audit actor=${actor} cmd=POST /v1/${command} args=${JSON.stringify({ ...body, player: body.player ? "***" : undefined })}`);
    const online = (n: unknown) => typeof n === "string" && this.state.players.some((p) => p.name.toLowerCase() === n.toLowerCase());
    const nameOf = (n: unknown) => this.state.players.find((p) => p.name.toLowerCase() === String(n).toLowerCase())?.name ?? String(n);
    const refused = mockRefusal(process.env.MOCK_REFUSE, command, body, this.state.players[0]?.name);
    if (refused) return fail(refused.status, refused.error);
    for (const k of ["player", "toPlayer"]) {
      if (k in body && !online(body[k])) return fail(404, `no connected player '${String(body[k])}'`);
    }
    const target = body.player ? nameOf(body.player) : undefined;
    const near = target ?? "position";
    let data: Record<string, unknown>;
    switch (command) {
      case "broadcast":
        if (body.type === "chat") return fail(501, "not possible server-side: use center, topleft or narrator");
        if (typeof body.text !== "string" || !body.text.trim()) return fail(400, "missing 'text'");
        data = { sentTo: this.state.players.length, type: body.type ?? "center" };
        break;
      case "save":
        this.timers.push(setTimeout(() => this.save(), 800));
        data = { started: true };
        break;
      case "kick":
        if (!target) return fail(400, "missing 'player'");
        this.timers.push(setTimeout(() => this.leave(target), 600));
        data = { kicked: target };
        break;
      case "ban":
        if (!target) return fail(400, "missing 'player'");
        this.bans.push({ id: Math.random().toString(16).slice(2, 18).padEnd(16, "0"), platform: platformOf(target), name: target });
        this.timers.push(setTimeout(() => this.leave(target), 600));
        data = { name: target };
        break;
      case "unban": {
        const i = this.bans.findIndex((b) => b.id === body.id);
        if (i < 0) return fail(404, "not on the ban list (reload it)");
        this.bans.splice(i, 1);
        data = {};
        break;
      }
      case "time":
      case "skip-to-morning": {
        const meta = this.state.world.meta;
        if (!meta) return fail(503, "world not loaded yet");
        const frac = command === "time" ? Number(body.dayFraction) : 0.25;
        if (!(frac >= 0 && frac < 1)) return fail(400, "'dayFraction' must be in [0,1)");
        const now = meta.netTime % 1800;
        const add = frac * 1800 > now ? frac * 1800 - now : 1800 - now + frac * 1800;
        meta.netTime += add;
        meta.day = Math.floor(meta.netTime / 1800);
        meta.savedAt = new Date(this.clock()).toISOString();
        data = { day: meta.day, dayFraction: frac };
        break;
      }
      case "time-freeze":
      case "time-resume":
        this.frozen = command === "time-freeze";
        data = { frozen: this.frozen };
        break;
      case "event-start": {
        const name = String(body.name ?? "");
        if (!MOCK_EVENTS.includes(name)) return fail(404, `unknown event '${name}'`);
        this.event = { name, at: this.clock(), duration: 120 };
        this.timers.push(setTimeout(() => this.raid(name), 400));
        data = { started: name, near };
        break;
      }
      case "event-stop":
        this.expireEvent();
        if (!this.event) return fail(409, "no event is running");
        data = { stopped: this.event.name };
        this.event = null;
        break;
      case "spawn": {
        const lines = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [body];
        if (lines.length === 0 || lines.length > 20) return fail(400, "'items' must hold 1 to 20 entries");
        let stacks = 0;
        for (const l of lines) {
          if (typeof l.item !== "string" || !l.item) return fail(400, "missing 'item'");
          const amount = Number(l.amount ?? 1);
          if (!(amount >= 1 && amount <= 999)) return fail(400, "'amount' must be between 1 and 999");
          stacks += Math.ceil(amount / (/Wood|Stone|Resin|Coins/.test(l.item) ? 50 : 1));
        }
        if (stacks > 60) return fail(400, "too many stacks in one call (max 60)");
        data = { items: lines.map((l) => ({ item: l.item, amount: Number(l.amount ?? 1), quality: Number(l.quality ?? 1) })), stacks, near };
        break;
      }
      case "teleport": {
        if (!target) return fail(400, "missing 'player'");
        const p = this.posOf(target);
        let to: [number, number];
        let label: string;
        if (typeof body.toPlayer === "string") {
          const o = this.posOf(nameOf(body.toPlayer));
          to = [o.x + 2, o.z + 2];
          label = nameOf(body.toPlayer);
        } else if (typeof body.toSpot === "string") {
          const spot = SPOTS[body.toSpot.toLowerCase()];
          if (!spot) return fail(404, `unknown spot '${body.toSpot}'`);
          to = spot;
          label = body.toSpot;
        } else if (body.to && typeof body.to === "object") {
          const t = body.to as { x?: unknown; z?: unknown };
          to = [Number(t.x), Number(t.z)];
          if (!to.every(Number.isFinite) || Math.abs(to[0]) > 10500 || Math.abs(to[1]) > 10500) return fail(400, "'to' is outside the world");
          label = "position";
        } else return fail(400, "one of 'to', 'toPlayer', 'toSpot' is required");
        p.x = p.tx = to[0];
        p.z = p.tz = to[1];
        data = { player: target, to: { x: to[0], y: 34, z: to[1] }, label };
        break;
      }
      case "globalkey-set":
      case "globalkey-remove": {
        const key = String(body.key ?? "").toLowerCase();
        const meta = this.state.world.meta;
        if (!key || !meta) return fail(400, "missing 'key'");
        const keys = new Set(meta.globalKeys ?? []);
        if (command === "globalkey-set") keys.add(key);
        else keys.delete(key);
        meta.globalKeys = [...keys];
        if (meta.bosses) meta.bosses = meta.bosses.map((b) => ({ ...b, defeated: keys.has(b.key) }));
        data = [...keys].sort() as unknown as Record<string, unknown>;
        break;
      }
      case "creature-spawn": {
        const count = Number(body.count ?? 1);
        if (typeof body.prefab !== "string" || !body.prefab) return fail(400, "missing 'prefab'");
        if (!(count >= 1 && count <= 20)) return fail(400, "'count' must be between 1 and 20");
        data = { prefab: body.prefab, count, level: Number(body.level ?? 1), tamed: Boolean(body.tamed), boss: /Eikthyr|gd_king|Bonemass|Dragon|GoblinKing|SeekerQueen|Fader/.test(body.prefab), near };
        break;
      }
      case "creature-kill":
        data = { killed: Math.floor(Math.random() * 6), skippedTamedOrBoss: 0, unloaded: 0, near, radius: Number(body.radius ?? 30) };
        break;
      case "creature-tame":
        data = { tamed: Math.floor(Math.random() * 3), alreadyTamed: 0, unloaded: 0, near };
        break;
      case "heal": {
        if (!target) return fail(400, "missing 'player'");
        const p = this.posOf(target);
        p.health = p.maxHealth;
        data = { player: target, amount: p.maxHealth };
        break;
      }
      case "status":
        if (!target) return fail(400, "missing 'player'");
        data = { player: target, effect: body.effect ?? "Rested" };
        break;
      case "repair":
        data = { repaired: Math.floor(Math.random() * 12), unloaded: 0, near };
        break;
      case "fill":
        data = { smelters: 1 + Math.floor(Math.random() * 3), fermenters: Math.floor(Math.random() * 2), unloaded: 0, near };
        break;
      case "fill-kilns": {
        const kilns = 1 + Math.floor(Math.random() * 2);
        data = { kilns, full: 0, unloaded: 0, added: { [MOCK_STATIONS.kilns[0]!.inputs[0]!]: kilns }, near, radius: Number(body.radius ?? 20) };
        break;
      }
      case "fill-smelters": {
        // The plugin's rules (bridge/plugin/FillPlan.cs) on a base with a smelter
        // holding iron scrap, an empty one, and a blast furnace.
        const what = body.what ?? "both";
        if (what !== "ore" && what !== "both" && what !== "coal") return fail(400, "'what' must be ore, both or coal");
        const ore = what === "coal" ? null : typeof body.ore === "string" && body.ore ? body.ore : null;
        if (what !== "coal" && !ore) return fail(400, "missing 'ore'");
        if (ore && ore !== "current" && !MOCK_STATIONS.smelters.some((s) => s.inputs.includes(ore))) return fail(400, `no smelter takes '${ore}'; GET /v1/build/stations lists what each one takes`);
        const base = [
          { station: MOCK_STATIONS.smelters[0]!, queued: "IronScrap" },
          { station: MOCK_STATIONS.smelters[0]!, queued: "" },
          { station: MOCK_STATIONS.smelters[1]!, queued: "" },
        ];
        const added: Record<string, number> = {};
        let smelters = 0;
        let skipped = 0;
        for (const { station, queued } of base) {
          const pick = ore === "current" ? queued : ore;
          // Holding no ore to keep: coal only, if coal was asked for.
          if (ore === "current" && !pick && what === "both") {
            smelters++;
            continue;
          }
          if (ore && (!pick || !station.inputs.includes(pick))) {
            skipped++;
            continue;
          }
          if (pick) added[pick] = (added[pick] ?? 0) + 1;
          smelters++;
        }
        data = { smelters, skipped, full: 0, unloaded: 0, added, ...(what !== "ore" && smelters > 0 ? { fuel: "Coal" } : {}), near, radius: Number(body.radius ?? 20) };
        break;
      }
      case "fill-fermenters": {
        // The plugin's rule (FillPlan.Fermenter) on a base with three
        // fermenters, one of them still fermenting.
        const mead = typeof body.base === "string" ? body.base : "";
        if (!mead) return fail(400, "missing 'base'");
        if (!MOCK_STATIONS.fermenters.some((s) => s.inputs.includes(mead))) return fail(400, `no fermenter takes '${mead}'; GET /v1/build/stations lists what each one takes`);
        data = { fermenters: 2, skipped: 0, full: 1, unloaded: 0, added: { [mead]: 2 }, near, radius: Number(body.radius ?? 20) };
        break;
      }
      case "chest-add": {
        const added = this.chestAdd(body);
        if ("error" in added) return fail(added.status, added.error);
        data = added.data;
        break;
      }
      case "grow":
        data = { plants: Math.floor(Math.random() * 30), near };
        break;
      case "map-reveal":
      case "map-pins":
        data = { tables: Array.from({ length: 1 + Math.floor(Math.random() * 2) }, () => ({})), near };
        break;
      default:
        return fail(404, `unknown command ${command}`);
    }
    this.log(`[Info   :Skald Bridge] [SkaldBridge] audit actor=${actor} cmd=POST /v1/${command} result=ok ${JSON.stringify({ ok: true, data })}`);
    const counts: Record<string, unknown> = {};
    if (!Array.isArray(data)) {
      for (const k of ["killed", "tamed", "repaired", "smelters", "kilns", "skipped", "full", "fermenters", "plants", "sentTo", "stopped", "started", "label", "stacks", "day", "loaded"]) if (k in data) counts[k] = data[k];
      if (data.added && typeof data.added === "object") counts.added = data.added;
      if (typeof data.fuel === "string") counts.fuel = data.fuel;
      if (Array.isArray(data.tables)) counts.tables = data.tables.length;
      for (const k of ["near", "kicked", "player", "name"]) if (typeof data[k] === "string" && data[k] !== "position") counts.player = data[k];
    }
    this.emit("admin", { ...summary, ...counts, actor, command, result: "ok" });
    return { status: 200, body: { ok: true, data } };
  }

  // ---- the fake agent file tools: admin and ban lists, world restore ---------

  async tools(req: ToolsRequest): Promise<Proxied> {
    const ok = (data: unknown): Proxied => ({ status: 200, body: { ok: true, data } });
    const fail = (status: number, error: string): Proxied => ({ status, body: { ok: false, error } });
    const running = this.state.server.status === "running";
    const live = running && this.bridgeMode === "on";
    const nameOf = (id: string) => MOCK_KNOWN_IDS[accessKey(id)];
    const entries = (ids: string[]) => ids.map((id) => ({ id, platform: idPlatform(id), name: nameOf(id), known: MOCK_ID.test(id) }));
    switch (req.op) {
      case "access": {
        const on = (ids: string[], name: string) => ids.some((id) => nameOf(id) === name);
        return ok({
          writable: true,
          running,
          admins: { entries: entries(this.access.admins), live: false },
          bans: { entries: entries(this.access.bans), live },
          online: this.state.players.map((p) => ({ name: p.name, platform: p.platform ?? "unknown", admin: on(this.access.admins, p.name), banned: on(this.access.bans, p.name), canAdd: p.name in MOCK_IDS_BY_NAME })),
        });
      }
      case "access-change": {
        if (this.busy && !running) return fail(409, "the server is restarting");
        const list = this.access[req.list];
        const player = typeof req.body.player === "string" ? req.body.player : "";
        const id = player ? MOCK_IDS_BY_NAME[player] : String(req.body.id ?? "");
        if (!id) return fail(404, `no platform id known for ${player}`);
        if (req.change === "add") {
          if (!MOCK_ID.test(id)) return fail(400, "not a platform id: use the F2 form like X_1234 or V_7656..., or Xbox_/Steam_ followed by digits");
          if (list.some((x) => accessKey(x) === accessKey(id))) return fail(409, "already on the list");
          list.push(id);
        } else {
          const i = list.indexOf(id);
          if (i < 0) return fail(404, "not on the list");
          list.splice(i, 1);
        }
        const command = req.list === "admins" ? (req.change === "add" ? "admin-add" : "admin-remove") : req.change === "add" ? "ban" : "unban";
        const who = nameOf(id) ? { player: nameOf(id) } : { masked: maskId(id) };
        if (req.list === "bans" && live) {
          this.log(`[Info   :Skald Bridge] [SkaldBridge] audit actor=${req.actor} cmd=POST /v1/${command} result=ok`);
          this.emit("admin", { actor: req.actor, command, result: "ok", ...(nameOf(id) ? { player: nameOf(id) } : {}) });
          if (req.change === "add" && player) this.timers.push(setTimeout(() => this.leave(player), 600));
          return ok({ applies: "now" });
        }
        this.emit("admin", { actor: req.actor, command, result: "ok", via: "file", platform: idPlatform(id), ...who });
        return ok({ applies: running ? "restart" : "start" });
      }
      case "restore-info":
        return ok({
          world: this.state.server.world,
          running: this.restoring,
          playersOnline: this.state.players.length > 0,
          backups: [
            ...this.state.backups.map((b) => ({ ...b, source: "image" as const })),
            ...this.skaldBackups.map((b) => ({ ...b, source: "skald" as const })),
          ].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
        } satisfies RestoreInfo);
      case "restore":
        return this.restore(req.body, req.actor);
    }
  }

  /** A restore as the agent runs it: one `admin` event per step, the server down in the middle. */
  private restore(body: Record<string, unknown>, actor: string): Proxied {
    const fail = (status: number, error: string): Proxied => ({ status, body: { ok: false, error } });
    if (body.confirm !== this.state.server.world) return fail(400, "type the world name to confirm");
    const from = body.source === "skald" ? this.skaldBackups : this.state.backups;
    if (!from.some((b) => b.name === body.backup)) return fail(400, "no such backup");
    if (this.state.players.length > 0) return fail(409, "players are online");
    if (this.busy) return fail(409, "another action is in progress");
    this.busy = true;
    this.restoring = true;
    const step = (s: RestoreStep, extra: Record<string, unknown> = {}) => this.emit("admin", { actor, command: "restore", step: s, result: "ok", ...extra });
    const at = (ms: number, fn: () => void) => this.timers.push(setTimeout(fn, ms));
    const d = new Date(this.clock());
    const archive = `pre-restore-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.zip`;
    step("begin", { backup: body.backup });
    at(1200, () => {
      this.skaldBackups.unshift({ name: archive, sizeBytes: this.state.world.sizeBytes, modifiedAt: new Date(this.clock()).toISOString() });
      step("safety", { archive });
      this.setStatus("stopping");
    });
    at(2600, () => {
      this.setStatus("stopped");
      step("stop");
    });
    at(4200, () => {
      step("extract", { files: 1873 });
      this.setStatus("starting");
    });
    at(6500, () => {
      this.state.server.serverStartedAt = new Date(this.clock()).toISOString();
      this.bootComplete(newJoinCode());
      step("start");
      this.busy = false;
      this.restoring = false;
      step("done", { backup: body.backup, archive });
    });
    return { status: 202, body: { ok: true, data: { backup: body.backup } } };
  }

  async backup(name: string): Promise<Response> {
    const b = this.state.backups.find((x) => x.name === name);
    if (!b) return new Response("not found", { status: 404 });
    const zip = mockZip(name, new Date(b.modifiedAt));
    // Two chunks, pulled on demand, so the server's pass-through actually streams.
    const chunks = [zip.subarray(0, zip.length >> 1), zip.subarray(zip.length >> 1)];
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        const chunk = chunks.shift();
        if (chunk) ctrl.enqueue(chunk);
        else ctrl.close();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(zip.length),
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  }

  async watchPositions(on: boolean): Promise<void> {
    this.watched = on;
  }

  async stream(since: number, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    for (const e of this.events) if (e.seq > since) onEvent(e);
    this.subs.add(onEvent);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    this.subs.delete(onEvent);
  }

  // ---- scenario ------------------------------------------------------------

  private loop(ms: number, fn: () => void): void {
    const tick = () => {
      fn();
      this.timers.push(setTimeout(tick, ms * (0.6 + Math.random() * 0.8)));
    };
    this.timers.push(setTimeout(tick, ms));
  }

  private bootComplete(code = "482915"): void {
    this.state.server.joinCode = code;
    this.state.server.joinCodeAt = new Date(this.clock()).toISOString();
    this.state.server.playfab = "ok";
    this.log(`Session "${this.state.server.name}" registered with join code ${code}`);
    this.emit("playfab", { state: "ok" });
    this.emit("join_code", { code });
    this.setStatus("running");
    this.count();
    this.log(`Session "${this.state.server.name}" with join code ${code} and IP 203.0.113.10:2456 is active with ${this.state.players.length} player(s)`);
  }

  private setStatus(status: AgentState["server"]["status"]): void {
    this.state.server.status = status;
    this.emit("server_state", { status });
  }

  private count(line?: "joined" | "lost"): void {
    const n = this.state.players.length;
    this.state.server.playersReported = n;
    const { name, joinCode } = this.state.server;
    if (line === "joined") this.log(`Player joined server "${name}" that has join code ${joinCode}, now ${n} player(s)`);
    if (line === "lost") this.log(`Player connection lost server "${name}" that has join code ${joinCode}, now ${n} player(s)`);
    this.emit("player_count", { count: n });
  }

  private join(name: string): void {
    // Nobody new sits down while the server waits to empty for new settings.
    if (this.state.server.status !== "running" || this.armedSince || this.state.players.some((p) => p.name === name)) return;
    const platform = platformOf(name);
    const uid = 100_000_000 + Math.floor(Math.random() * 900_000_000);
    this.uids.set(name, uid);
    this.state.players.push({ name, since: new Date(this.clock()).toISOString(), platform });
    // The 1.0 crossplay sequence, as the agent serves it (ids redacted).
    this.log("PlayFab listen socket child connected to remote player ***");
    this.count("joined");
    this.log(`PlayFab socket with remote ID playfab/*** received local Platform ID ${PLATFORM[name]?.prefix ?? "Steam"}_***`);
    this.log("Got handshake from client playfab/***");
    this.log("Server: New peer connected,sending global keys");
    this.log(`Got character ZDOID from ${name} : ${uid}:1`);
    this.emit("player_join", { name, platform });
  }

  private leave(name: string): void {
    if (!this.state.players.some((p) => p.name === name)) return;
    const uid = this.uids.get(name) ?? 1;
    this.uids.delete(name);
    this.state.players = this.state.players.filter((p) => p.name !== name);
    this.log("RPC_Disconnect");
    for (const k of [1, 2, 3]) this.log(`Destroying abandoned non persistent zdo ${uid}:${k} owner ${uid}`);
    this.emit("player_leave", { name });
    this.count("lost");
  }

  private death(name: string): void {
    if (!this.state.players.some((p) => p.name === name)) return;
    this.log(`Got character ZDOID from ${name} : 0:0`);
    this.emit("death", { name });
    // The respawn: a new character ZDOID with the same peer id, not a join.
    this.timers.push(setTimeout(() => {
      const uid = this.uids.get(name);
      if (uid) this.log(`Got character ZDOID from ${name} : ${uid}:${2 + Math.floor(Math.random() * 20000)}`);
    }, 8000));
  }

  /**
   * POST /v1/containers/add, by the plugin's rules (bridge/plugin/Chests.cs and
   * ChestPlan.cs): the chest by prefab and position, stacks of the item topped
   * up first, then empty slots. The map keeps showing the last save until the
   * next one, which takes the chest's live contents along.
   */
  private chestAdd(body: Record<string, unknown>): { data: Record<string, unknown> } | { status: number; error: string } {
    const prefab = typeof body.prefab === "string" ? body.prefab : "";
    const item = typeof body.item === "string" ? body.item : "";
    const at = body.at as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    const amount = Number(body.amount);
    if (!prefab || !item) return { status: 400, error: "missing 'prefab' or 'item'" };
    if (!at || typeof at !== "object" || ![at.x, at.y, at.z].every((v) => Number.isFinite(Number(v)))) return { status: 400, error: "missing 'at': {x, y, z} of the chest" };
    if (!Number.isInteger(amount) || amount < 1 || amount > 9999) return { status: 400, error: "'amount' must be between 1 and 9999" };
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(item)) return { status: 404, error: `unknown item prefab '${item}' (use the prefab name, e.g. Wood, Iron)` };
    this.mapBase ??= mockMap({ now: this.clock() });
    const chest = (this.mapBase.storage ?? []).find((c) => c.prefab === prefab && Math.hypot(c.x - Number(at.x), (c.y ?? 0) - Number(at.y), c.z - Number(at.z)) <= 0.5);
    if (!chest) return { status: 404, error: `no such chest at ${Math.round(Number(at.x))}, ${Math.round(Number(at.z))} any more: it was moved or destroyed after the last save` };
    if (chest.kind !== "chest") return { status: 400, error: "only chests can take items this way, not carts, ships or graves" };
    const items = (this.chestLive.get(chest.id) ?? chest.items).map((i) => ({ ...i }));
    const max = mockStackSize(item);
    const height = Math.max(chest.height, ...items.map((i) => i.y + 1));
    const used = new Set(items.filter((i) => i.x < chest.width).map((i) => `${i.x},${i.y}`));
    const same = items.filter((i) => i.name === item && (i.quality ?? 1) === 1 && i.stack < max);
    const room = same.reduce((n, i) => n + max - i.stack, 0) + (chest.width * height - used.size) * max;
    if (room < amount) return { status: 409, error: room === 0 ? `that chest has no room for ${item}` : `only ${room} ${item} fit in that chest` };
    const slots: { x: number; y: number; added: number; stack: number }[] = [];
    let left = amount;
    for (const i of same) {
      const n = Math.min(left, max - i.stack);
      if (n <= 0) continue;
      i.stack += n;
      left -= n;
      slots.push({ x: i.x, y: i.y, added: n, stack: i.stack });
    }
    for (let y = 0; y < height && left > 0; y++) {
      for (let x = 0; x < chest.width && left > 0; x++) {
        if (used.has(`${x},${y}`)) continue;
        const n = Math.min(left, max);
        items.push({ name: item, stack: n, x, y });
        left -= n;
        slots.push({ x, y, added: n, stack: n });
      }
    }
    this.chestLive.set(chest.id, items);
    slots.sort((a, b) => a.y - b.y || a.x - b.x);
    return { data: { prefab, item, amount, position: { x: chest.x, y: chest.y ?? 0, z: chest.z }, loaded: this.state.players.length > 0, room: room - amount, slots } };
  }

  private save(): void {
    // Chests filled since the last save show their new contents from now on.
    if (this.mapBase && this.chestLive.size > 0) {
      for (const c of this.mapBase.storage ?? []) {
        const live = this.chestLive.get(c.id);
        if (live) c.items = live;
      }
      this.chestLive.clear();
    }
    const ms = Math.round(40 + Math.random() * 160);
    this.state.world.lastSaveAt = new Date(this.clock()).toISOString();
    this.state.world.lastSaveMs = ms;
    this.state.world.sizeBytes += Math.round(Math.random() * 40_000);
    const meta = this.state.world.meta;
    if (meta) {
      meta.netTime += 60 + Math.random() * 30;
      meta.day = Math.floor(meta.netTime / 1800);
      meta.savedAt = this.state.world.lastSaveAt;
    }
    this.mapGeneration++;
    // The game's own autobackup rides along with some saves.
    if (Math.random() < 0.25) {
      const bms = Math.round(20 + Math.random() * 40);
      this.log(`World auto backup saved [${bms}ms]`);
      this.emit("world_backup", { ms: bms });
    }
    this.log(`World save (5/5) done. Total time [${ms}ms]`);
    this.emit("world_saved", { ms });
  }

  private raid(name: string): void {
    if (this.state.server.status !== "running") return;
    this.log(`Random event set:${name}`);
    this.emit("raid", { name });
  }

  /** The periodic "Connections" line; the agent emits net_stats only when zdos/connections move. */
  private netStats(): void {
    if (this.state.server.status !== "running") return;
    const prev = this.state.server.netStats;
    const ns = {
      connections: this.state.players.length,
      zdos: (prev?.zdos ?? 131_000) + Math.floor(Math.random() * 60),
      sent: Math.floor(Math.random() * 80),
      recv: Math.floor(Math.random() * 400),
    };
    this.state.server.netStats = ns;
    this.log(` Connections ${ns.connections} ZDOS:${ns.zdos}  sent:${ns.sent} recv:${ns.recv}`);
    this.emit("net_stats", ns);
  }

  private drift(): void {
    if (this.state.server.status !== "running") return;
    const online = this.state.players.map((p) => p.name);
    const r = Math.random();
    if (r < 0.3 && online.length > 0) this.death(online[Math.floor(Math.random() * online.length)]!);
    else if (r < 0.6 && online.length < NAMES.length) {
      const offline = NAMES.filter((n) => !online.includes(n));
      this.join(offline[Math.floor(Math.random() * offline.length)]!);
    } else if (online.length > 1) this.leave(online[Math.floor(Math.random() * online.length)]!);
  }

  private noise(): void {
    const tpl = NOISE[Math.floor(Math.random() * NOISE.length)]!;
    this.log(tpl.replaceAll("{n}", String(Math.floor(Math.random() * 90000))).replaceAll("{k}", String(Math.floor(Math.random() * 400))));
  }

  // ---- event plumbing ------------------------------------------------------

  private log(text: string, at = this.clock()): void {
    this.state.agent.lastLogAt = new Date(at).toISOString();
    this.emit("log", { line: valheimLine(at, text) }, at);
  }

  private emit(type: AgentEventType, data: Record<string, unknown>, at = this.clock()): void {
    const ev: AgentEvent = { seq: ++this.seq, ts: new Date(at).toISOString(), type, data };
    this.events.push(ev);
    if (this.events.length > 5000) this.events.shift();
    for (const fn of this.subs) fn(ev);
  }

  /**
   * A month of evenings on local wall-clock days (the configured zone), replayed to the hub on its
   * first `since=0`. Placed by calendar day (not `now - k * 24 h`) so streaks
   * and badges do not depend on the time of day the dev server starts:
   * Ragnar plays the last 9 evenings (streak_7) and has a 5.5 h death-free
   * marathon with a raid in it (unbroken, raid_veteran); Bjorn pulls an
   * all-nighter (night_owl).
   */
  private seedHistory(now: number): void {
    let rnd = 7;
    const rand = () => {
      rnd = (rnd * 16807) % 2147483647;
      return rnd / 2147483647;
    };
    const cal = calendar(this.timeZone);
    const today = cal.day(now);
    const at = (k: number, h: number, m = 0) => cal.time(addDays(today, -k), h, m);
    type Span = { name: string; from: number; to: number; deaths: number };
    const spans: Span[] = [];
    for (let k = 30; k >= 1; k--) {
      for (const name of NAMES) {
        if (name === "Ragnar" && k === 3) {
          spans.push({ name, from: at(3, 17, 0), to: at(3, 22, 35), deaths: 0 });
          continue;
        }
        if (name === "Bjorn" && k === 5) continue; // the all-nighter below replaces it
        if (!(name === "Ragnar" && k <= 9) && rand() < 0.5) continue;
        const from = at(k, 18, 30) + rand() * 150 * MIN;
        const to = from + (30 + rand() * 140) * MIN;
        spans.push({ name, from, to, deaths: Math.floor(rand() * (name === "Freya" ? 4 : 3)) });
      }
    }
    spans.push({ name: "Bjorn", from: at(5, 23, 10), to: at(4, 4, 25), deaths: 1 });
    const raw: { at: number; type: AgentEventType; data: Record<string, unknown> }[] = [];
    for (const s of spans) {
      raw.push({ at: s.from, type: "player_join", data: { name: s.name, platform: platformOf(s.name) } });
      raw.push({ at: s.to, type: "player_leave", data: { name: s.name } });
      for (let i = 0; i < s.deaths; i++) raw.push({ at: s.from + rand() * (s.to - s.from), type: "death", data: { name: s.name } });
    }
    const raids = ["army_eikthyr", "foresttrolls", "army_theelder", "wolves"];
    for (const [i, k] of [24, 17, 11, 6, 3, 1].entries()) {
      raw.push({ at: at(k, 20, 0) + rand() * 60 * MIN, type: "raid", data: { name: raids[i % raids.length]! } });
    }
    raw.push({ at: at(2, 12, 0), type: "server_state", data: { status: "stopped" } });
    raw.push({ at: at(2, 12, 0) + 40_000, type: "server_state", data: { status: "running" } });
    // The update that restart brought, after the version an earlier boot reported.
    raw.push({ at: at(6, 9, 0), type: "version", data: { version: "l-1.0.16", networkVersion: 39 } });
    raw.push({ at: at(2, 12, 0) + 50_000, type: "version", data: { version: "l-1.0.17", networkVersion: 40 } });
    // The game's own routine: a save every 30 min, a backup every 2 h, now and then a slow save.
    let n = 0;
    for (let t = now - 8 * 24 * HOUR - (now % (30 * MIN)); t < now; t += 30 * MIN, n++) {
      raw.push({ at: t, type: "world_saved", data: { ms: n % 97 === 50 ? Math.round(2100 + rand() * 900) : Math.round(40 + rand() * 160) } });
      if (n % 4 === 0) raw.push({ at: t + 2000, type: "world_backup", data: { ms: Math.round(20 + rand() * 40) } });
    }
    raw.sort((a, b) => a.at - b.at);
    const online = new Set<string>();
    for (const r of raw) {
      if (r.at > now - 3 * HOUR) continue;
      const name = String(r.data.name ?? "");
      if (r.type === "player_join") online.add(name);
      if (r.type === "player_leave") {
        if (!online.has(name)) continue;
        online.delete(name);
      }
      if (r.type === "server_state" && r.data.status !== "running") {
        for (const n of [...online]) this.emit("player_leave", { name: n }, r.at - 1);
        online.clear();
      }
      if (r.type === "death" && !online.has(name)) continue;
      this.emit(r.type, r.data, r.at);
      if (r.type === "player_join" || r.type === "player_leave") this.emit("player_count", { count: online.size }, r.at);
    }
    for (const n of online) this.emit("player_leave", { name: n }, now - 3 * HOUR);
    this.emit("player_count", { count: 0 }, now - 3 * HOUR);
    // Tonight's session, matching the players in the initial state.
    for (const [i, p] of this.state.players.entries()) {
      const at = Date.parse(p.since);
      this.emit("player_join", { name: p.name, platform: p.platform ?? "unknown" }, at);
      this.emit("player_count", { count: i + 1 }, at);
    }
  }
}

/** Stack sizes close enough for the mock, as the game has them (the plugin reads the real ones from the item prefab). */
function mockStackSize(item: string): number {
  if (/^(Arrow|Bolt|Missile)/.test(item) || /Nails$/.test(item)) return 100;
  if (/^(Mead|Cooked|Bread|Pie|Soup|Stew|Sausage|Fish)/.test(item)) return 10;
  if (/^(Sword|Axe|Pickaxe|Battleaxe|Bow|Crossbow|Knife|Mace|Sledge|Atgeir|Spear|Shield|Helmet|Armor|Cape|Club|Torch|Hammer|Hoe|Cultivator|Staff|Lantern|Trinket|Belt|Wishbone)/.test(item)) return 1;
  return 50;
}

/**
 * MOCK_REFUSE: the plugin's refusals that the fake world never runs into on its
 * own (bridge/plugin/Chests.cs, Commands.cs), word for word, to see how the
 * panel shows them. chest-open, chest-near, chest-two and chest-unsafe refuse
 * every chest-add; player-gone refuses any command aimed at a player;
 * world-loading refuses every command.
 */
export function mockRefusal(kind: string | undefined, command: string, body: Record<string, unknown>, someone = "Ragnar"): { status: number; error: string } | null {
  if (kind === "world-loading") return { status: 503, error: "world not loaded yet" };
  if (kind === "player-gone" && typeof body.player === "string") return { status: 404, error: `no connected player '${body.player}'` };
  if (command !== "chest-add") return null;
  switch (kind) {
    case "chest-open":
      return { status: 409, error: "a player has that chest open; try again once it is closed" };
    case "chest-near":
      return { status: 409, error: `${someone} is standing at that chest; try again once they step away` };
    case "chest-two":
      return { status: 409, error: "two chests sit on that spot; cannot tell which one is meant" };
    case "chest-unsafe":
      return { status: 409, error: "the new contents do not read back the same; chest left untouched" };
  }
  return null;
}

/** The agent's argument summary for an admin event: names, never ids. */
function mockSummary(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["type", "item", "amount", "quality", "prefab", "count", "level", "tamed", "includeBosses", "name", "key", "effect", "dayFraction", "toSpot", "radius", "what", "ore", "base", "player", "toPlayer"]) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  if (typeof body.text === "string") out.text = body.text.slice(0, 120);
  if (Array.isArray(body.items)) out.items = (body.items as Record<string, unknown>[]).slice(0, 20).map((l) => ({ item: l.item, amount: l.amount, quality: l.quality }));
  if (Array.isArray(body.pins)) out.pins = body.pins.length;
  for (const k of ["at", "to"]) {
    const v = body[k] as { x?: unknown; z?: unknown } | undefined;
    if (v && typeof v === "object") out[k] = { x: Math.round(Number(v.x)), z: Math.round(Number(v.z)) };
  }
  return out;
}

/** Synthetic 6 h of resource series for mock mode. */
export function mockMetrics(now = Date.now()): Metrics {
  const pts = (fn: (i: number, t: number) => number): SeriesPoint[] =>
    Array.from({ length: 360 }, (_, i) => {
      const t = now - (359 - i) * MIN;
      return [t, Math.max(0, fn(i, t))] as SeriesPoint;
    });
  const busy = (i: number) => (i > 300 ? 1 : i > 120 && i < 200 ? 0.6 : 0.1);
  return {
    cpu: pts((i) => 0.35 + busy(i) * 1.1 + Math.sin(i / 7) * 0.08 + Math.random() * 0.12),
    memory: pts((i) => 2.9e9 + i * 1.6e6 + busy(i) * 4e8 + Math.random() * 3e7),
    rx: pts((i) => 4_000 + busy(i) * 90_000 * (0.7 + Math.random() * 0.6)),
    tx: pts((i) => 9_000 + busy(i) * 160_000 * (0.7 + Math.random() * 0.6)),
  };
}
