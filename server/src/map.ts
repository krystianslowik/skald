import type { MapSourceResult } from "./agent";
import { gateMap } from "./mapgate";

interface Cached {
  /** The agent's ETag for the snapshot this was built from. */
  agentEtag: string;
  etag: string;
  json: string;
  gzip: Uint8Array<ArrayBuffer>;
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
    private readonly spoilers: boolean,
    private readonly clock: () => number = Date.now,
  ) {}

  get(): Promise<MapResponse> {
    if (this.cached && this.clock() - this.checkedAt < MAP_RECHECK_MS) return Promise.resolve(this.serve(false));
    // Concurrent viewers share one agent round trip.
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private serve(stale: boolean): MapResponse {
    const c = this.cached!;
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
    const json = JSON.stringify(gateMap(res.body, this.spoilers));
    const agentEtag = res.etag ?? "";
    // Our own tag: the spoiler setting changes the body for the same agent map.
    const etag = `"${Bun.hash(json).toString(36)}"`;
    this.cached = { agentEtag, etag, json, gzip: Bun.gzipSync(json) };
    this.checkedAt = this.clock();
    return this.serve(false);
  }
}
