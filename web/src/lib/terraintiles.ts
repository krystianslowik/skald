// The terrain tile pyramid on the map. The planning half (planView,
// TileScheduler) knows nothing of how tiles are drawn: which level a view
// needs, which loaded relatives stand in for a missing tile, and what to load
// in which order. Levels 0-3 stay on the client once loaded, so nothing is
// ever blank. TerrainTiles is the Canvas2D side: fetch, decode and paint
// happen in terraintile.worker.ts, and it draws the bitmaps.

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

/**
 * The level whose samples are about one pixel of the canvas they are drawn
 * into (`dpr` pixels per CSS px, capped at 2): the nearest level in log
 * scale, so a sample is between 0.7 and 1.4 px.
 */
export function levelFor(scale: number, dpr: number, maxLevel: number, radius: number, size = 256): number {
  const want = Math.SQRT2 / (scale * Math.min(dpr, 2));
  for (let z = 0; z < maxLevel; z++) if (tileMpp(z, radius, size) <= want) return z;
  return maxLevel;
}

/**
 * Output pixels per tile pixel. One below 1 px/m, where a sample is already
 * about a pixel; 2 closer in, and 4 at the top level when zoomed far in, so
 * the close-up stays crisp.
 */
export const paintFactor = (z: number, maxLevel: number, scale: number) => (scale < 1 ? 1 : z === maxLevel && scale >= 6 ? 4 : 2);

/** The coarsest levels, kept on the client for good once loaded: the whole world at 10 m per pixel and coarser. */
export const PINNED_LEVELS = 3;

/** "z/x/y". */
export const tileKey = (t: TileRef) => `${t.z}/${t.x}/${t.y}`;

/** A tile's square in world metres (z up). */
export function tileBox(t: TileRef, radius: number): Box {
  const span = (2 * radius) / 2 ** t.z;
  const x0 = -radius + t.x * span;
  const z1 = radius - t.y * span;
  return { x0, z0: z1 - span, x1: x0 + span, z1 };
}

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

/** Levels 0..3 (or the pyramid's top, if lower) inside the world disc, coarsest first, each nearest `near`'s centre first. */
export function pinnedTiles(maxLevel: number, radius: number, near?: Box): TileRef[] {
  const world = { x0: -radius, z0: -radius, x1: radius, z1: radius };
  const out: TileRef[] = [];
  for (let z = 0; z <= Math.min(PINNED_LEVELS, maxLevel); z++) {
    const all = tilesIn(world, z, radius);
    if (near) {
      const cx = (near.x0 + near.x1) / 2;
      const cz = (near.z0 + near.z1) / 2;
      const d = (t: TileRef) => {
        const b = tileBox(t, radius);
        return ((b.x0 + b.x1) / 2 - cx) ** 2 + ((b.z0 + b.z1) / 2 - cz) ** 2;
      };
      all.sort((a, b) => d(a) - d(b));
    }
    out.push(...all);
  }
  return out;
}

/** One slot of the view's level and what stands in for it while its own tile is missing. */
export interface Slot {
  tile: TileRef;
  /** Its own tile is loaded. */
  own: boolean;
  /** Without its own tile: the nearest loaded ancestor, drawn first, unless descendants cover the slot. */
  ancestor: TileRef | null;
  /** Without its own tile: loaded tiles one or two levels finer, drawn over the ancestor. */
  descendants: TileRef[];
  /** Some of the slot has nothing loaded to show. */
  blank: boolean;
}

export interface ViewPlan {
  /** The level drawn. */
  z: number;
  /** Every tile of level z over the drawn box, nearest the view's centre first. */
  slots: Slot[];
  /** What to load, most important first: level 0, then the visible tiles. */
  want: TileRef[];
  /** `want` from this index on is low priority: one ring of tiles round the view, then the rest of levels 0..3. */
  low: number;
}

export interface PlanInput {
  /** What is drawn (a cached canvas may cover more than the screen). */
  box: Box;
  /** What is on screen. */
  view: Box;
  scale: number;
  dpr: number;
  maxLevel: number;
  radius: number;
  size?: number;
  /** A tile is loaded and can be drawn. */
  has: (t: TileRef) => boolean;
  /** The level to draw, when the caller picks it (the WebGL map holds a level a little past the boundary); levelFor otherwise. */
  level?: number;
}

/**
 * What a view needs from the pyramid: the level, every slot over the drawn
 * box with its stand-ins, and the load order. A missing tile shows its loaded
 * descendants (two levels down) over its nearest loaded ancestor, so with
 * level 0 in, no slot is ever blank.
 */
export function planView(p: PlanInput): ViewPlan {
  const { maxLevel, radius, has } = p;
  const z = p.level ?? levelFor(p.scale, p.dpr, maxLevel, radius, p.size);
  const slots: Slot[] = [];
  for (const t of tilesIn(p.box, z, radius)) {
    if (has(t)) {
      slots.push({ tile: t, own: true, ancestor: null, descendants: [], blank: false });
      continue;
    }
    const descendants: TileRef[] = [];
    let covered = z < maxLevel;
    for (let i = 0; i < 4 && z < maxLevel; i++) {
      const c = { z: z + 1, x: 2 * t.x + (i & 1), y: 2 * t.y + (i >> 1) };
      if (has(c)) {
        descendants.push(c);
        continue;
      }
      let all = z + 1 < maxLevel;
      for (let j = 0; j < 4 && z + 1 < maxLevel; j++) {
        const gc = { z: z + 2, x: 2 * c.x + (j & 1), y: 2 * c.y + (j >> 1) };
        if (has(gc)) descendants.push(gc);
        else all = false;
      }
      if (!all) covered = false;
    }
    let ancestor: TileRef | null = null;
    for (let up = 1; up <= z && !covered; up++) {
      const a = { z: z - up, x: t.x >> up, y: t.y >> up };
      if (has(a)) {
        ancestor = a;
        break;
      }
    }
    slots.push({ tile: t, own: false, ancestor, descendants, blank: !covered && !ancestor });
  }
  const want: TileRef[] = [];
  const seen = new Set<string>();
  const add = (t: TileRef) => {
    const k = tileKey(t);
    if (seen.has(k)) return;
    seen.add(k);
    if (!has(t)) want.push(t);
  };
  add({ z: 0, x: 0, y: 0 });
  for (const t of tilesIn(p.view, z, radius)) add(t);
  const low = want.length;
  const span = (2 * radius) / 2 ** z;
  for (const t of tilesIn({ x0: p.view.x0 - span, z0: p.view.z0 - span, x1: p.view.x1 + span, z1: p.view.z1 + span }, z, radius)) add(t);
  for (const t of pinnedTiles(maxLevel, radius, p.view)) add(t);
  return { z, slots, want, low };
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

  set(key: string, v: V, bytes: number, keep?: { has(key: string): boolean }): void {
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

/** Terrain tiles loading at once at rest (MapLibre's 16): a view's worth over a slow link arrives in one round trip, not three... */
export const LOADS_AT_REST = 16;
/** ...and while the map moves to no known landing (MapLibre's 8): what a drag crosses is cancelled as it leaves. */
export const LOADS_MOVING = 8;

/**
 * How many tile loads may run at once: LOADS_MOVING while the map moves,
 * LOADS_AT_REST at rest or once the motion's landing is known (a fling,
 * glide or pinch with the finger lifted), whose tiles are wanted for sure.
 */
export function loadLimit(moving: boolean, landing: boolean): number {
  return moving && !landing ? LOADS_MOVING : LOADS_AT_REST;
}

/**
 * Starts loads in the order asked, at most `concurrency` at once; a new
 * wish list cancels what is no longer on it. Keys from index `low` on are
 * low priority: one of them runs at a time, so they trickle in behind the
 * keys that matter (a server that works one tile at a time never has more
 * than one of them ahead of those). `start` begins a load and returns its
 * cancel; the owner calls `finish` when it ends either way. `starts` caps
 * the loads begun until the next update (none or two a frame while the map
 * moves: OpenLayers' rule, so a busy frame never also starts loads), and
 * `limit` the loads running at once until then (fewer while the map moves);
 * lowering it starts nothing new but cancels nothing still wanted.
 */
export class TileScheduler {
  private running = new Map<string, () => void>();
  private lows = new Set<string>();
  private wanted: string[] = [];
  private low = 0;
  private starts = Infinity;
  private limit: number;
  constructor(
    private readonly concurrency: number,
    private readonly start: (key: string, low: boolean) => () => void,
  ) {
    this.limit = concurrency;
  }

  get inflight(): ReadonlySet<string> {
    return new Set(this.running.keys());
  }

  /** The keys still needed, most important first; from `low` on, low priority. Until the next update, at most `starts` new loads begin and `limit` (never above the scheduler's concurrency) run at once. */
  update(wanted: readonly string[], low = wanted.length, starts = Infinity, limit = this.concurrency): void {
    this.wanted = [...wanted];
    this.low = low;
    this.starts = starts;
    this.limit = Math.min(limit, this.concurrency);
    const keep = new Set(wanted);
    for (const [k, cancel] of this.running) {
      if (!keep.has(k)) {
        this.running.delete(k);
        this.lows.delete(k);
        cancel();
      }
    }
    this.pump();
  }

  finish(key: string): void {
    this.running.delete(key);
    this.lows.delete(key);
    const i = this.wanted.indexOf(key);
    if (i >= 0) {
      this.wanted.splice(i, 1);
      if (i < this.low) this.low--;
    }
    this.pump();
  }

  private pump() {
    for (let i = 0; i < this.wanted.length; i++) {
      const k = this.wanted[i]!;
      if (this.running.has(k)) continue;
      if (this.running.size >= this.limit || this.starts <= 0) return;
      const low = i >= this.low;
      if (low && this.lows.size > 0) return;
      if (low) this.lows.add(k);
      this.starts--;
      this.running.set(k, this.start(k, low));
    }
  }
}

const RETRY_MS = 5000;

/** Last full draw's inputs, and what each slot showed, by tile key. */
interface Drawn {
  box: Box;
  view: Box;
  scale: number;
  dpr: number;
  shown: Map<string, string>;
}

/**
 * The tile pyramid for one tiles.json, drawn with Canvas2D: owns the worker,
 * the painted bitmaps and the schedule. Levels 0..3 are asked for as soon as
 * it exists and kept for good; the rest live in a byte-bounded LRU.
 */
export class TerrainTiles {
  private worker: Worker;
  private cache: ByteLRU<ImageBitmap>;
  /** Levels 0..3 at paint factor 1, never evicted. */
  private pinned = new Map<string, ImageBitmap>();
  private pinnedBytes = 0;
  private sched: TileScheduler;
  /** Tiles that answered 404 (outside or not served): never asked again. */
  private missing = new Set<string>();
  /** Tiles that failed for now, by when they may be asked again. */
  private failed = new Map<string, number>();
  private drawn = new Set<string>();
  private last: Drawn | null = null;
  /** The motion's landing (where a fling or glide comes to rest): its tiles, asked for first and kept. */
  private landing: { at: string; keys: string[]; set: ReadonlySet<string> } | null = null;
  /** What the cache must not drop: what the map draws, and the landing's tiles. */
  private readonly keep = { has: (k: string) => this.drawn.has(k) || (this.landing?.set.has(k) ?? false) };
  /** The last drawn view's wish list, behind the landing's tiles. */
  private wish: { high: string[]; low: string[] } = { high: [], low: [] };
  private limit = LOADS_AT_REST;
  private readonly palette: Palette;
  /** Called when a tile arrives (or fails); `changed()` says what to redraw. */
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
      if (bitmap) this.store(key, bitmap);
      else if (status === 404) this.missing.add(key);
      else this.failed.set(key, Date.now() + RETRY_MS);
      this.sched.finish(key);
      this.onTile?.();
    };
    this.sched = new TileScheduler(LOADS_AT_REST, (key, low) => {
      const [zxy, f] = key.split("@") as [string, string];
      const [z, x, y] = zxy.split("/").map(Number) as [number, number, number];
      const url = `/api/terrain/tile?z=${z}&x=${x}&y=${y}&v=${encodeURIComponent(this.doc.build)}`;
      this.worker.postMessage({ type: "load", key, url, low, factor: Number(f), palette: this.palette, waterLevel: this.doc.waterLevel, radius: this.doc.radius, apron: this.doc.apron });
      return () => this.worker.postMessage({ type: "cancel", key });
    });
    this.prime();
  }

  dispose(): void {
    this.sched.update([]);
    this.worker.terminate();
    this.cache.clear();
    for (const b of this.pinned.values()) b.close();
    this.pinned.clear();
    this.pinnedBytes = 0;
  }

  /** Bytes of painted tiles held and how many, and the share of levels 0..3 kept for good. */
  get held(): { bytes: number; tiles: number; pinnedBytes: number; pinnedTiles: number } {
    return { bytes: this.cache.bytes + this.pinnedBytes, tiles: this.cache.size + this.pinned.size, pinnedBytes: this.pinnedBytes, pinnedTiles: this.pinned.size };
  }

  /** For the ?mapstats harness: the slots `view` needs, how many have their own tile, how many show nothing, and the loads running. */
  coverage(view: Box, scale: number, dpr: number): { wanted: number; own: number; blank: number; inflight: number } {
    const p = this.plan(view, view, scale, dpr);
    return { wanted: p.slots.length, own: p.slots.filter((s) => s.own).length, blank: p.slots.filter((s) => s.blank).length, inflight: this.sched.inflight.size };
  }

  /** Level 0 is in (or will never be): from here on no slot is blank. Until then the map draws without tiles. */
  get ready(): boolean {
    return this.pinned.has("0/0/0@1") || this.missing.has("0/0/0@1");
  }

  /**
   * Asks for what a view needs without drawing it, while the map is drawn
   * without tiles (not ready yet). Without a view, levels 0..3, level 0 first.
   */
  prime(view?: Box, scale = 0, dpr = 1): void {
    if (view) return this.ask(this.plan(view, view, scale, dpr), view, scale);
    const keys = this.askable(pinnedTiles(this.doc.maxLevel, this.doc.radius).map((t) => `${tileKey(t)}@1`));
    this.sched.update(keys, keys[0] === "0/0/0@1" ? 1 : 0);
  }

  /**
   * Whether the map moves and where it will come to rest (`landing`, the
   * box on screen there), every frame, `dpr` as the map is drawn: as on the
   * WebGL map, the landing's tiles load ahead of the view's, at
   * LOADS_AT_REST at once; moving with no landing known, at LOADS_MOVING.
   * The map is only drawn again once its cached picture runs out, so the
   * wish list is redone here too.
   */
  motion(moving: boolean, landing: { view: Box; scale: number } | null, dpr: number): void {
    const limit = loadLimit(moving, landing !== null);
    const at = landing ? `${landing.view.x0},${landing.view.z0},${landing.view.x1},${landing.view.z1},${landing.scale}` : "";
    if (limit === this.limit && at === (this.landing?.at ?? "")) return;
    this.limit = limit;
    if (!landing) {
      // At rest on the landing: its tiles still on the way stay asked for (the cached picture may
      // cover it, so no full draw would ask again), ahead of the last wish list, until the next draw.
      if (this.landing) this.wish = { high: [...this.landing.keys, ...this.wish.high], low: this.wish.low };
      this.landing = null;
    } else if (at !== this.landing?.at) {
      // Planned as the landing will be drawn: its level, its paint factor, nearest its centre first.
      const p = this.plan(landing.view, landing.view, landing.scale, dpr);
      const f = paintFactor(p.z, this.doc.maxLevel, landing.scale);
      const keys = p.want.slice(0, p.low).map((t) => `${tileKey(t)}@${t.z === p.z ? f : 1}`);
      this.landing = { at, keys, set: new Set(keys) };
    }
    this.submit();
  }

  /** The plan's wish list to the scheduler; own tiles in view at another paint factor are asked for again at this one. */
  private ask(p: ViewPlan, view: Box, scale: number): void {
    const { maxLevel, radius } = this.doc;
    const f = paintFactor(p.z, maxLevel, scale);
    const keyOf = (t: TileRef) => `${tileKey(t)}@${t.z === p.z ? f : 1}`;
    const redo = p.slots.filter((s) => s.own && this.loaded(s.tile, f)?.key !== `${tileKey(s.tile)}@${f}` && inBox(tileBox(s.tile, radius), view)).map((s) => `${tileKey(s.tile)}@${f}`);
    this.wish = { high: [...p.want.slice(0, p.low).map(keyOf), ...redo], low: p.want.slice(p.low).map(keyOf) };
    this.submit();
  }

  /** The landing's tiles still missing, then the view's wish list, to the scheduler. */
  private submit(): void {
    const first = this.landing ? this.askable(this.landing.keys.filter((k) => !this.holds(k))) : [];
    const seen = new Set(first);
    const rest = (keys: string[]) =>
      this.askable(
        keys.filter((k) => {
          if (seen.has(k) || this.holds(k)) return false;
          seen.add(k);
          return true;
        }),
      );
    const high = [...first, ...rest(this.wish.high)];
    this.sched.update([...high, ...rest(this.wish.low)], high.length, Infinity, this.limit);
  }

  /** A painted bitmap for this exact key is held. */
  private holds(key: string): boolean {
    return this.pinned.has(key) || this.cache.peek(key) !== undefined;
  }

  private askable(keys: string[]): string[] {
    const now = Date.now();
    return keys.filter((k) => !this.missing.has(k) && (this.failed.get(k) ?? 0) <= now);
  }

  private store(key: string, bmp: ImageBitmap) {
    const [zxy, f] = key.split("@") as [string, string];
    if (f === "1" && Number(zxy.split("/")[0]) <= PINNED_LEVELS) {
      const old = this.pinned.get(key);
      if (old) {
        this.pinnedBytes -= old.width * old.height * 4;
        old.close();
      }
      this.pinned.set(key, bmp);
      this.pinnedBytes += bmp.width * bmp.height * 4;
    } else this.cache.set(key, bmp, bmp.width * bmp.height * 4, this.keep);
  }

  /** A loaded bitmap for a tile at any paint factor, preferring `f`. `touch` marks it recently used. */
  private loaded(t: TileRef, f: number, touch = false): { key: string; bmp: ImageBitmap } | null {
    const zxy = tileKey(t);
    for (const ff of [f, 1, 2, 4]) {
      const key = `${zxy}@${ff}`;
      const bmp = this.pinned.get(key) ?? (touch ? this.cache.get(key) : this.cache.peek(key));
      if (bmp) return { key, bmp };
    }
    return null;
  }

  private plan(box: Box, view: Box, scale: number, dpr: number): ViewPlan {
    const { maxLevel, radius, tileSize } = this.doc;
    const f = paintFactor(levelFor(scale, dpr, maxLevel, radius, tileSize), maxLevel, scale);
    return planView({ box, view, scale, dpr, maxLevel, radius, size: tileSize, has: (t) => this.loaded(t, f) !== null });
  }

  /** What each slot shows: its own tile (at which factor) or its stand-ins. */
  private shown(s: Slot, f: number): string {
    if (s.own) return this.loaded(s.tile, f)?.key ?? "";
    return `${s.ancestor ? tileKey(s.ancestor) : ""}|${s.descendants.map(tileKey).join(",")}`;
  }

  /**
   * The world boxes of slots that would draw differently now than in the
   * last draw, after tiles arrived: only these need drawing again.
   */
  changed(): Box[] {
    const d = this.last;
    if (!d) return [];
    const p = this.plan(d.box, d.view, d.scale, d.dpr);
    const f = paintFactor(p.z, this.doc.maxLevel, d.scale);
    const out: Box[] = [];
    for (const s of p.slots) if (d.shown.get(tileKey(s.tile)) !== this.shown(s, f)) out.push(tileBox(s.tile, this.doc.radius));
    return out;
  }

  /**
   * Draws the tiles over `box` into `g`, whose transform is the map's world
   * transform (y up), and asks for what `view` (the part on screen) needs.
   * A missing tile shows its loaded descendants over its nearest loaded
   * ancestor. With `only`, it draws just the slots touching those boxes, for
   * the same box and view as the last draw, and leaves the wish list alone.
   */
  draw(g: CanvasRenderingContext2D, box: Box, view: Box, scale: number, dpr: number, only?: readonly Box[]): void {
    const { maxLevel, radius } = this.doc;
    const p = this.plan(box, view, scale, dpr);
    const f = paintFactor(p.z, maxLevel, scale);
    const shown = only && this.last ? this.last.shown : new Map<string, string>();
    const drawn = new Set<string>();
    // Half a device pixel of overlap hides seams between neighbours.
    const pad = 0.5 / (scale * dpr);
    const put = (bmp: ImageBitmap, sx: number, sy: number, sw: number, b: Box) => {
      g.drawImage(bmp, sx, sy, sw, sw, b.x0 - pad, -b.z1 - pad, b.x1 - b.x0 + 2 * pad, b.z1 - b.z0 + 2 * pad);
    };
    const touches = (b: Box) => !only || only.some((o) => inBox(o, b));
    g.save();
    // Tiles are north up; the world transform flips rows, so flip them back.
    g.scale(1, -1);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    for (const s of p.slots) {
      const b = tileBox(s.tile, radius);
      const use = (t: TileRef) => {
        const l = this.loaded(t, f, true);
        if (l) drawn.add(l.key);
        return l;
      };
      const own = s.own ? use(s.tile) : null;
      const a = s.ancestor ? use(s.ancestor) : null;
      const kids = s.descendants.map((t) => ({ t, l: use(t) }));
      if (!touches(b)) continue;
      shown.set(tileKey(s.tile), this.shown(s, f));
      if (own) {
        put(own.bmp, 0, 0, own.bmp.width, b);
        continue;
      }
      if (a && s.ancestor) {
        // The ancestor, cut to this slot.
        const up = s.tile.z - s.ancestor.z;
        const sub = a.bmp.width / 2 ** up;
        put(a.bmp, (s.tile.x - (s.ancestor.x << up)) * sub, (s.tile.y - (s.ancestor.y << up)) * sub, sub, b);
      }
      for (const { t, l } of kids) if (l) put(l.bmp, 0, 0, l.bmp.width, tileBox(t, radius));
    }
    g.restore();
    if (only && this.last) {
      for (const k of drawn) this.drawn.add(k);
      return;
    }
    this.drawn = drawn;
    this.last = { box, view, scale, dpr, shown };
    this.ask(p, view, scale);
  }
}

const inBox = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

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
