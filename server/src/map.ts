import type { MapSourceResult } from "./agent";
import { gateMap, storageOf } from "./mapgate";

interface Body {
  etag: string;
  json: string;
  gzip: Uint8Array<ArrayBuffer>;
}

/** What a cache entry can serve: the gated map, or its containers alone. */
export type MapView = "map" | "storage";

interface Cached extends Record<MapView, Body> {
  /** The agent's ETag for the snapshot this was built from. */
  agentEtag: string;
}

function body(json: string): Body {
  return { etag: `"${Bun.hash(json).toString(36)}"`, json, gzip: Bun.gzipSync(json) };
}

export type MapResponse =
  | { ok: true; etag: string; json: string; gzip: Uint8Array<ArrayBuffer>; stale: boolean }
  | { ok: false; status: number; message: string };

/** How long a fetched map is served before the agent is asked again (with If-None-Match). */
export const MAP_RECHECK_MS = 15_000;

/**
 * The web tier's copy of the agent's map: re-validated against the agent at
 * most every MAP_RECHECK_MS, gated and serialised once per agent version, and
 * served stale when the agent cannot be reached.
 */
export class MapCache {
  private cached: Cached | null = null;
  private checkedAt = 0;
  private inflight: Promise<MapResponse> | null = null;

  constructor(
    private readonly fetchMap: (etag: string | null) => Promise<MapSourceResult>,
    readonly spoilers: boolean,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The map, or with "storage" the village stores cut from the same copy. */
  async get(view: MapView = "map"): Promise<MapResponse> {
    if (this.cached && this.clock() - this.checkedAt < MAP_RECHECK_MS) return this.serve(false, view);
    // Concurrent viewers share one agent round trip.
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    const res = await this.inflight;
    return res.ok ? this.serve(res.stale, view) : res;
  }

  private serve(stale: boolean, view: MapView = "map"): MapResponse {
    const c = this.cached![view];
    return { ok: true, etag: c.etag, json: c.json, gzip: c.gzip, stale };
  }

  private async refresh(): Promise<MapResponse> {
    let res: MapSourceResult;
    try {
      res = await this.fetchMap(this.cached?.agentEtag ?? null);
    } catch {
      return this.cached ? this.serve(true) : { ok: false, status: 502, message: "agent unreachable" };
    }
    if (res.status === 304 && this.cached) {
      this.checkedAt = this.clock();
      return this.serve(false);
    }
    if (res.status !== 200 || !res.body) {
      if (this.cached) return this.serve(true);
      return { ok: false, status: res.status === 404 ? 404 : 503, message: res.status === 404 ? "world map off" : "world map not ready" };
    }
    const map = gateMap(res.body, this.spoilers);
    // Our own tags: the spoiler setting changes the body for the same agent map.
    this.cached = { agentEtag: res.etag ?? "", map: body(JSON.stringify(map)), storage: body(JSON.stringify(storageOf(map))) };
    this.checkedAt = this.clock();
    return this.serve(false);
  }
}
