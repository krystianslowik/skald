import type { MapSourceResult } from "./agent";
import type { CatchupWorld } from "./types";
import { worldFacts, worldId } from "./catchup";
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
  /** What the catch-up card compares, cut once per snapshot. */
  facts: CatchupWorld;
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
 * served stale when the agent cannot be reached. A failed check counts as a
 * check, and while the agent is failing the copy is served at once and the
 * agent is asked again in the background, so no viewer waits on a down or
 * hung agent.
 */
export class MapCache {
  private cached: Cached | null = null;
  private checkedAt = -Infinity;
  /** The last check failed: the copy is served as stale until one succeeds. */
  private stale = false;
  /** The last check could not reach the agent and there was no copy to fall back on. */
  private unreachable: MapResponse | null = null;
  private inflight: Promise<MapResponse> | null = null;

  constructor(
    private readonly fetchMap: (etag: string | null) => Promise<MapSourceResult>,
    readonly spoilers: boolean,
    private readonly clock: () => number = Date.now,
    /** Keys the world identity of the catch-up facts (the session secret). */
    private readonly worldKey = "",
    /** Told the world's identity with every new copy (the web pins follow the world on the map). */
    private readonly onWorld?: (id: string) => void,
  ) {}

  /** The map, or with "storage" the village stores cut from the same copy. */
  async get(view: MapView = "map"): Promise<MapResponse> {
    const due = this.clock() - this.checkedAt >= MAP_RECHECK_MS;
    if (this.cached && (!due || this.stale)) {
      if (due) void this.revalidate().catch(() => {});
      return this.serve(this.stale, view);
    }
    if (!due && this.unreachable) return this.unreachable;
    const res = await this.revalidate();
    return res.ok ? this.serve(res.stale, view) : res;
  }

  /** The catch-up facts of the same copy; null while there is no map, or no key for the world identity. */
  async facts(): Promise<CatchupWorld | null> {
    // Unkeyed, the identity would let a viewer test seed names against it.
    if (!this.worldKey) return null;
    const res = await this.get("map");
    return res.ok && this.cached ? this.cached.facts : null;
  }

  /** Concurrent viewers share one agent round trip. */
  private revalidate(): Promise<MapResponse> {
    return (this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    }));
  }

  private serve(stale: boolean, view: MapView = "map"): MapResponse {
    const c = this.cached![view];
    return { ok: true, etag: c.etag, json: c.json, gzip: c.gzip, stale };
  }

  /** Records a finished check. */
  private checked(stale: boolean, unreachable: MapResponse | null = null): void {
    this.checkedAt = this.clock();
    this.stale = stale;
    this.unreachable = unreachable;
  }

  private async refresh(): Promise<MapResponse> {
    let res: MapSourceResult;
    try {
      res = await this.fetchMap(this.cached?.agentEtag ?? null);
    } catch {
      if (this.cached) {
        this.checked(true);
        return this.serve(true);
      }
      const down: MapResponse = { ok: false, status: 502, message: "agent unreachable" };
      this.checked(true, down);
      return down;
    }
    if (res.status === 304 && this.cached) {
      this.checked(false);
      return this.serve(false);
    }
    if (res.status !== 200 || !res.body) {
      if (this.cached) {
        this.checked(true);
        return this.serve(true);
      }
      // The agent answered: no longer unreachable, but nothing to keep either.
      this.unreachable = null;
      return { ok: false, status: res.status === 404 ? 404 : 503, message: res.status === 404 ? "world map off" : "world map not ready" };
    }
    const map = gateMap(res.body, this.spoilers);
    // Our own tags: the spoiler setting changes the body for the same agent map.
    this.cached = { agentEtag: res.etag ?? "", map: body(JSON.stringify(map)), storage: body(JSON.stringify(storageOf(map))), facts: { ...worldFacts(map), id: worldId(this.worldKey, map.meta.seedName, map.meta.seed) } };
    this.checked(false);
    this.onWorld?.(this.cached.facts.id);
    return this.serve(false);
  }
}
