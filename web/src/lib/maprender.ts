// Canvas 2D renderer for the world map: a parchment sheet like the game's own
// map, land inked from the zone grid with marching-squares coasts, a blue-grey
// sea, fog as cloudy paper over what nobody has explored, and the marks on
// top. Geometry is built once per snapshot; a frame only replays paths and
// sprites under the current transform, so it stays crisp at any zoom.
// Every method is a no-op without a 2D context (jsdom in tests).

import type { ApiMap } from "../types";
import {
  isoPolygons,
  isoSegments,
  landFields,
  LAND_LEVEL,
  placeLabels,
  portalLinks,
  WORLD_RADIUS,
  worldToScreen,
  type Box,
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
  fog: HTMLCanvasElement | OffscreenCanvas | null;
  fogOrigin: number;
  fogExtent: number;
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

  // Fog: cloudy paper with the explored area cut out, soft at the edges.
  let fog: Prepared["fog"] = null;
  const ex = map.explored;
  if (ex.available && mask) {
    const S = 512;
    const k = ex.size / S;
    const mc = makeCanvas(S, S);
    const mg = ctx2d(mc);
    const clouds = cloudTile();
    const fc = makeCanvas(1024, 1024);
    const fg = ctx2d(fc);
    if (mg && fg && clouds) {
      const img = mg.createImageData(S, S);
      for (let row = 0; row < ex.size; row++) {
        const r = Math.floor(row / k);
        for (let col = 0; col < ex.size; col++) {
          if (mask[row * ex.size + col]) img.data[(r * S + Math.floor(col / k)) * 4 + 3] = 255;
        }
      }
      mg.putImageData(img, 0, 0);
      fg.fillStyle = fg.createPattern(clouds, "repeat") ?? "#e7dcc2";
      fg.fillRect(0, 0, 1024, 1024);
      fg.globalCompositeOperation = "destination-out";
      fg.imageSmoothingEnabled = true;
      // A soft rim: a canvas blur where the browser has one, else a stack of
      // ever coarser copies (smoothing does the blurring).
      if ("filter" in fg && typeof fg.filter === "string") {
        fg.filter = "blur(5px)";
        fg.drawImage(mc, 0, 0, 1024, 1024);
        fg.filter = "none";
      } else {
        for (const [s, a] of [
          [512, 0.55],
          [256, 0.5],
          [128, 0.5],
        ] as const) {
          const lo = makeCanvas(s, s);
          const lg = ctx2d(lo);
          if (!lg) continue;
          lg.imageSmoothingEnabled = true;
          lg.drawImage(mc, 0, 0, s, s);
          fg.globalAlpha = a;
          fg.drawImage(lo, 0, 0, 1024, 1024);
        }
      }
      fg.globalAlpha = 1;
      fg.globalCompositeOperation = "source-over";
      fog = fc;
    }
  }
  const half = (ex.size / 2) * ex.metersPerPixel;
  return {
    land,
    sea,
    coast,
    density,
    gridOrigin: f.origin - f.step / 2,
    gridExtent: n * f.step,
    fog,
    fogOrigin: -half - ex.metersPerPixel / 2,
    fogExtent: ex.size * ex.metersPerPixel,
    links: portalLinks(map),
    terrain: map.terrainEdits,
  };
}

export interface FrameState {
  view: View;
  layers: Record<LayerId, boolean>;
  markers: readonly Marker[];
  selected: string | null;
  hovered: string | null;
}

export class MapRenderer {
  private ctx: CanvasRenderingContext2D | null;
  private dpr = 1;
  private prep: Prepared | null = null;
  private sprites = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
  private paper: HTMLCanvasElement | OffscreenCanvas | null = null;
  private measureCache = new Map<string, number>();
  /** Bumped on new data, so the cached base is re-rendered. */
  private version = 0;
  private base: { canvas: HTMLCanvasElement | OffscreenCanvas; key: string; cx: number; cz: number; scale: number; w: number; h: number } | null = null;
  /** Markers drawn in the last frame, in screen space, for picking. */
  visible: ScreenMarker[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d");
  }

  get ready(): boolean {
    return this.ctx !== null;
  }

  setData(map: ApiMap, mask: Uint8Array | null): void {
    if (!this.ctx) return;
    this.prep = prepare(map, mask);
    this.version++;
    this.paper ??= paperTile();
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

  private measure(g: CanvasRenderingContext2D, text: string): number {
    let w = this.measureCache.get(text);
    if (w === undefined) {
      w = g.measureText(text).width;
      if (this.measureCache.size > 4000) this.measureCache.clear();
      this.measureCache.set(text, w);
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
  draw(f: FrameState, quality: "fast" | "full" = "full"): void {
    const g = this.ctx;
    if (!g) return;
    const v = f.view;
    const key = `${f.layers.fog ? 1 : 0}${f.layers.terrain ? 1 : 0}:${this.version}:${v.w}x${v.h}:${this.dpr}`;
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
    this.drawMarkers(g, f);
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
    if (p) {
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
      if (layers.fog && p.fog) {
        g.imageSmoothingEnabled = true;
        g.globalAlpha = 0.96;
        g.drawImage(p.fog as CanvasImageSource, p.fogOrigin, p.fogOrigin, p.fogExtent, p.fogExtent);
        g.globalAlpha = 1;
      }
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

  private drawPaper(g: CanvasRenderingContext2D, v: View) {
    if (!this.paper) return;
    const pat = g.createPattern(this.paper as CanvasImageSource, "repeat");
    if (!pat || typeof DOMMatrix === "undefined") return;
    // Two texture octaves anchored to the world; their size steps by powers of
    // two with zoom and cross-fades, so the grain stays paper-sized on screen.
    const ideal = Math.log2(256 / v.scale);
    const base = Math.floor(ideal);
    const t = ideal - base;
    for (const [lvl, alpha] of [
      [base, 1 - t],
      [base + 1, t],
    ] as const) {
      if (alpha < 0.02) continue;
      const tile = 2 ** lvl;
      pat.setTransform(new DOMMatrix().scale(tile / 256, tile / 256));
      g.globalAlpha = alpha * 0.9;
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

  private drawMarkers(g: CanvasRenderingContext2D, f: FrameState) {
    const v = f.view;
    const pad = 30;
    const visible: ScreenMarker[] = [];
    const icons: Box[] = [];
    const labels: { sx: number; sy: number; text: string; priority: number }[] = [];
    // Dungeons are many: below this scale only every place someone found shows.
    const crowd = v.scale < 0.06;
    for (const m of f.markers) {
      if (!f.layers[m.layer]) continue;
      const [sx, sy] = worldToScreen(v, m.x, m.z);
      if (sx < -pad || sy < -pad || sx > v.w + pad || sy > v.h + pad) continue;
      const loc = m.data.type === "location" ? m.data : null;
      if (crowd && loc && loc.kind === "dungeon" && !loc.explored) continue;
      const px = m.data.type === "base" ? Math.round(18 + Math.min(12, Math.log2(m.data.pieces + 1))) : loc?.kind === "dungeon" ? 18 : ICON_PX;
      const dim = loc !== null && !loc.explored;
      const sp = this.sprite(m.icon, px, dim);
      if (!sp) continue;
      const size = px + 8;
      g.drawImage(sp as CanvasImageSource, sx - size / 2, sy - size / 2, size, size);
      if (m.id === f.selected || m.id === f.hovered) {
        g.strokeStyle = m.id === f.selected ? "#c2812f" : "rgba(43, 29, 18, 0.55)";
        g.lineWidth = m.id === f.selected ? 2.5 : 1.5;
        g.beginPath();
        g.arc(sx, sy, px / 2 + 5, 0, Math.PI * 2);
        g.stroke();
      }
      visible.push({ m, sx, sy });
      icons.push({ x: sx - px / 2, y: sy - px / 2, w: px, h: px });
      if (m.label && (v.scale >= m.labelScale || m.id === f.selected)) {
        labels.push({ sx, sy, text: m.label, priority: m.id === f.selected ? 1000 : m.priority });
      }
    }
    this.visible = visible;
    if (labels.length === 0) return;
    g.font = `700 12px ${FONT}`;
    const placed = placeLabels(labels, icons, (t) => this.measure(g, t), { max: 160 });
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
  }
}
