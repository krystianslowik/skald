// Canvas 2D renderer for the world map: a parchment sheet like the game's own
// map, land inked from the zone grid with marching-squares coasts (or the
// world generator's terrain with its coast traced), a blue-grey sea, fog as
// cloudy paper over what nobody has explored, and the marks on top. Geometry is built once per snapshot; a frame only replays paths and
// sprites under the current transform, so it stays crisp at any zoom.
// Every method is a no-op without a 2D context (jsdom in tests).

import type { ApiMap, MapItem } from "../types";
import type { IconSheet } from "./itemicons";
import {
  clusterMarkers,
  exploredBounds,
  gridOutline,
  isoPolygons,
  isoSegments,
  landFields,
  LAYERS,
  LAND_LEVEL,
  markerItems,
  placeLabels,
  portalLinks,
  WORLD_RADIUS,
  worldToScreen,
  type Box,
  type Cluster,
  type IconId,
  type LayerId,
  type Marker,
  type ScreenMarker,
  type View,
} from "./mapgeo";
import { ICONS } from "./mapicons";

const PAPER = "#d9c7a0";
const PAPER_DARK = "#c2aa7c";
const LAND = "#b79b69";
const COAST = "#3a2a1a";
const SEA = "rgba(58, 82, 92, 0.62)";
const VOID = "#16110c";
const FONT = "'Averia Serif Libre', Georgia, serif";
const ICON_PX = 22;
/** The cached base covers this many times the view, so pans reuse it. */
const BASE_MARGIN = 1.5;

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const ctx2d = (c: HTMLCanvasElement | OffscreenCanvas): Ctx2D | null => c.getContext("2d") as Ctx2D | null;

/** Deterministic value noise in 0..1. */
function noise(x: number, y: number, seed: number): number {
  const h = (ix: number, iy: number) => {
    let n = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return a + (b - a) * s(fx) + (c - a) * s(fy) + (a - b - c + d) * s(fx) * s(fy);
}

/** Fractal noise on a torus of `period` cells, so the tile repeats seamlessly. */
function tiledNoise(x: number, y: number, period: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    const p = period * f;
    const u = ((x * f) % p + p) % p;
    const v = ((y * f) % p + p) % p;
    // Blend the four wrapped copies so the edges meet.
    const wx = u / p;
    const wy = v / p;
    const n =
      noise(u, v, seed + o) * (1 - wx) * (1 - wy) +
      noise(u - p, v, seed + o) * wx * (1 - wy) +
      noise(u, v - p, seed + o) * (1 - wx) * wy +
      noise(u - p, v - p, seed + o) * wx * wy;
    sum += n * amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum;
}

/** A seamless paper tile: fibres, blotches and specks, as alpha over the paper colour. */
function paperTile(size = 256): HTMLCanvasElement | OffscreenCanvas | null {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  if (!g) return null;
  const img = g.createImageData(size, size);
  const cells = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * cells;
      const v = (y / size) * cells;
      const blot = tiledNoise(u, v, cells, 4, 3);
      const fibre = tiledNoise(u * 6, v * 0.8, cells * 6, 2, 9);
      let a = Math.max(0, blot - 0.45) * 0.55 + Math.max(0, fibre - 0.55) * 0.35;
      if (noise(x * 13.1, y * 7.7, 5) > 0.985) a += 0.25;
      const i = (y * size + x) * 4;
      img.data[i] = 92;
      img.data[i + 1] = 64;
      img.data[i + 2] = 32;
      img.data[i + 3] = Math.min(255, a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Cloudy paper for the fog: light, with soft billows. */
function cloudTile(size = 512): HTMLCanvasElement | OffscreenCanvas | null {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  if (!g) return null;
  const img = g.createImageData(size, size);
  const cells = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = tiledNoise((x / size) * cells, (y / size) * cells, cells, 5, 21);
      const i = (y * size + x) * 4;
      const l = 0.86 + (n - 0.5) * 0.22;
      img.data[i] = Math.min(255, 236 * l);
      img.data[i + 1] = Math.min(255, 224 * l);
      img.data[i + 2] = Math.min(255, 196 * l);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

interface Prepared {
  land: Path2D;
  sea: Path2D;
  coast: Path2D;
  density: HTMLCanvasElement | OffscreenCanvas | null;
  gridOrigin: number;
  gridExtent: number;
  /** The explored area's outline, and the world with it cut out (fill even-odd). */
  fog: { edge: Path2D; area: Path2D } | null;
  links: [number, number, number, number][];
  terrain: { x: number; z: number; cells: number }[];
}

function pathFromPolys(polys: number[][]): Path2D {
  const p = new Path2D();
  for (const poly of polys) {
    p.moveTo(poly[0]!, poly[1]!);
    for (let i = 2; i < poly.length; i += 2) p.lineTo(poly[i]!, poly[i + 1]!);
    p.closePath();
  }
  return p;
}

/** Loops in grid units into `into`, in world units: node i, j at x0 + i * step, z0 + j * step. */
function pathFromLoops(loops: readonly Float32Array[], x0: number, z0: number, step: number, into = new Path2D()): Path2D {
  for (const l of loops) {
    into.moveTo(x0 + l[0]! * step, z0 + l[1]! * step);
    for (let i = 2; i < l.length; i += 2) into.lineTo(x0 + l[i]! * step, z0 + l[i + 1]! * step);
    into.closePath();
  }
  return into;
}

function worldDisc(): Path2D {
  const p = new Path2D();
  p.arc(0, 0, WORLD_RADIUS, 0, Math.PI * 2);
  return p;
}

function pathFromSegments(seg: Float32Array): Path2D {
  const p = new Path2D();
  for (let i = 0; i < seg.length; i += 4) {
    p.moveTo(seg[i]!, seg[i + 1]!);
    p.lineTo(seg[i + 2]!, seg[i + 3]!);
  }
  return p;
}

export function prepare(map: ApiMap, mask: Uint8Array | null): Prepared {
  const f = landFields(map.land);
  const n = f.size;
  const land = pathFromPolys(isoPolygons(f.land, n, f.origin, f.step));
  const sea = pathFromPolys(isoPolygons(f.generated, n, f.origin, f.step));
  const coast = pathFromSegments(isoSegments(f.land, n, f.origin, f.step));

  // Vegetation and building density as an ink wash inside the land.
  let density: Prepared["density"] = null;
  const dc = makeCanvas(n, n);
  const dg = ctx2d(dc);
  if (dg) {
    const img = dg.createImageData(n, n);
    for (let i = 0; i < n * n; i++) {
      const v = f.raw[i] ?? 0;
      const a = v < LAND_LEVEL ? 0 : Math.min(1, (v - LAND_LEVEL) / (230 - LAND_LEVEL));
      img.data[i * 4] = 62;
      img.data[i * 4 + 1] = 74;
      img.data[i * 4 + 2] = 38;
      img.data[i * 4 + 3] = a * 150;
    }
    dg.putImageData(img, 0, 0);
    density = dc;
  }

  // Fog: the explored area traced as smooth loops once, in world units, so
  // its edge stays sharp at any zoom. Only the explored box is walked.
  let fog: Prepared["fog"] = null;
  const ex = map.explored;
  if (ex.available && mask) {
    const area = worldDisc();
    const edge = new Path2D();
    const mpp = ex.metersPerPixel;
    const b = exploredBounds(mask, ex.size, mpp);
    if (b) {
      // Mask pixel (col, row) sits at ((col - size / 2) * mpp, (row - size / 2) * mpp).
      const px = (w: number) => Math.round(w / mpp + ex.size / 2);
      const c0 = Math.max(0, px(b[0]) - 2);
      const r0 = Math.max(0, px(b[1]) - 2);
      const c1 = Math.min(ex.size - 1, px(b[2]) + 2);
      const r1 = Math.min(ex.size - 1, px(b[3]) + 2);
      const w = c1 - c0 + 1;
      const cells = new Float32Array(w * (r1 - r0 + 1));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) cells[(r - r0) * w + c - c0] = mask[r * ex.size + c]!;
      }
      const loops = gridOutline(cells, w, r1 - r0 + 1);
      const x0 = (c0 - ex.size / 2) * mpp;
      const z0 = (r0 - ex.size / 2) * mpp;
      pathFromLoops(loops, x0, z0, mpp, edge);
      pathFromLoops(loops, x0, z0, mpp, area);
    }
    fog = { edge, area };
  }
  return {
    land,
    sea,
    coast,
    density,
    gridOrigin: f.origin - f.step / 2,
    gridExtent: n * f.step,
    fog,
    links: portalLinks(map),
    terrain: map.terrainEdits,
  };
}

/** The world generator's terrain, decoded: north up, spanning [-radius, radius] on both axes. */
export interface Relief {
  img: CanvasImageSource;
  radius: number;
}

export interface FrameState {
  view: View;
  layers: Record<LayerId, boolean>;
  markers: readonly Marker[];
  selected: string | null;
  hovered: string | null;
  /** Marks picked out on purpose (where an item is kept): drawn on their own with a ring. */
  highlighted?: ReadonlySet<string>;
  /** Marks closer than this on screen (CSS px) cluster; 0 draws every mark. */
  cluster?: number;
  /** Label budget and size: phones get fewer, larger labels. */
  labels?: { max: number; px: number };
  /** No split animation. */
  reduced?: boolean;
}

/** 0 at or below `a`, 1 at or above `b`, smooth between. */
function ramp(x: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** How long a mark takes to leave its cluster when the map zooms in. */
const SPLIT_MS = 280;
/** Zoomed in this far (px per metre), a container shows what it holds most of. */
const STRIP_SCALE = 2.4;
const STRIP_ICON = 18;
const STRIP_MAX = 4;

/** The kinds a container holds most of, by total count. */
export function topItems(items: readonly MapItem[], n = STRIP_MAX): string[] {
  const by = new Map<string, number>();
  for (const it of items) by.set(it.name, (by.get(it.name) ?? 0) + it.stack);
  return [...by]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([name]) => name);
}

export class MapRenderer {
  private ctx: CanvasRenderingContext2D | null;
  private dpr = 1;
  private prep: Prepared | null = null;
  private sprites = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
  private paper: HTMLCanvasElement | OffscreenCanvas | null = null;
  private clouds: HTMLCanvasElement | OffscreenCanvas | null = null;
  private measureCache = new Map<string, number>();
  /** Bumped on new data, so the cached base is re-rendered. */
  private version = 0;
  private base: { canvas: HTMLCanvasElement | OffscreenCanvas; key: string; cx: number; cz: number; scale: number; w: number; h: number } | null = null;
  /** Markers drawn in the last frame, in screen space, for picking. */
  visible: ScreenMarker[] = [];
  /** Clusters for one zoom level, layer set and marker list; a pan reuses them. */
  private clusters: { key: string; markers: readonly Marker[]; list: Cluster[]; leadOf: Map<string, Marker> } | null = null;
  /** Marks on their way out of a cluster: where they started and when. */
  private splits = new Map<string, { x: number; z: number; t0: number }>();
  /** The item icon sheet, decoded, for the contents strips under containers. */
  private icons: { img: CanvasImageSource; sheet: IconSheet } | null = null;
  private relief: Relief | null = null;
  /** The relief's traced coast: land loops and the sea around them, `mpp` metres per image pixel. */
  private coast: { of: Relief; path: Path2D; sea: Path2D; mpp: number } | null = null;
  private coastFor: Relief | null = null;
  /** Called when something arrives later (the traced coast) and wants a redraw. */
  onChange: (() => void) | null = null;
  /** Spoilers on: the terrain is not cut to where the world has been generated. */
  private spoilers = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d");
  }

  get ready(): boolean {
    return this.ctx !== null;
  }

  setData(map: ApiMap, mask: Uint8Array | null): void {
    if (!this.ctx) return;
    this.prep = prepare(map, mask);
    this.spoilers = map.spoilers;
    this.version++;
    this.paper ??= paperTile();
    this.clouds ??= cloudTile();
  }

  /** The decoded terrain image, or null for the land inked from the save. */
  setRelief(relief: Relief | null): void {
    this.relief = relief;
    this.version++;
    if (relief !== this.coastFor) {
      this.coastFor = relief;
      if (relief) this.traceCoast(relief);
    }
  }

  /** Traces the relief's coast in a worker, once per image; no worker, no coast line. */
  private traceCoast(relief: Relief) {
    if (!this.ctx || typeof Worker === "undefined" || typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") return;
    createImageBitmap(relief.img as ImageBitmapSource)
      .then((bitmap) => {
        if (this.coastFor !== relief) return bitmap.close();
        const worker = new Worker(new URL("./coast.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (e: MessageEvent<{ w: number; loops: Float32Array[] }>) => {
          worker.terminate();
          const { w, loops } = e.data;
          if (this.coastFor !== relief || !loops.length) return;
          const mpp = (2 * relief.radius) / w;
          const o = -relief.radius + mpp / 2;
          const sea = new Path2D();
          sea.arc(0, 0, relief.radius, 0, Math.PI * 2);
          this.coast = { of: relief, path: pathFromLoops(loops, o, o, mpp), sea: pathFromLoops(loops, o, o, mpp, sea), mpp };
          this.version++;
          this.onChange?.();
        };
        worker.onerror = () => worker.terminate();
        worker.postMessage({ bitmap }, [bitmap]);
      })
      .catch(() => {
        // an image the browser will not hand over: no coast line
      });
  }

  /** The decoded item icon sheet, or null to draw no contents strips. */
  setIcons(icons: { img: CanvasImageSource; sheet: IconSheet } | null): void {
    this.icons = icons;
  }

  resize(w: number, h: number, dpr: number): void {
    this.dpr = dpr;
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      this.sprites.clear();
    }
  }

  private screen(g: CanvasRenderingContext2D) {
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private sprite(icon: IconId, px: number, dim: boolean): HTMLCanvasElement | OffscreenCanvas | null {
    const key = `${icon}:${px}:${dim ? 1 : 0}`;
    const hit = this.sprites.get(key);
    if (hit) return hit;
    const size = Math.ceil((px + 8) * this.dpr);
    const c = makeCanvas(size, size);
    const g = ctx2d(c);
    if (!g) return null;
    const def = ICONS[icon];
    g.scale(this.dpr, this.dpr);
    const o = (px + 8) / 2;
    // A soft paper halo keeps the mark readable on land, sea and fog alike.
    const halo = g.createRadialGradient(o, o, px * 0.2, o, o, px * 0.62);
    halo.addColorStop(0, "rgba(240, 228, 200, 0.92)");
    halo.addColorStop(1, "rgba(240, 228, 200, 0)");
    g.fillStyle = halo;
    g.fillRect(0, 0, px + 8, px + 8);
    g.translate(4, 4);
    g.scale(px / 24, px / 24);
    g.globalAlpha = dim ? 0.5 : 1;
    if (def.fill) {
      g.fillStyle = def.ink;
      g.globalAlpha *= 0.28;
      g.fill(new Path2D(def.fill));
      g.globalAlpha = dim ? 0.5 : 1;
    }
    g.strokeStyle = def.ink;
    g.lineWidth = 1.9;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.stroke(new Path2D(def.d));
    this.sprites.set(key, c);
    return c;
  }

  /** Text width under the current font, cached by `key` (which must include the font size). */
  private measure(g: CanvasRenderingContext2D, key: string, text: string): number {
    let w = this.measureCache.get(key);
    if (w === undefined) {
      w = g.measureText(text).width;
      if (this.measureCache.size > 4000) this.measureCache.clear();
      this.measureCache.set(key, w);
    }
    return w;
  }

  /**
   * Draws a frame. "fast" frames (during a gesture or an animation) reuse a
   * cached bitmap of the paper, land, sea and fog, rendered with a margin
   * around the view and only moved or scaled; a "full" frame, once things
   * settle, re-renders it at the exact view. Marks and labels are always
   * drawn fresh, so they stay crisp.
   */
  draw(f: FrameState, quality: "fast" | "full" = "full"): boolean {
    const g = this.ctx;
    if (!g) return false;
    const v = f.view;
    const key = `${f.layers.fog ? 1 : 0}${f.layers.terrain ? 1 : 0}${f.layers.relief ? 1 : 0}:${this.version}:${v.w}x${v.h}:${this.dpr}`;
    let b = this.base;
    const covers = (c: NonNullable<typeof b>) => {
      const k = v.scale / c.scale;
      if (quality === "full" ? Math.abs(k - 1) > 1e-6 : k < 0.6 || k > 1.8) return false;
      // The view's corners must fall inside the cached area.
      const halfW = v.w / 2 / v.scale;
      const halfH = v.h / 2 / v.scale;
      const cw = c.w / 2 / c.scale;
      const ch = c.h / 2 / c.scale;
      return Math.abs(v.cx - c.cx) + halfW <= cw + 0.5 / v.scale && Math.abs(v.cz - c.cz) + halfH <= ch + 0.5 / v.scale;
    };
    if (!b || b.key !== key || !covers(b)) b = this.renderBase(f, key);
    this.screen(g);
    g.fillStyle = VOID;
    g.fillRect(0, 0, v.w, v.h);
    if (b) {
      // Place the cached bitmap: its centre world point and scale against the view's.
      const k = v.scale / b.scale;
      const [sx, sy] = worldToScreen(v, b.cx, b.cz);
      g.imageSmoothingEnabled = true;
      g.drawImage(b.canvas as CanvasImageSource, sx - (b.w / 2) * k, sy - (b.h / 2) * k, b.w * k, b.h * k);
    }
    this.screen(g);
    if (f.layers.grid) this.drawGrid(g, v);
    if (this.prep && f.layers.portals) this.drawLinks(g, v, this.prep);
    return this.drawMarkers(g, f);
  }

  private renderBase(f: FrameState, key: string): MapRenderer["base"] {
    const v = f.view;
    const w = Math.ceil(v.w * BASE_MARGIN);
    const h = Math.ceil(v.h * BASE_MARGIN);
    // The cache need not be sharper than 2x: it is redrawn at rest anyway.
    const dpr = Math.min(this.dpr, 2);
    let canvas = this.base?.canvas;
    if (!canvas || canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) canvas = makeCanvas(Math.round(w * dpr), Math.round(h * dpr));
    const g = ctx2d(canvas) as CanvasRenderingContext2D | null;
    if (!g) return null;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    this.drawWorld(g, { ...v, w, h }, f.layers, dpr);
    this.base = { canvas, key, cx: v.cx, cz: v.cz, scale: v.scale, w, h };
    return this.base;
  }

  /** Paper, sea, land, terrain heat, fog and the world's edge, for view `v` at `dpr`. */
  private drawWorld(g: CanvasRenderingContext2D, v: View, layers: Record<LayerId, boolean>, dpr: number) {
    const p = this.prep;
    const s = v.scale * dpr;
    g.setTransform(s, 0, 0, -s, (v.w / 2 - v.cx * v.scale) * dpr, (v.h / 2 + v.cz * v.scale) * dpr);
    g.save();
    g.beginPath();
    g.arc(0, 0, WORLD_RADIUS, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = PAPER;
    g.fillRect(-WORLD_RADIUS, -WORLD_RADIUS, WORLD_RADIUS * 2, WORLD_RADIUS * 2);
    this.drawPaper(g, v);
    const relief = layers.relief ? this.relief : null;
    if (p && relief) {
      const coast = this.coast?.of === relief ? this.coast : null;
      // Screen px per image pixel. Close in, the image is only blur: it fades
      // to a light wash over a flat sea, and the traced coast, inked at a
      // constant width, carries the shape.
      const px = coast ? v.scale * coast.mpp : 0;
      const near = ramp(px, 2.5, 6);
      // The world generator's own land, multiplied into the parchment so it
      // reads as ink on paper. Without spoilers it is cut to the zones the
      // world has generated (where someone has been); the fog does the rest.
      g.save();
      if (!this.spoilers) g.clip(p.sea);
      g.save();
      g.globalCompositeOperation = "multiply";
      g.globalAlpha = 0.9 * (1 - 0.55 * near);
      g.imageSmoothingEnabled = true;
      // The image is north up; the world transform flips rows, so flip them back.
      g.scale(1, -1);
      g.drawImage(relief.img, -relief.radius, -relief.radius, relief.radius * 2, relief.radius * 2);
      g.restore();
      if (coast && near > 0) {
        g.globalAlpha = near;
        g.fillStyle = SEA;
        g.fill(coast.sea, "evenodd");
        g.globalAlpha = 1;
        this.drawPaper(g, v, 0.6 * near);
      }
      const ink = ramp(px, 1, 2.5);
      if (coast && ink > 0) {
        g.globalAlpha = ink;
        g.strokeStyle = COAST;
        g.lineJoin = "round";
        g.lineWidth = (1.1 + 0.5 * near) / v.scale;
        g.stroke(coast.path);
        g.globalAlpha = 1;
      }
      g.restore();
      if (layers.terrain) this.drawTerrain(g, v, p);
      this.drawFog(g, v, p, layers);
    } else if (p) {
      g.fillStyle = SEA;
      g.fill(p.sea);
      // Old-map coastal ripples: wide, faint strokes around the land.
      g.strokeStyle = "rgba(40, 62, 72, 0.22)";
      g.lineCap = "round";
      for (const w of [16, 9]) {
        g.lineWidth = w / v.scale;
        g.stroke(p.coast);
      }
      g.fillStyle = LAND;
      g.fill(p.land);
      if (p.density) {
        g.save();
        g.clip(p.land);
        g.imageSmoothingEnabled = true;
        // Image rows run south to north and the world transform flips y, so no flip here.
        g.drawImage(p.density as CanvasImageSource, p.gridOrigin, p.gridOrigin, p.gridExtent, p.gridExtent);
        g.restore();
      }
      g.strokeStyle = COAST;
      g.lineWidth = Math.max(1.1, Math.min(2.2, v.scale * 6)) / v.scale;
      g.stroke(p.coast);
      if (layers.terrain) this.drawTerrain(g, v, p);
      this.drawFog(g, v, p, layers);
    }
    g.restore();
    // The edge of the world.
    g.strokeStyle = PAPER_DARK;
    g.lineWidth = 6 / v.scale;
    g.beginPath();
    g.arc(0, 0, WORLD_RADIUS, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = COAST;
    g.lineWidth = 1.5 / v.scale;
    g.stroke();
  }

  private drawFog(g: CanvasRenderingContext2D, v: View, p: Prepared, layers: Record<LayerId, boolean>) {
    if (!layers.fog || !p.fog || !this.clouds) return;
    g.save();
    g.clip(p.fog.area, "evenodd");
    this.drawTiled(g, v, this.clouds, 768, 1, true);
    this.drawPaper(g, v, 0.35);
    g.restore();
    // A soft rim on the explored side: bands of cloud a fixed few screen px
    // wide, so the edge stays sharp however close the view.
    const pat = g.createPattern(this.clouds as CanvasImageSource, "repeat");
    if (!pat || typeof DOMMatrix === "undefined") return;
    g.save();
    g.clip(p.fog.edge, "evenodd");
    // The fog's coarser cloud octave, so the rim matches what it fades from.
    const size = 2 ** Math.floor(Math.log2(768 / v.scale));
    pat.setTransform(new DOMMatrix().scale(size / this.clouds.width, size / this.clouds.width));
    g.strokeStyle = pat;
    g.lineJoin = "round";
    // About half a kilometre zoomed out, as the old blurred fog was, and never
    // wider than a thumb's breadth close in.
    const rim = Math.min(36, Math.max(14, 500 * v.scale));
    for (let k = 6; k >= 1; k--) {
      g.globalAlpha = 0.1;
      g.lineWidth = (rim * k) / 6 / v.scale;
      g.stroke(p.fog.edge);
    }
    g.restore();
  }

  private drawPaper(g: CanvasRenderingContext2D, v: View, alpha = 0.9) {
    if (this.paper) this.drawTiled(g, v, this.paper, 256, alpha, false);
  }

  /**
   * A tile over the world, anchored to it, at about `px` screen px whatever
   * the zoom: two octaves whose size steps by powers of two and cross-fade.
   * `solid` lays the coarser one down whole, for an opaque tile.
   */
  private drawTiled(g: CanvasRenderingContext2D, v: View, tile: HTMLCanvasElement | OffscreenCanvas, px: number, alpha: number, solid: boolean) {
    const pat = g.createPattern(tile as CanvasImageSource, "repeat");
    if (!pat || typeof DOMMatrix === "undefined") return;
    const ideal = Math.log2(px / v.scale);
    const base = Math.floor(ideal);
    const t = ideal - base;
    for (const [lvl, a] of [
      [base, solid ? 1 : 1 - t],
      [base + 1, t],
    ] as const) {
      if (a < 0.02) continue;
      const size = 2 ** lvl;
      pat.setTransform(new DOMMatrix().scale(size / tile.width, size / tile.width));
      g.globalAlpha = a * alpha;
      g.fillStyle = pat;
      g.fillRect(-WORLD_RADIUS, -WORLD_RADIUS, WORLD_RADIUS * 2, WORLD_RADIUS * 2);
    }
    g.globalAlpha = 1;
  }

  private drawTerrain(g: CanvasRenderingContext2D, v: View, p: Prepared) {
    for (const e of p.terrain) {
      const r = 46;
      const a = Math.min(0.75, 0.12 + Math.log2(1 + e.cells) / 16);
      const grad = g.createRadialGradient(e.x, e.z, 0, e.x, e.z, r);
      grad.addColorStop(0, `rgba(196, 70, 22, ${a})`);
      grad.addColorStop(1, "rgba(196, 70, 22, 0)");
      g.fillStyle = grad;
      g.fillRect(e.x - r, e.z - r, r * 2, r * 2);
    }
    void v;
  }

  private drawGrid(g: CanvasRenderingContext2D, v: View) {
    // A step that leaves 90..220 px between lines.
    const steps = [100, 250, 500, 1000, 2000, 5000];
    const step = steps.find((s) => s * v.scale >= 90) ?? 5000;
    const x0 = Math.floor((v.cx - v.w / 2 / v.scale) / step) * step;
    const x1 = v.cx + v.w / 2 / v.scale;
    const z0 = Math.floor((v.cz - v.h / 2 / v.scale) / step) * step;
    const z1 = v.cz + v.h / 2 / v.scale;
    g.strokeStyle = "rgba(43, 29, 18, 0.28)";
    g.lineWidth = 1;
    g.font = `11px ${FONT}`;
    g.fillStyle = "rgba(43, 29, 18, 0.75)";
    g.beginPath();
    for (let x = x0; x <= x1; x += step) {
      const [sx] = worldToScreen(v, x, 0);
      g.moveTo(Math.round(sx) + 0.5, 0);
      g.lineTo(Math.round(sx) + 0.5, v.h);
    }
    for (let z = z0; z <= z1; z += step) {
      const [, sy] = worldToScreen(v, 0, z);
      g.moveTo(0, Math.round(sy) + 0.5);
      g.lineTo(v.w, Math.round(sy) + 0.5);
    }
    g.stroke();
    g.textBaseline = "top";
    for (let x = x0; x <= x1; x += step) {
      const [sx] = worldToScreen(v, x, 0);
      g.fillText(String(x), sx + 3, 4);
    }
    g.textBaseline = "bottom";
    for (let z = z0; z <= z1; z += step) {
      const [, sy] = worldToScreen(v, 0, z);
      g.fillText(String(z), 4, sy - 2);
    }
  }

  private drawLinks(g: CanvasRenderingContext2D, v: View, p: Prepared) {
    g.save();
    g.strokeStyle = "rgba(33, 70, 95, 0.75)";
    g.lineWidth = 1.6;
    g.setLineDash([6, 5]);
    g.lineCap = "round";
    g.beginPath();
    for (const [ax, az, bx, bz] of p.links) {
      const [x1, y1] = worldToScreen(v, ax, az);
      const [x2, y2] = worldToScreen(v, bx, bz);
      g.moveTo(x1, y1);
      // A shallow arc reads as a jump rather than a road.
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const d = Math.hypot(x2 - x1, y2 - y1);
      g.quadraticCurveTo(mx - (y2 - y1) * 0.12, my + (x2 - x1) * 0.12 - d * 0.02, x2, y2);
    }
    g.stroke();
    g.restore();
  }

  /**
   * Clusters for this frame. Recomputed only when the zoom crosses a
   * half-octave, the layers or the marks change; marks that a new level frees
   * from a cluster start a short split from where their old cluster stood.
   */
  private clustersFor(f: FrameState, crowd: boolean): Cluster[] {
    const v = f.view;
    const radiusPx = f.cluster ?? 0;
    const level = Math.round(Math.log2(v.scale) * 2);
    const layerKey = LAYERS.map((l) => (f.layers[l] ? 1 : 0)).join("");
    const key = `${level}:${layerKey}:${radiusPx}:${crowd ? 1 : 0}`;
    const c = this.clusters;
    if (c && c.key === key && c.markers === f.markers) return c.list;
    const shown = f.markers.filter((m) => {
      if (!f.layers[m.layer]) return false;
      // Dungeons are many: zoomed out, only the ones someone found show.
      return !(crowd && m.data.type === "location" && m.data.kind === "dungeon" && !m.data.explored);
    });
    const list = clusterMarkers(shown, radiusPx > 0 ? radiusPx / 2 ** (level / 2) : 0);
    const leadOf = new Map<string, Marker>();
    for (const cl of list) for (const m of cl.members) leadOf.set(m.id, cl.lead);
    if (c && c.markers === f.markers && !f.reduced) {
      const now = performance.now();
      for (const cl of list) {
        const before = c.leadOf.get(cl.lead.id);
        if (before && before.id !== cl.lead.id) this.splits.set(cl.lead.id, { x: before.x, z: before.z, t0: now });
      }
    } else this.splits.clear();
    this.clusters = { key, markers: f.markers, list, leadOf };
    return list;
  }

  private drawMarkers(g: CanvasRenderingContext2D, f: FrameState): boolean {
    const v = f.view;
    const pad = 30;
    const visible: ScreenMarker[] = [];
    const icons: Box[] = [];
    const labels: { sx: number; sy: number; text: string; priority: number; r: number }[] = [];
    const crowd = v.scale < 0.06;
    const now = performance.now();
    let animating = false;
    const list = this.clustersFor(f, crowd);
    // The selected mark and highlighted ones leave their clusters, so they are always seen.
    const own = new Set(f.highlighted ?? []);
    if (f.selected) own.add(f.selected);
    const items: { m: Marker; members: readonly Marker[] }[] = [];
    for (const c of list) {
      if (own.size === 0) {
        items.push({ m: c.lead, members: c.members });
        continue;
      }
      const rest = c.members.filter((m) => m.id === c.lead.id || !own.has(m.id));
      items.push({ m: c.lead, members: rest });
      for (const m of c.members) if (m.id !== c.lead.id && own.has(m.id)) items.push({ m, members: [] });
    }
    // Draw order: low priority first, so the important marks sit on top.
    items.sort((a, b) => a.m.priority - b.m.priority);
    for (const { m, members } of items) {
      let wx = m.x;
      let wz = m.z;
      let alpha = 1;
      const split = this.splits.get(m.id);
      if (split) {
        const t = Math.min(1, (now - split.t0) / SPLIT_MS);
        if (t >= 1) this.splits.delete(m.id);
        else {
          // Ease out: quick to leave the cluster, gentle to land.
          const e = 1 - (1 - t) ** 3;
          wx = split.x + (m.x - split.x) * e;
          wz = split.z + (m.z - split.z) * e;
          alpha = 0.35 + 0.65 * e;
          animating = true;
        }
      }
      const [sx, sy] = worldToScreen(v, wx, wz);
      if (sx < -pad || sy < -pad || sx > v.w + pad || sy > v.h + pad) continue;
      const loc = m.data.type === "location" ? m.data : null;
      const px = m.data.type === "base" ? Math.round(18 + Math.min(12, Math.log2(m.data.pieces + 1))) : loc?.kind === "dungeon" ? 18 : ICON_PX;
      const dim = loc !== null && !loc.explored;
      const sp = this.sprite(m.icon, px, dim);
      if (!sp) continue;
      const size = px + 8;
      if (f.highlighted?.has(m.id)) {
        // A blue seal under the mark, like the game's selection.
        g.fillStyle = "rgba(94, 151, 204, 0.35)";
        g.strokeStyle = "#21465f";
        g.lineWidth = 2;
        g.beginPath();
        g.arc(sx, sy, px / 2 + 7, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
      g.globalAlpha = alpha;
      g.drawImage(sp as CanvasImageSource, sx - size / 2, sy - size / 2, size, size);
      g.globalAlpha = 1;
      if (m.id === f.selected || m.id === f.hovered) {
        g.strokeStyle = m.id === f.selected ? "#c2812f" : "rgba(43, 29, 18, 0.55)";
        g.lineWidth = m.id === f.selected ? 2.5 : 1.5;
        g.beginPath();
        g.arc(sx, sy, px / 2 + 5, 0, Math.PI * 2);
        g.stroke();
      }
      const count = members.length;
      if (count <= 1 && this.icons && v.scale >= STRIP_SCALE && (m.data.type === "storage" || m.data.type === "vehicle" || m.data.type === "grave")) {
        const strip = this.drawStrip(g, sx, sy + px / 2 + 4, markerItems(m));
        if (strip) icons.push(strip);
      }
      if (count > 1) {
        const badge = this.drawBadge(g, sx + px / 2 - 1, sy - px / 2 + 1, count);
        icons.push(badge);
      }
      visible.push(count > 1 ? { m, sx, sy, members } : { m, sx, sy });
      icons.push({ x: sx - px / 2, y: sy - px / 2, w: px, h: px });
      // A cluster whose lead has no name borrows the best one inside it (a portal's tag, a grave).
      const named = m.label ? m : count > 1 ? members.filter((x) => x.label && x.tier >= 2 && x.id !== f.selected).sort((a, b) => b.rank - a.rank)[0] : undefined;
      if (named && (v.scale >= named.labelScale || m.id === f.selected)) {
        labels.push({ sx, sy, text: named.label, priority: m.id === f.selected ? 1000 : named.rank, r: px / 2 + (count > 1 ? 9 : 1) });
      }
    }
    this.visible = visible;
    if (labels.length === 0) return animating;
    const lp = f.labels ?? { max: 160, px: 12 };
    g.font = `700 ${lp.px}px ${FONT}`;
    const placed = placeLabels(labels, icons, (t) => this.measure(g, `${lp.px}:${t}`, t), { max: lp.max, lineHeight: lp.px + 4, iconRadius: 12, bounds: v });
    g.textBaseline = "middle";
    g.lineJoin = "round";
    for (const l of placed) {
      const tx = l.align === "left" ? l.x + 3 : l.align === "right" ? l.x + l.w - 3 : l.x + l.w / 2;
      g.textAlign = l.align;
      g.strokeStyle = "rgba(236, 224, 196, 0.92)";
      g.lineWidth = 3.5;
      g.strokeText(l.text, tx, l.y + l.h / 2);
      g.fillStyle = "#2b1d12";
      g.fillText(l.text, tx, l.y + l.h / 2);
    }
    g.textAlign = "left";
    return animating;
  }

  /** Up to four item icons on a dark plate under a container: what it holds most of. */
  private drawStrip(g: CanvasRenderingContext2D, cx: number, top: number, items: readonly MapItem[] | undefined): Box | null {
    const ic = this.icons;
    if (!ic || !items?.length) return null;
    const names = topItems(items).filter((n) => ic.sheet.items[n]);
    if (!names.length) return null;
    const pad = 2;
    const w = names.length * STRIP_ICON + pad * 2;
    const h = STRIP_ICON + pad * 2;
    const x = Math.round(cx - w / 2);
    const y = Math.round(top);
    g.fillStyle = "rgba(43, 29, 18, 0.82)";
    g.strokeStyle = "rgba(240, 228, 200, 0.55)";
    g.lineWidth = 1;
    g.beginPath();
    if (typeof g.roundRect === "function") g.roundRect(x, y, w, h, 3);
    else g.rect(x, y, w, h);
    g.fill();
    g.stroke();
    g.imageSmoothingEnabled = true;
    const s = ic.sheet.size;
    names.forEach((n, i) => {
      const [sx, sy] = ic.sheet.items[n]!;
      g.drawImage(ic.img, sx, sy, s, s, x + pad + i * STRIP_ICON, y + pad, STRIP_ICON, STRIP_ICON);
    });
    return { x, y, w, h };
  }

  /** A cluster's count: a small dark seal on the icon's shoulder. */
  private drawBadge(g: CanvasRenderingContext2D, x: number, y: number, n: number): Box {
    const text = n > 99 ? "99+" : String(n);
    g.font = `700 10px ${FONT}`;
    const w = Math.max(15, this.measure(g, `10:${text}`, text) + 8);
    const h = 15;
    g.fillStyle = "#2b1d12";
    g.strokeStyle = "rgba(240, 228, 200, 0.95)";
    g.lineWidth = 1.5;
    g.beginPath();
    if (typeof g.roundRect === "function") g.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    else g.rect(x - w / 2, y - h / 2, w, h);
    g.fill();
    g.stroke();
    g.fillStyle = "#f3b867";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, x, y + 0.5);
    g.textAlign = "left";
    return { x: x - w / 2, y: y - h / 2, w, h };
  }
}
