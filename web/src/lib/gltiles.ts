// The bookkeeping behind the WebGL map (mapgl.ts), kept free of WebGL so it
// is tested directly: a fixed pool of texture layers handed out least
// recently used first, a per-frame work budget, the crossfade clock, and the
// quads that draw a view as planned by terraintiles.ts's planView (a tile's
// own texture, or its loaded relatives standing in, the tile fading in over
// them once it arrives).

import { levelFor, tileKey, type Slot, type TileRef } from "./terraintiles";

/** How long a tile takes to fade in over what stood in for it. */
export const FADE_MS = 250;
/** Levels 0..GPU_PIN_LEVEL stay on the GPU for good: the floor every missing tile falls back to. */
export const GPU_PIN_LEVEL = 2;
/** A zoom must pass a level boundary by this much (in levels) before the drawn level changes, so a pinch resting on one does not crossfade back and forth. */
export const HYSTERESIS = 0.15;

/**
 * levelFor, holding `prev` (the level drawn last frame) until the zoom is
 * HYSTERESIS levels past the boundary to the next one.
 */
export function heldLevel(scale: number, dpr: number, maxLevel: number, radius: number, size: number, prev: number | undefined): number {
  const z = levelFor(scale, dpr, maxLevel, radius, size);
  if (prev === undefined || Math.abs(z - prev) !== 1) return z;
  // Still on the new side with the zoom pulled back by the margin?
  const back = levelFor(scale * 2 ** (z > prev ? -HYSTERESIS : HYSTERESIS), dpr, maxLevel, radius, size);
  return back === z ? z : prev;
}

/**
 * A fixed number of texture layers, each holding one tile. Layers are
 * handed out free first, then by evicting the least recently used tile
 * that `keep` does not protect (pinned levels, what this frame draws).
 */
export class TexturePool {
  /** Key to layer, least recently used first. */
  private layers = new Map<string, number>();
  private free: number[] = [];

  constructor(readonly capacity: number) {
    this.clear();
  }

  get size(): number {
    return this.layers.size;
  }

  has(key: string): boolean {
    return this.layers.has(key);
  }

  layer(key: string): number | undefined {
    return this.layers.get(key);
  }

  /** Marks a tile as just used. */
  touch(key: string): void {
    const l = this.layers.get(key);
    if (l === undefined) return;
    this.layers.delete(key);
    this.layers.set(key, l);
  }

  /** A layer for `key` (its own if it has one), or null when every layer is protected. */
  acquire(key: string, keep: (key: string) => boolean): { layer: number; evicted: string | null } | null {
    const own = this.layers.get(key);
    if (own !== undefined) {
      this.touch(key);
      return { layer: own, evicted: null };
    }
    let layer = this.free.pop();
    let evicted: string | null = null;
    if (layer === undefined) {
      for (const [k, l] of this.layers) {
        if (keep(k)) continue;
        this.layers.delete(k);
        layer = l;
        evicted = k;
        break;
      }
      if (layer === undefined) return null;
    }
    this.layers.set(key, layer);
    return { layer, evicted };
  }

  delete(key: string): void {
    const l = this.layers.get(key);
    if (l === undefined) return;
    this.layers.delete(key);
    this.free.push(l);
  }

  /** Frees the layers of every tile `drop` names. */
  deleteWhere(drop: (key: string) => boolean): void {
    for (const k of [...this.layers.keys()]) if (drop(k)) this.delete(k);
  }

  /** Forgets every tile (a lost context, a new build). */
  clear(): void {
    this.layers.clear();
    this.free = [];
    for (let l = this.capacity - 1; l >= 0; l--) this.free.push(l);
  }
}

/**
 * How many uploads a frame may still do: at most `max`, and none once
 * `ms` have gone since the frame began, though the first is always allowed
 * so the queue moves even on a slow device.
 */
export class UploadBudget {
  private t0 = 0;
  private n = 0;
  constructor(
    readonly max = 3,
    readonly ms = 3,
  ) {}

  begin(now: number): void {
    this.t0 = now;
    this.n = 0;
  }

  get used(): number {
    return this.n;
  }

  /** Whether one more upload fits; counts it if so. */
  take(now: number): boolean {
    if (this.n >= this.max || (this.n > 0 && now - this.t0 >= this.ms)) return false;
    this.n++;
    return true;
  }
}

const ease = (t: number) => t * t * (3 - 2 * t);

/** When each tile began fading in; a tile with no fade is fully shown. */
export class Fades {
  private start = new Map<string, number>();
  constructor(readonly ms = FADE_MS) {}

  begin(key: string, now: number): void {
    if (this.ms > 0) this.start.set(key, now);
  }

  /** 0..1, eased; 1 for a tile that is not fading. */
  alpha(key: string, now: number): number {
    const s = this.start.get(key);
    if (s === undefined) return 1;
    const t = (now - s) / this.ms;
    if (t >= 1) {
      this.start.delete(key);
      return 1;
    }
    return t <= 0 ? 0 : ease(t);
  }

  /** Whether any fade is still running at `now` (finished ones are forgotten). */
  busy(now: number): boolean {
    for (const [k, s] of this.start) if (now - s >= this.ms) this.start.delete(k);
    return this.start.size > 0;
  }

  drop(key: string): void {
    this.start.delete(key);
  }

  clear(): void {
    this.start.clear();
  }
}

/** One textured quad: the area of tile `dst`, drawn from tile `src` (itself, a descendant, or an ancestor cut down to it). */
export interface Quad {
  src: TileRef;
  dst: TileRef;
  alpha: number;
}

export interface Quads {
  /** In draw order: stand-ins first, a tile fading in last. */
  quads: Quad[];
  /** Every tile key a quad samples, to keep on the GPU. */
  used: Set<string>;
  /** Slots drawn from their own tile, from an ancestor, from descendants only, and with something missing. */
  own: number;
  ancestor: number;
  descendant: number;
  blank: number;
  /** Slots whose own tile is fading in. */
  fading: number;
}

/**
 * The quads for planView's slots, planned with `has` true only for tiles
 * that are on the GPU and done fading. A slot's own tile that is on the GPU
 * but still fading (`fading` gives its alpha, or null) is drawn last, over
 * the relatives planView picked to stand in for it; the relatives are cut to
 * the slot, so draw order alone decides what shows (no stencil).
 */
export function slotQuads(slots: readonly Slot[], fading: (t: TileRef) => number | null): Quads {
  const out: Quads = { quads: [], used: new Set(), own: 0, ancestor: 0, descendant: 0, blank: 0, fading: 0 };
  const push = (src: TileRef, dst: TileRef, alpha: number) => {
    out.quads.push({ src, dst, alpha });
    out.used.add(tileKey(src));
  };
  for (const s of slots) {
    if (s.own) {
      push(s.tile, s.tile, 1);
      out.own++;
      continue;
    }
    if (s.ancestor) push(s.ancestor, s.tile, 1);
    for (const d of s.descendants) push(d, d, 1);
    const a = fading(s.tile);
    if (a !== null) {
      push(s.tile, s.tile, a);
      out.own++;
      out.fading++;
    } else if (s.ancestor) out.ancestor++;
    else if (s.descendants.length) out.descendant++;
    if (s.blank && a === null) out.blank++;
  }
  return out;
}

/** The part of `src` that covers `dst` (a descendant or itself), as fractions of src: [s0, t0, s1, t1], north-west origin. */
export function subRect(src: TileRef, dst: TileRef): [number, number, number, number] {
  const up = dst.z - src.z;
  const n = 2 ** up;
  const i = dst.x - src.x * n;
  const j = dst.y - src.y * n;
  return [i / n, j / n, (i + 1) / n, (j + 1) / n];
}

/** The self-test's tile: one biome, flat ground `height` (raw u16) everywhere, no forest, `edge` samples a side. */
export function selfTestTile(edge: number, biome: number, height: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(edge * edge * 4);
  for (let i = 0; i < edge * edge; i++) {
    out[4 * i] = biome;
    out[4 * i + 1] = 0;
    out[4 * i + 2] = height >> 8;
    out[4 * i + 3] = height & 255;
  }
  return out;
}

/** What paintTile makes of flat dry ground of a biome with colour `rgb`: lit evenly, no forest, no water. */
export const flatColour = (rgb: readonly [number, number, number]): [number, number, number] => [rgb[0] * 0.94, rgb[1], rgb[2] * 0.9];

/** Whether a read-back pixel is within `tol` of the expected colour on every channel. */
export function closeColour(got: ArrayLike<number>, want: ArrayLike<number>, tol = 4): boolean {
  for (let c = 0; c < want.length; c++) if (Math.abs(got[c]! - want[c]!) > tol) return false;
  return true;
}

/**
 * When to give up on the GPU path while it runs: tiles that arrived but
 * cannot get onto the GPU for `ms` on end, or only decode errors and no tile
 * at all. Fed once a frame; `failed` names why, once.
 */
export class Watchdog {
  private since: number | null = null;
  failed: string | null = null;
  constructor(
    readonly ms = 5000,
    readonly maxErrors = 8,
  ) {}

  /** `stuck`: tiles wait on the CPU side and none went up this frame. */
  frame(now: number, stuck: boolean, feed: { ok: number; errors: number }): string | null {
    if (this.failed) return null;
    if (!stuck) this.since = null;
    else if (this.since === null) this.since = now;
    else if (now - this.since > this.ms) this.failed = "tiles arrived but could not be put on the GPU";
    if (!this.failed && feed.ok === 0 && feed.errors >= this.maxErrors) this.failed = "terrain tiles fail to decode";
    return this.failed;
  }
}

/**
 * Straight-alpha pixels (getImageData) to premultiplied, in place: WebGL
 * refuses UNPACK_PREMULTIPLY_ALPHA for pixel arrays going into an array
 * texture, and blending and filtering want premultiplied colour.
 */
export function premultiply<T extends Uint8ClampedArray | Uint8Array>(px: T): T {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]!;
    if (a === 255) continue;
    px[i] = Math.round((px[i]! * a) / 255);
    px[i + 1] = Math.round((px[i + 1]! * a) / 255);
    px[i + 2] = Math.round((px[i + 2]! * a) / 255);
  }
  return px;
}
