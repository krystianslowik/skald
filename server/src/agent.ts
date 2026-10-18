import { SseParser } from "./sse";
import type { AccessListName, AccessOp, ActionName, ActionResult, AdminCommand, AdminRead, AgentEvent, AgentState, LogLine, MapSnapshot, SettingsRequest } from "./types";

export interface ActionResponse {
  status: number;
  body: ActionResult;
}

/** An agent answer passed through as is: status and JSON body. */
export interface Proxied {
  status: number;
  body: unknown;
}

/** Agent `GET /map`: 200 with a body, 304 when `etag` still matches, 404 off, 503 not built yet. */
export interface MapSourceResult {
  status: number;
  etag: string | null;
  body: MapSnapshot | null;
}

/** Files the agent serves as they are: the item icon sheet and its map, the terrain image and its facts. */
export type AgentAsset = "icons/map.json" | "icons/sheet.webp" | "terrain.png" | "terrain.json" | "terrain/tiles.json";

/** One terrain tile: level, column, row and the build from tiles.json. */
export interface TerrainTileRef {
  z: number;
  x: number;
  y: number;
  v: string;
}

/** A world-space box for floor plans: [x0, z0, x1, z1] in metres. */
export type PiecesBox = readonly [x0: number, z0: number, x1: number, z1: number];

/** One bridge call, proxied to the agent (or answered by the mock). */
export type BridgeRequest =
  | { op: "status" }
  | { op: "players" }
  | { op: "read"; name: AdminRead }
  | { op: "run"; command: AdminCommand; body: Record<string, unknown>; actor: string };

/** The admin and ban lists and the world restore: agent file tools, bridge or not. */
export type ToolsRequest =
  | { op: "access" }
  | { op: "access-change"; list: AccessListName; change: AccessOp; body: Record<string, unknown>; actor: string }
  | { op: "restore-info" }
  | { op: "restore"; body: Record<string, unknown>; actor: string }
  | { op: "compat-run"; actor: string };

/** Everything the web tier needs from the agent; implemented over HTTP and by the mock. */
export interface AgentSource {
  getState(): Promise<AgentState>;
  getLogs(limit: number): Promise<LogLine[]>;
  action(name: ActionName): Promise<ActionResponse>;
  /** Raw `GET /backups/{name}` response (streamed zip); the caller owns the body. */
  backup(name: string, signal: AbortSignal): Promise<Response>;
  /** Streams events with seq > since until the stream ends, errors, or `signal` aborts. */
  stream(since: number, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void>;
  /** Server settings: 404 when the agent has the feature off. */
  settings(req: SettingsRequest): Promise<Proxied>;
  /** The world map, conditional on the ETag of the copy the caller holds. */
  map(etag: string | null): Promise<MapSourceResult>;
  /** Raw agent file response (200 with a body, 304, 404, 503); the caller owns the body. */
  asset(path: AgentAsset, etag: string | null, signal: AbortSignal): Promise<Response>;
  /** Raw `GET /terrain/tile` (200 gzipped tile, 304, 404, 429, 502); the caller owns the body. */
  terrainTile?(tile: TerrainTileRef, etag: string | null, signal: AbortSignal): Promise<Response>;
  /** Raw `GET /pieces` for a box (200, 304, 400, 404, 503); the caller owns the body. */
  pieces(box: PiecesBox, etag: string | null, signal: AbortSignal): Promise<Response>;
  /**
   * Raw `GET /nature` for a box, like `pieces`. `spoilers` asks for nature on
   * land nobody explored too; only MAP_SPOILERS may set it.
   */
  nature(box: PiecesBox, spoilers: boolean, etag: string | null, signal: AbortSignal): Promise<Response>;
  /** The admin bridge: 404 when the agent has no BRIDGE_TOKEN. */
  bridge(req: BridgeRequest): Promise<Proxied>;
  /** Access lists and restore; 404 from agents older than this feature. */
  tools(req: ToolsRequest): Promise<Proxied>;
  /**
   * Starts or renews (true) or ends (false) the agent's live positions
   * lease: it polls the game for positions only while one is held.
   */
  watchPositions?(on: boolean): Promise<void>;
}

const SETTINGS_ROUTE: Record<SettingsRequest["op"], [method: string, path: string]> = {
  get: ["GET", "/settings"],
  password: ["GET", "/settings/password"],
  put: ["PUT", "/settings"],
  apply: ["POST", "/settings/apply"],
  cancel: ["DELETE", "/settings/apply"],
};

const TIMEOUT_MS = 10_000;

export class HttpAgent implements AgentSource {
  /** Names this web tier's positions lease, so another one sharing the agent keeps its own. */
  private readonly holder = crypto.randomUUID();

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return { "X-Agent-Token": this.token };
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`agent ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  getState(): Promise<AgentState> {
    return this.getJson<AgentState>("/state");
  }

  async watchPositions(on: boolean): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/positions/watch?holder=${this.holder}`, {
      method: on ? "POST" : "DELETE",
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    // 404 from an agent older than the lease: it polls whenever someone plays.
    if (!res.ok && res.status !== 404) throw new Error(`agent /positions/watch: HTTP ${res.status}`);
  }

  async getLogs(limit: number): Promise<LogLine[]> {
    const body = await this.getJson<{ lines: LogLine[] }>(`/logs?limit=${limit}`);
    return body.lines ?? [];
  }

  async action(name: ActionName): Promise<ActionResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/action/${name}`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body: ActionResult;
    try {
      body = (await res.json()) as ActionResult;
    } catch {
      body = { ok: res.ok, message: `HTTP ${res.status}` };
    }
    return { status: res.status, body };
  }

  async settings(req: SettingsRequest): Promise<Proxied> {
    const [method, path] = SETTINGS_ROUTE[req.op];
    const body = req.op === "put" ? JSON.stringify(req.body) : req.op === "apply" ? JSON.stringify({ mode: req.mode }) : undefined;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { ...this.headers(), "Content-Type": "application/json" } : this.headers(),
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = { ok: res.ok, message: `HTTP ${res.status}` };
    }
    return { status: res.status, body: json };
  }

  async map(etag: string | null): Promise<MapSourceResult> {
    const headers: Record<string, string> = { ...this.headers(), "Accept-Encoding": "gzip" };
    if (etag) headers["If-None-Match"] = etag;
    const res = await this.fetchImpl(`${this.baseUrl}/map`, { headers, signal: AbortSignal.timeout(30_000) });
    const tag = res.headers.get("ETag");
    if (res.status !== 200) {
      await res.body?.cancel();
      return { status: res.status, etag: tag, body: null };
    }
    return { status: 200, etag: tag, body: (await res.json()) as MapSnapshot };
  }

  asset(path: AgentAsset, etag: string | null, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = this.headers();
    if (etag) headers["If-None-Match"] = etag;
    return this.fetchImpl(`${this.baseUrl}/${path}`, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  }

  terrainTile(t: TerrainTileRef, etag: string | null, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = this.headers();
    if (etag) headers["If-None-Match"] = etag;
    // A tile the bridge has to sample can take seconds; the agent queues it.
    const q = `z=${t.z}&x=${t.x}&y=${t.y}&v=${encodeURIComponent(t.v)}`;
    return this.fetchImpl(`${this.baseUrl}/terrain/tile?${q}`, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
  }

  pieces(box: PiecesBox, etag: string | null, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { ...this.headers(), "Accept-Encoding": "gzip" };
    if (etag) headers["If-None-Match"] = etag;
    const [x0, z0, x1, z1] = box;
    return this.fetchImpl(`${this.baseUrl}/pieces?x0=${x0}&z0=${z0}&x1=${x1}&z1=${z1}`, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  }

  nature(box: PiecesBox, spoilers: boolean, etag: string | null, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { ...this.headers(), "Accept-Encoding": "gzip" };
    if (etag) headers["If-None-Match"] = etag;
    const [x0, z0, x1, z1] = box;
    const url = `${this.baseUrl}/nature?x0=${x0}&z0=${z0}&x1=${x1}&z1=${z1}${spoilers ? "&spoilers=true" : ""}`;
    return this.fetchImpl(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  }

  async bridge(req: BridgeRequest): Promise<Proxied> {
    const path = req.op === "status" ? "/bridge/status" : req.op === "players" ? "/bridge/players" : req.op === "read" ? `/bridge/${req.name}` : `/bridge/${req.command}`;
    const headers: Record<string, string> = this.headers();
    let body: string | undefined;
    if (req.op === "run") {
      headers["Content-Type"] = "application/json";
      headers["X-Skald-Actor"] = req.actor;
      body = JSON.stringify(req.body);
    }
    // The agent gives the plugin 8 s; this leaves room for its answer.
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: body ? "POST" : "GET", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = { ok: false, error: `HTTP ${res.status}` };
    }
    return { status: res.status, body: json };
  }

  async tools(req: ToolsRequest): Promise<Proxied> {
    const path = req.op === "access" ? "/access" : req.op === "access-change" ? `/access/${req.list}/${req.change}` : req.op === "compat-run" ? "/compat/run" : "/restore";
    const headers: Record<string, string> = this.headers();
    let body: string | undefined;
    if (req.op === "access-change" || req.op === "restore") {
      headers["Content-Type"] = "application/json";
      headers["X-Skald-Actor"] = req.actor;
      body = JSON.stringify(req.body);
    }
    if (req.op === "compat-run") headers["X-Skald-Actor"] = req.actor;
    const method = body || req.op === "compat-run" ? "POST" : "GET";
    // The ban list may go through the bridge (8 s); a restore's checks read the archive's directory.
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body, signal: AbortSignal.timeout(20_000) });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = { ok: false, error: `HTTP ${res.status}` };
    }
    return { status: res.status, body: json };
  }

  backup(name: string, signal: AbortSignal): Promise<Response> {
    // No timeout: a large zip to a slow client takes as long as it takes; the
    // client's disconnect aborts the upstream through `signal`.
    return this.fetchImpl(`${this.baseUrl}/backups/${encodeURIComponent(name)}`, { headers: this.headers(), signal });
  }

  async stream(since: number, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    // positions=lease: positions only while watchPositions holds the lease.
    const res = await this.fetchImpl(`${this.baseUrl}/events?since=${since}&positions=lease`, {
      headers: { ...this.headers(), Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`agent /events: HTTP ${res.status}`);
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    // The agent pings every 15 s; 45 s of silence means a dead connection.
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => void reader.cancel("idle timeout"), 45_000);
    };
    arm();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        arm();
        for (const data of parser.push(decoder.decode(value, { stream: true }))) {
          try {
            onEvent(JSON.parse(data) as AgentEvent);
          } catch {
            // malformed frame; skip
          }
        }
      }
    } finally {
      clearTimeout(idle);
    }
  }
}
