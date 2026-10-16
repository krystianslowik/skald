// The terrain tile pyramid on the map: which tiles a view needs, fetching
// them in priority order (nearest the view first, at most four at a time,
// cancelled when they leave it), a byte-bounded LRU of the painted bitmaps,
// and drawing them with the nearest loaded ancestor standing in until a tile
// arrives. Fetch, decode and paint happen in terraintile.worker.ts.

import { useEffect, useState } from "react";
import { paletteOf, type Palette } from "./terrainpaint";

/** GET /api/terrain/tiles.json, as the agent serves it. */
export interface TilesDoc {
  build: string;
  tileSize: number;
  apron: number;
  maxLevel: number;
  gridLevel: number;
  radius: number;
  source: "bridge" | "grid";
  stale: boolean;
  waterLevel: number;
  biomes: string[];
  forest: "mask" | "factor" | "none";
  palette?: { source: string; biomes?: Record<string, string>; forestMask?: string } | null;
}

export interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface TileRef {
  z: number;
  x: number;
  y: number;
}

/** Metres per tile pixel at level z. */
export const tileMpp = (z: number, radius: number, size = 256) => (2 * radius) / (size * 2 ** z);

/** The coarsest level whose pixels are at most ~1.5 device px at this zoom. */
export function levelFor(scale: number, dpr: number, maxLevel: number, radius: number, size = 256): number {
  const want = 1.5 / (scale * Math.min(dpr, 2));
  for (let z = 0; z < maxLevel; z++) if (tileMpp(z, radius, size) <= want) return z;
  return maxLevel;
}

/** Output pixels per tile pixel: finer at the top level when zoomed far in. */
export const paintFactor = (z: number, maxLevel: number, scale: number) => (z === maxLevel && scale >= 6 ? 4 : 2);

/** Tiles of level z over `box`, inside the world disc, nearest the box's centre first. */
export function tilesIn(box: Box, z: number, radius: number): TileRef[] {
  const n = 2 ** z;
  const span = (2 * radius) / n;
  const x0 = Math.max(0, Math.floor((box.x0 + radius) / span));
  const x1 = Math.min(n - 1, Math.floor((box.x1 + radius) / span));
  const y0 = Math.max(0, Math.floor((radius - box.z1) / span));
  const y1 = Math.min(n - 1, Math.floor((radius - box.z0) / span));
  const cx = (box.x0 + box.x1) / 2;
  const cz = (box.z0 + box.z1) / 2;
  const out: { t: TileRef; d: number }[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const west = -radius + x * span;
      const north = radius - y * span;
      // Nearest point of the tile to the world's centre, and to the view's.
      const nx = Math.max(west, Math.min(0, west + span));
      const nz = Math.max(north - span, Math.min(0, north));
      if (nx * nx + nz * nz >= radius * radius) continue;
      const tx = west + span / 2 - cx;
      const tz = north - span / 2 - cz;
      out.push({ t: { z, x, y }, d: tx * tx + tz * tz });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.map((o) => o.t);
}

/** A map from key to value bounded by total bytes, least recently used out first. */
export class ByteLRU<V> {
  private map = new Map<string, { v: V; bytes: number }>();
  bytes = 0;
  constructor(
    private readonly max: number,
    private readonly onEvict: (v: V) => void = () => {},
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  /** Without touching recency. */
  peek(key: string): V | undefined {
    return this.map.get(key)?.v;
  }

  set(key: string, v: V, bytes: number, keep?: ReadonlySet<string>): void {
    this.delete(key);
    this.map.set(key, { v, bytes });
    this.bytes += bytes;
    // Evict the oldest, sparing what the current view draws.
    for (const [k, e] of this.map) {
      if (this.bytes <= this.max) break;
      if (k === key || keep?.has(k)) continue;
      this.map.delete(k);
      this.bytes -= e.bytes;
      this.onEvict(e.v);
    }
  }

  delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    this.bytes -= e.bytes;
    this.onEvict(e.v);
  }

  clear(): void {
    for (const e of this.map.values()) this.onEvict(e.v);
    this.map.clear();
    this.bytes = 0;
  }
}

/**
 * Starts loads in the order asked, at most `concurrency` at once; a new
 * wish list cancels what is no longer on it. `start` begins a load and
 * returns its cancel; the owner calls `finish` when it ends either way.
 */
export class TileScheduler {
  private running = new Map<string, () => void>();
  private wanted: string[] = [];
  constructor(
    private readonly concurrency: number,
    private readonly start: (key: string) => () => void,
  ) {}

  get inflight(): ReadonlySet<string> {
    return new Set(this.running.keys());
  }

  /** The keys still needed, most important first. */
  update(wanted: readonly string[]): void {
    this.wanted = [...wanted];
    const keep = new Set(wanted);
    for (const [k, cancel] of this.running) {
      if (!keep.has(k)) {
        this.running.delete(k);
        cancel();
      }
    }
    this.pump();
  }

  finish(key: string): void {
    this.running.delete(key);
    this.wanted = this.wanted.filter((k) => k !== key);
    this.pump();
  }

  private pump() {
    for (const k of this.wanted) {
      if (this.running.size >= this.concurrency) return;
      if (this.running.has(k)) continue;
      this.running.set(k, this.start(k));
    }
  }
}

const RETRY_MS = 5000;

/** The tile pyramid for one tiles.json: owns the worker, the cache and the schedule. */
export class TerrainTiles {
  private worker: Worker;
  private cache: ByteLRU<ImageBitmap>;
  private sched: TileScheduler;
  /** Tiles that answered 404 (outside or not served): never asked again. */
  private missing = new Set<string>();
  /** Tiles that failed for now, by when they may be asked again. */
  private failed = new Map<string, number>();
  private drawn = new Set<string>();
  private readonly palette: Palette;
  /** Called when a tile arrives and the map should redraw. */
  onTile: (() => void) | null = null;

  constructor(
    readonly doc: TilesDoc,
    maxBytes = defaultBudget(),
  ) {
    this.palette = paletteOf(doc.palette);
    this.cache = new ByteLRU<ImageBitmap>(maxBytes, (b) => b.close());
    this.worker = new Worker(new URL("./terraintile.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<{ key: string; bitmap?: ImageBitmap; status?: number }>) => {
      const { key, bitmap, status } = e.data;
      if (bitmap) {
        this.cache.set(key, bitmap, bitmap.width * bitmap.height * 4, this.drawn);
        this.onTile?.();
      } else if (status === 404) this.missing.add(key);
      else this.failed.set(key, Date.now() + RETRY_MS);
      this.sched.finish(key);
    };
    this.sched = new TileScheduler(4, (key) => {
      const [zxy, f] = key.split("@") as [string, string];
      const [z, x, y] = zxy.split("/").map(Number) as [number, number, number];
      const url = `/api/terrain/tile?z=${z}&x=${x}&y=${y}&v=${encodeURIComponent(this.doc.build)}`;
      this.worker.postMessage({ type: "load", key, url, factor: Number(f), palette: this.palette, waterLevel: this.doc.waterLevel, radius: this.doc.radius, apron: this.doc.apron });
      return () => this.worker.postMessage({ type: "cancel", key });
    });
  }

  dispose(): void {
    this.sched.update([]);
    this.worker.terminate();
    this.cache.clear();
  }

  /** Bytes of painted tiles held, and how many. */
  get held(): { bytes: number; tiles: number } {
    return { bytes: this.cache.bytes, tiles: this.cache.size };
  }

  private span(z: number) {
    return (2 * this.doc.radius) / 2 ** z;
  }

  /** A loaded bitmap for z/x/y at any paint factor, preferring `f`. */
  private loaded(z: number, x: number, y: number, f: number): { key: string; bmp: ImageBitmap } | null {
    for (const ff of [f, 4, 2]) {
      const key = `${z}/${x}/${y}@${ff}`;
      const bmp = this.cache.get(key);
      if (bmp) return { key, bmp };
    }
    return null;
  }

  /**
   * Draws the tiles over `box` into `g`, whose transform is the map's world
   * transform (y up). Missing tiles show their nearest loaded ancestor,
   * scaled; the wish list for the box replaces the last one.
   */
  draw(g: CanvasRenderingContext2D, box: Box, scale: number, dpr: number): void {
    const { maxLevel, radius } = this.doc;
    const z = levelFor(scale, dpr, maxLevel, radius, this.doc.tileSize);
    const f = paintFactor(z, maxLevel, scale);
    const now = Date.now();
    const want: string[] = [];
    const parents: string[] = [];
    const drawn = new Set<string>();
    // Half a device pixel of overlap hides seams between neighbours.
    const pad = 0.5 / (scale * dpr);
    const put = (bmp: ImageBitmap, sx: number, sy: number, sw: number, west: number, north: number, span: number) => {
      g.drawImage(bmp, sx, sy, sw, sw, west - pad, -north - pad, span + 2 * pad, span + 2 * pad);
    };
    const ask = (key: string, list: string[]) => {
      if (this.missing.has(key) || (this.failed.get(key) ?? 0) > now) return;
      list.push(key);
    };
    g.save();
    // Tiles are north up; the world transform flips rows, so flip them back.
    g.scale(1, -1);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    for (const t of tilesIn(box, z, radius)) {
      const span = this.span(z);
      const west = -radius + t.x * span;
      const north = radius - t.y * span;
      const own = this.loaded(z, t.x, t.y, f);
      if (own) {
        drawn.add(own.key);
        put(own.bmp, 0, 0, own.bmp.width, west, north, span);
        if (!own.key.endsWith(`@${f}`)) ask(`${z}/${t.x}/${t.y}@${f}`, want);
        continue;
      }
      ask(`${z}/${t.x}/${t.y}@${f}`, want);
      // The nearest loaded ancestor, cut to this tile.
      for (let up = 1; up <= z; up++) {
        const az = z - up;
        const ax = t.x >> up;
        const ay = t.y >> up;
        const a = this.loaded(az, ax, ay, 2);
        if (!a) {
          if (up === 1) ask(`${az}/${ax}/${ay}@2`, parents);
          continue;
        }
        drawn.add(a.key);
        const sub = a.bmp.width / 2 ** up;
        put(a.bmp, (t.x - (ax << up)) * sub, (t.y - (ay << up)) * sub, sub, west, north, span);
        break;
      }
    }
    g.restore();
    this.drawn = drawn;
    this.sched.update([...want, ...parents.filter((k, i) => parents.indexOf(k) === i)]);
  }
}

/** Painted tiles to keep: less on small-memory phones. */
function defaultBudget(): number {
  const mem = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory ?? 8;
  return (mem <= 4 ? 40 : 96) * 1024 * 1024;
}

/** Whether this browser can run the tile worker at all. */
export const tilesSupported = () =>
  typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof DecompressionStream !== "undefined" && typeof createImageBitmap !== "undefined";

function isDoc(x: unknown): x is TilesDoc {
  const d = x as Partial<TilesDoc> | null;
  return !!d && typeof d.build === "string" && typeof d.radius === "number" && d.radius > 0 && typeof d.maxLevel === "number" && d.tileSize === 256;
}

/** GET /api/terrain/tiles.json for the map; null without tiles. `key` changes look again. */
export function useTerrainTiles(key: string): TilesDoc | null {
  const [doc, setDoc] = useState<TilesDoc | null>(null);
  useEffect(() => {
    if (!tilesSupported()) return;
    let live = true;
    fetch("/api/terrain/tiles.json", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        // A new build replaces the doc; the same one keeps the object (and its cache).
        if (live) setDoc((prev) => (isDoc(d) ? (prev?.build === d.build ? prev : d) : prev));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]);
  return doc;
}
