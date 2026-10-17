// Terrain tile data for the WebGL map: a small pool of workers that fetch
// and decode tiles (terraindata.worker.ts), the same TileScheduler as the
// Canvas2D map (nearest first, cancelled when no longer wanted), and a
// byte-bounded cache of the packed data on the CPU side, kept so a lost
// WebGL context can be refilled without the network.

import { paletteOf } from "./terrainpaint";
import { ByteLRU, TileScheduler, type TilesDoc } from "./terraintiles";

const RETRY_MS = 5000;

export interface FeedOptions {
  workers?: number;
  concurrency?: number;
  bytes?: number;
}

/** Decoded tiles to keep on the CPU side: about the GPU pool and some, less on small-memory phones. */
export function feedBudget(): number {
  const mem = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory ?? 8;
  return (mem <= 4 ? 28 : 48) * 1024 * 1024;
}

/** Decode workers: two, or three with cores to spare. */
function workerCount(): number {
  const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 4;
  return cores >= 6 ? 3 : 2;
}

/** The tile data for one tiles.json; `get` hands out what has arrived, `want` asks for more. */
export class TileFeed {
  private workers: { w: Worker; busy: number }[] = [];
  private owner = new Map<string, { w: Worker; busy: number }>();
  private cache: ByteLRU<Uint8Array>;
  private sched: TileScheduler;
  /** Tiles that answered 404: never asked again. */
  private missing = new Set<string>();
  /** Tiles that failed for now, by when they may be asked again. */
  private failed = new Map<string, number>();
  private readonly meanForest: number[];
  /** Keys the cache must not drop (what the map draws). */
  keep: ReadonlySet<string> = new Set();
  /** Tiles that arrived, and loads that failed in the worker (not 404s): the WebGL map gives up on a feed that only fails. */
  ok = 0;
  errors = 0;
  /** Called with each tile's key as it arrives. */
  onTile: ((key: string) => void) | null = null;

  constructor(
    readonly doc: TilesDoc,
    o: FeedOptions = {},
  ) {
    this.meanForest = paletteOf(doc.palette).meanForest;
    this.cache = new ByteLRU<Uint8Array>(o.bytes ?? feedBudget());
    for (let i = 0; i < (o.workers ?? workerCount()); i++) {
      const w = new Worker(new URL("./terraindata.worker.ts", import.meta.url), { type: "module" });
      const slot = { w, busy: 0 };
      w.onmessage = (e: MessageEvent<{ key: string; data?: Uint8Array; status?: number; error?: string }>) => this.arrive(e.data);
      this.workers.push(slot);
    }
    this.sched = new TileScheduler(o.concurrency ?? 6, (key) => {
      // The least busy worker decodes it.
      const slot = this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
      slot.busy++;
      this.owner.set(key, slot);
      const [z, x, y] = key.split("/");
      const url = `/api/terrain/tile?z=${z}&x=${x}&y=${y}&v=${encodeURIComponent(doc.build)}`;
      slot.w.postMessage({ type: "load", key, url, edge: doc.tileSize + 2 * doc.apron, meanForest: this.meanForest });
      return () => {
        // A cancelled load answers nothing; one that finished meanwhile is still kept when it lands.
        if (this.owner.get(key) === slot) {
          slot.busy--;
          this.owner.delete(key);
        }
        slot.w.postMessage({ type: "cancel", key });
      };
    });
  }

  private arrive({ key, data, status, error }: { key: string; data?: Uint8Array; status?: number; error?: string }) {
    const slot = this.owner.get(key);
    if (slot) {
      slot.busy--;
      this.owner.delete(key);
    }
    if (error && this.errors++ === 0) console.warn(`map: terrain tile ${key} failed: ${error}`);
    if (data) {
      this.ok++;
      this.cache.set(key, data, data.byteLength, this.keep);
      this.onTile?.(key);
    } else if (status === 404) this.missing.add(key);
    else if (status !== undefined) this.failed.set(key, Date.now() + RETRY_MS);
    this.sched.finish(key);
  }

  /** A tile's packed data, if it has arrived and is still held. */
  get(key: string): Uint8Array | undefined {
    return this.cache.get(key);
  }

  /** Whether a tile will never come (outside what is served). */
  gone(key: string): boolean {
    return this.missing.has(key);
  }

  /** The tiles still to fetch, most important first, from `low` on at low priority, at most `starts` new loads (TileScheduler); anything else in flight is cancelled. */
  want(keys: readonly string[], low = keys.length, starts = Infinity): void {
    const now = Date.now();
    const out: string[] = [];
    let lo = 0;
    keys.forEach((k, i) => {
      if (this.missing.has(k) || (this.failed.get(k) ?? 0) > now || this.cache.peek(k) !== undefined) return;
      out.push(k);
      if (i < low) lo = out.length;
    });
    this.sched.update(out, lo, starts);
  }

  get held(): { bytes: number; tiles: number; inflight: number } {
    return { bytes: this.cache.bytes, tiles: this.cache.size, inflight: this.owner.size };
  }

  dispose(): void {
    this.sched.update([]);
    for (const s of this.workers) s.w.terminate();
    this.workers = [];
    this.cache.clear();
  }
}
