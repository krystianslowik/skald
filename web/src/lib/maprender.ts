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
  LAYERS,
  mapShapes,
  markerItems,
  placeLabels,
  portalLinks,
  RingSet,
  WORLD_RADIUS,
  worldToScreen,
  type Box,
  type Cluster,
  type IconId,
  type LayerId,
  type MapShapes,
  type Marker,
  type ScreenMarker,
  type View,
} from "./mapgeo";
import { ICONS } from "./mapicons";
import { CLOUD_TILE, PAPER_TILE, textures as paperTextures, type Textures } from "./paper";
import { natureTint, wobble, type NatureItem } from "./nature";
import { NatureLayer, natureAlpha } from "./naturerender";
import type { ChunkKey, Piece } from "./pieces";
import { FloorPlan, PLAN_FULL_SCALE, PLAN_MIN_SCALE, planAlpha, STOREY_SCALE, viewBox, type StoreyInfo, type StoreyPick } from "./planrender";

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

/** A tile from its pixels, or null without a 2D context. */
function tileOf(px: Uint8ClampedArray<ArrayBuffer>, size: number): HTMLCanvasElement | OffscreenCanvas | null {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  if (!g || typeof ImageData === "undefined") return null;
  g.putImageData(new ImageData(px, size, size), 0, 0);
  return c;
}

/** The paper and cloud tiles, made once per page (in the map worker, the first time). */
let textures: { paper: HTMLCanvasElement | OffscreenCanvas | null; clouds: HTMLCanvasElement | OffscreenCanvas | null } | null = null;
const setTextures = (t: Textures) => (textures ??= { paper: tileOf(t.paper, PAPER_TILE), clouds: tileOf(t.clouds, CLOUD_TILE) });

interface Prepared {
  land: Path2D;
  sea: Path2D;
  coast: Path2D;
  density: HTMLCanvasElement | OffscreenCanvas | null;
  gridOrigin: number;
  gridExtent: number;
  /** The explored area's outline in world units: near the view, it is the fog's edge, and the world with it cut out (fill even-odd). */
  fog: RingSet | null;
  links: [number, number, number, number][];
  terrain: { x: number; z: number; cells: number }[];
}

function pathFromPolys(polys: readonly Float32Array[]): Path2D {
  const p = new Path2D();
  for (const poly of polys) {
    p.moveTo(poly[0]!, poly[1]!);
    for (let i = 2; i < poly.length; i += 2) p.lineTo(poly[i]!, poly[i + 1]!);
    // Land and sea are only filled, and a fill closes the ring (see closeRing for why not closePath).
  }
  return p;
}

/** Loops in grid units into `into`, in world units: node i, j at x0 + i * step, z0 + j * step. */
function pathFromLoops(loops: readonly Float32Array[], x0: number, z0: number, step: number, into = new Path2D()): Path2D {
  for (const l of loops) {
    into.moveTo(x0 + l[0]! * step, z0 + l[1]! * step);
    for (let i = 2; i < l.length; i += 2) into.lineTo(x0 + l[i]! * step, z0 + l[i + 1]! * step);
    // Filled even-odd, so only back to the start (see closeRing); strokes of these use round caps.
    into.lineTo(x0 + l[0]! * step, z0 + l[1]! * step);
  }
  return into;
}

/** Rings in world units into `into`; each only back to its start, as they are filled even-odd (see closeRing). */
function ringsPath(rings: readonly Float32Array[], into = new Path2D()): Path2D {
  for (const r of rings) {
    into.moveTo(r[0]!, r[1]!);
    for (let i = 2; i < r.length; i += 2) into.lineTo(r[i]!, r[i + 1]!);
    into.lineTo(r[0]!, r[1]!);
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

/** The shapes built in the worker, made drawable. */
export function prepare(shapes: MapShapes, map: ApiMap): Prepared {
  const n = shapes.size;
  let density: Prepared["density"] = null;
  const dc = makeCanvas(n, n);
  const dg = ctx2d(dc);
  if (dg && typeof ImageData !== "undefined") {
    dg.putImageData(new ImageData(shapes.density, n, n), 0, 0);
    density = dc;
  }
  return {
    land: pathFromPolys(shapes.land),
    sea: pathFromPolys(shapes.sea),
    coast: pathFromSegments(shapes.coast),
    density,
    gridOrigin: shapes.gridOrigin,
    gridExtent: shapes.gridExtent,
    fog: shapes.fog ? new RingSet(shapes.fog, shapes.fogStep) : null,
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
  /** The storey picked in the floor switcher; every other base shows its ground. */
  storey?: StoreyPick | null;
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
  private measureCache = new Map<string, number>();
  /** Bumped on new data, so the cached base is re-rendered. */
  private version = 0;
  /** The land and explored mask the shapes are (being) built from, and the newest request. */
  private shapesKey = "";
  private shapesReq = 0;
  private base: { canvas: HTMLCanvasElement | OffscreenCanvas; key: string; cx: number; cz: number; scale: number; w: number; h: number; rough: boolean } | null = null;
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
  /** Floor plans of the loaded bases, and which base the floor switcher is for. */
  private plan: FloorPlan | null = null;
  private planVersion = 0;
  private activeBase: string | null = null;
  /** Each chest mark's base and storey, for the current plan. */
  private markStorey = new Map<string, StoreyPick | null>();
  /** Trees, rocks, ore and the rest, as loaded so far. */
  private nature = new NatureLayer();
  /** The base being drawn is for a moving view: the woods may be rough. */
  private roughNature = false;
  /** Ore deposits drawn in the last frame, in screen space, for tapping. */
  visibleOre: { item: NatureItem; sx: number; sy: number; r: number }[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d");
  }

  get ready(): boolean {
    return this.ctx !== null;
  }

  /**
   * A new snapshot. Its land and fog shapes are built in a worker; until they
   * arrive the last ones stay on screen (with the new portal links and
   * terrain edits), and before the first nothing is drawn. A save that did
   * not change the land or the explored area reuses the shapes it has.
   */
  setData(map: ApiMap): void {
    if (!this.ctx) return;
    this.spoilers = map.spoilers;
    const key = `${map.land.size}:${map.land.data}|${map.explored.available ? `${map.explored.size}:${map.explored.rle}` : ""}`;
    if (this.prep) {
      this.prep = { ...this.prep, links: portalLinks(map), terrain: map.terrainEdits };
      this.version++;
    }
    if (key === this.shapesKey) return;
    this.shapesKey = key;
    const req = ++this.shapesReq;
    const done = (shapes: MapShapes, tex?: Textures) => {
      if (tex) setTextures(tex);
      if (req !== this.shapesReq) return;
      this.prep = prepare(shapes, map);
      this.version++;
      this.onChange?.();
    };
    const here = () => done(mapShapes(map.land, map.explored), textures ? undefined : paperTextures());
    if (typeof Worker === "undefined") return here();
    let worker: Worker;
    try {
      worker = new Worker(new URL("./map.worker.ts", import.meta.url), { type: "module" });
    } catch {
      return here();
    }
    worker.onmessage = (e: MessageEvent<{ shapes?: MapShapes; textures?: Textures; error?: string }>) => {
      worker.terminate();
      if (e.data.shapes) done(e.data.shapes, e.data.textures);
      else if (req === this.shapesReq) here();
    };
    worker.onerror = () => {
      worker.terminate();
      if (req === this.shapesReq) here();
    };
    worker.postMessage({ land: map.land, explored: map.explored, textures: !textures });
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

  /** What players built, as loaded so far. */
  setPieces(pieces: readonly Piece[]): void {
    if (!this.ctx) return;
    this.plan = pieces.length ? new FloorPlan(pieces) : null;
    this.planVersion++;
    this.markStorey.clear();
  }

  /** What the world generated, as loaded so far, by chunk. */
  setNature(loaded: ReadonlyMap<ChunkKey, readonly NatureItem[]>): void {
    if (!this.ctx) return;
    this.nature.set(loaded);
  }

  /** The ore deposit drawn under a screen point, within `slop` px of its edge. */
  oreAt(x: number, y: number, slop: number): NatureItem | null {
    let best: NatureItem | null = null;
    let bestD = Infinity;
    for (const o of this.visibleOre) {
      const d = Math.hypot(o.sx - x, o.sy - y) - o.r;
      if (d <= slop && d < bestD) {
        best = o.item;
        bestD = d;
      }
    }
    return best;
  }

  /** The base the floor switcher is for at this view, or null (too far out, one storey, none loaded). */
  storeys(v: View, layers: Record<LayerId, boolean>): StoreyInfo | null {
    if (!this.plan || !layers.buildings || v.scale < STOREY_SCALE) return null;
    return this.plan.active(viewBox(v));
  }

  /** The base and storey a point stands on, once its floor plan is loaded. */
  storeyAt(x: number, z: number, y: number | undefined): StoreyPick | null {
    return this.plan?.storeyAt(x, z, y) ?? null;
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
    if (!this.prep) {
      // The first shapes are on their way: the map appears whole, not paper first.
      this.screen(g);
      g.fillStyle = VOID;
      g.fillRect(0, 0, v.w, v.h);
      this.visible = [];
      this.visibleOre = [];
      return false;
    }
    const plan = f.layers.buildings && this.plan ? `${this.planVersion}:${f.storey ? `${f.storey.base}/${f.storey.level}` : ""}:${this.storeys(v, f.layers)?.base ?? ""}` : "";
    const nature = f.layers.nature || f.layers.resources ? `${f.layers.nature ? 1 : 0}${f.layers.resources ? 1 : 0}:${this.nature.version}` : "";
    const key = `${f.layers.fog ? 1 : 0}${f.layers.terrain ? 1 : 0}${f.layers.relief ? 1 : 0}:${this.version}:${v.w}x${v.h}:${this.dpr}:${plan}:${nature}`;
    let b = this.base;
    const covers = (c: NonNullable<typeof b>) => {
      const k = v.scale / c.scale;
      if (quality === "full" ? Math.abs(k - 1) > 1e-6 || c.rough : k < 0.6 || k > 1.8) return false;
      // The view's corners must fall inside the cached area.
      const halfW = v.w / 2 / v.scale;
      const halfH = v.h / 2 / v.scale;
      const cw = c.w / 2 / c.scale;
      const ch = c.h / 2 / c.scale;
      return Math.abs(v.cx - c.cx) + halfW <= cw + 0.5 / v.scale && Math.abs(v.cz - c.cz) + halfH <= ch + 0.5 / v.scale;
    };
    // Only a base whose woods were drawn rough needs a redraw at rest.
    const rough = quality === "fast" && f.layers.nature && natureAlpha(v.scale) > 0 && !this.nature.empty;
    if (!b || b.key !== key || !covers(b)) b = this.renderBase(f, key, rough);
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
    this.drawOres(g, f);
    if (this.prep && f.layers.portals) this.drawLinks(g, v, this.prep);
    return this.drawMarkers(g, f);
  }

  /** `rough`: mid-gesture, the woods may be drawn at half resolution; a full frame redraws them. */
  private renderBase(f: FrameState, key: string, rough = false): MapRenderer["base"] {
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
    this.activeBase = this.storeys(v, f.layers)?.base ?? null;
    this.roughNature = rough;
    this.drawWorld(g, { ...v, w, h }, f.layers, dpr, f.storey ?? null);
    this.base = { canvas, key, cx: v.cx, cz: v.cz, scale: v.scale, w, h, rough };
    return this.base;
  }

  /** Paper, sea, land, terrain heat, fog and the world's edge, for view `v` at `dpr`. */
  private drawWorld(g: CanvasRenderingContext2D, v: View, layers: Record<LayerId, boolean>, dpr: number, storey: StoreyPick | null) {
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
        g.lineCap = "round";
        g.lineWidth = (1.1 + 0.5 * near) / v.scale;
        g.stroke(coast.path);
        g.globalAlpha = 1;
      }
      g.restore();
      if (layers.terrain) this.drawTerrain(g, v, p);
      this.drawNature(g, v, layers);
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
      this.drawNature(g, v, layers);
      this.drawFog(g, v, p, layers);
    }
    // Floor plans over the fog: what was built is always somewhere explored.
    const planA = this.plan && layers.buildings ? planAlpha(v.scale) : 0;
    if (planA > 0) this.plan!.draw(g, viewBox(v, 4), v.scale, planA, storey, this.activeBase);
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

  /** Woods, rocks and pickables, under the fog and the floor plans. */
  private drawNature(g: CanvasRenderingContext2D, v: View, layers: Record<LayerId, boolean>) {
    if (!layers.nature && !layers.resources) return;
    this.nature.draw(g, viewBox(v, 4), v.scale, { nature: layers.nature, pickables: layers.resources }, this.roughNature);
  }

  /**
   * Ore deposits, in screen space so they keep their size during a pinch:
   * a stone in the metal's colour with a dark edge, never under 6 px across.
   */
  private drawOres(g: CanvasRenderingContext2D, f: FrameState) {
    const v = f.view;
    const alpha = natureAlpha(v.scale);
    this.visibleOre = [];
    if (!f.layers.resources || alpha <= 0) return;
    const ores = this.nature.ores(viewBox(v, 20));
    if (!ores.length) return;
    g.lineJoin = "round";
    for (const o of ores) {
      const [sx, sy] = worldToScreen(v, o.x, o.z);
      const r = Math.max(5, (o.size / 2) * v.scale * 0.9);
      if (sx < -r || sy < -r || sx > v.w + r || sy > v.h + r) continue;
      this.visibleOre.push({ item: o, sx, sy, r });
      const tint = natureTint("ore", o.species);
      // The same stone at every zoom: corners seeded by the deposit, yaw turning it clockwise.
      const a0 = (o.yaw * Math.PI) / 180;
      g.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = a0 + ((i + 0.3 * wobble(o, 40 + i)) / 7) * Math.PI * 2;
        const ri = r * (1 + 0.22 * wobble(o, i));
        if (i === 0) g.moveTo(sx + Math.cos(a) * ri, sy + Math.sin(a) * ri);
        else g.lineTo(sx + Math.cos(a) * ri, sy + Math.sin(a) * ri);
      }
      g.closePath();
      g.globalAlpha = alpha;
      g.fillStyle = tint;
      g.fill();
      g.strokeStyle = "#20160d";
      g.lineWidth = r > 12 ? 2 : 1.4;
      g.stroke();
      // A glint: two short light strokes across the stone, like veins of metal.
      if (r >= 7) {
        g.strokeStyle = "rgba(255, 246, 220, 0.75)";
        g.lineWidth = r > 20 ? 1.6 : 1.1;
        g.beginPath();
        g.moveTo(sx - r * 0.45, sy - r * 0.1);
        g.lineTo(sx - r * 0.05, sy - r * 0.35);
        g.moveTo(sx + r * 0.05, sy + r * 0.3);
        g.lineTo(sx + r * 0.4, sy + r * 0.05);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
  }

  private drawFog(g: CanvasRenderingContext2D, v: View, p: Prepared, layers: Record<LayerId, boolean>) {
    const clouds = textures?.clouds;
    if (!layers.fog || !p.fog || !clouds) return;
    // Only the outline near what is drawn, as fine as the zoom shows: a big
    // explored world has thousands of loops, and every clip and stroke below
    // walks all it is given. The box reaches past the widest rim, so where the
    // loops are cut at its sides stays out of the picture.
    const rings = p.fog.near(viewBox(v, 40 / v.scale), v.scale);
    const edge = ringsPath(rings);
    const area = ringsPath(rings, worldDisc());
    g.save();
    g.clip(area, "evenodd");
    this.drawTiled(g, v, clouds, 768, 1, true);
    this.drawPaper(g, v, 0.35);
    g.restore();
    // A soft rim on the explored side: bands of cloud a fixed few screen px
    // wide, so the edge stays sharp however close the view.
    const pat = g.createPattern(clouds as CanvasImageSource, "repeat");
    if (!pat || typeof DOMMatrix === "undefined") return;
    g.save();
    g.clip(edge, "evenodd");
    // The fog's coarser cloud octave, so the rim matches what it fades from.
    const size = 2 ** Math.floor(Math.log2(768 / v.scale));
    pat.setTransform(new DOMMatrix().scale(size / clouds.width, size / clouds.width));
    g.strokeStyle = pat;
    g.lineJoin = "round";
    g.lineCap = "round";
    // About half a kilometre zoomed out, as the old blurred fog was, and never
    // wider than a thumb's breadth close in.
    const rim = Math.min(36, Math.max(14, 500 * v.scale));
    for (let k = 6; k >= 1; k--) {
      g.globalAlpha = 0.1;
      g.lineWidth = (rim * k) / 6 / v.scale;
      g.stroke(edge);
    }
    g.restore();
  }

  private drawPaper(g: CanvasRenderingContext2D, v: View, alpha = 0.9) {
    if (textures?.paper) this.drawTiled(g, v, textures.paper, 256, alpha, false);
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
    const onPlan = !!this.plan && f.layers.buildings && v.scale >= PLAN_FULL_SCALE;
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
      // A chest on a storey above the one picked is not drawn; one below is a ghost.
      // A cluster shows as its most visible member does.
      const storey = members.length <= 1 ? this.storeyShade(m, f) : Math.max(...members.map((x) => this.storeyShade(x, f)));
      if (storey === 0) continue;
      alpha *= storey;
      const loc = m.data.type === "location" ? m.data : null;
      // Over a floor plan, chests are smaller marks, so the plan under them still reads.
      const px = m.data.type === "base" ? Math.round(18 + Math.min(12, Math.log2(m.data.pieces + 1))) : loc?.kind === "dungeon" ? 18 : m.data.type === "storage" && onPlan ? 19 : ICON_PX;
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
      } else if (m.data.type === "storage" && m.data.stack) {
        // A stack of chests: its height on a light seal, apart from a cluster's dark one.
        g.globalAlpha = alpha;
        icons.push(this.drawBadge(g, sx + px / 2 - 1, sy - px / 2 + 1, m.data.stack.length, true));
        g.globalAlpha = 1;
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

  /**
   * How a chest mark shows under the floor switcher: 1 on the picked storey
   * (the base's main one until one is picked, or outside any floor plan), a
   * ghost below it, 0 (hidden) above it. A picked or highlighted chest is
   * never hidden.
   */
  private storeyShade(m: Marker, f: FrameState): number {
    if (m.data.type !== "storage" || !this.plan || !f.layers.buildings || f.view.scale < PLAN_MIN_SCALE) return 1;
    let st = this.markStorey.get(m.id);
    if (st === undefined) {
      st = this.plan.storeyAt(m.data.store.x, m.data.store.z, m.data.store.y);
      this.markStorey.set(m.id, st);
    }
    if (!st) return 1;
    const picked = this.plan.levelOf(st.base, f.storey ?? null);
    if (st.level === picked) return 1;
    if (st.level < picked || m.id === f.selected || f.highlighted?.has(m.id)) return 0.4;
    return 0;
  }

  /** A cluster's count: a small dark seal on the icon's shoulder; `light` for a stack's height. */
  private drawBadge(g: CanvasRenderingContext2D, x: number, y: number, n: number, light = false): Box {
    const text = light ? `\u00d7${n}` : n > 99 ? "99+" : String(n);
    g.font = `700 10px ${FONT}`;
    const w = Math.max(15, this.measure(g, `10:${text}`, text) + 8);
    const h = 15;
    g.fillStyle = light ? "#efe2c2" : "#2b1d12";
    g.strokeStyle = light ? "#2b1d12" : "rgba(240, 228, 200, 0.95)";
    g.lineWidth = 1.5;
    g.beginPath();
    if (typeof g.roundRect === "function") g.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    else g.rect(x - w / 2, y - h / 2, w, h);
    g.fill();
    g.stroke();
    g.fillStyle = light ? "#2b1d12" : "#f3b867";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, x, y + 0.5);
    g.textAlign = "left";
    return { x: x - w / 2, y: y - h / 2, w, h };
  }
}
