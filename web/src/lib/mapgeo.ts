// World-map geometry and data shaping: decoders for the agent's compact
// encodings, the view transform, coastlines by marching squares, markers,
// label placement, picking and search. No DOM and no canvas here, so all of
// it is testable in jsdom.
//
// Orientation: world x grows east, world z grows north. On screen north is
// up, so screen y = centre - (z - cz) * scale. The land grid and the
// explored mask are both row-major from the south-west corner.

import type { ApiMap, MapContainer, MapItem, MapLand, MapLocation } from "../types";
import { groupStacks } from "./stacks";

/** Radius of the playable world in metres. */
export const WORLD_RADIUS = 10_500;

export function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Explored mask: 1 per explored pixel, from LEB128 runs alternating unexplored/explored. */
export function decodeRLE(b64: string, size: number): Uint8Array {
  const runs = decodeBase64(b64);
  const out = new Uint8Array(size * size);
  let i = 0;
  let p = 0;
  let on = false;
  while (p < runs.length && i < out.length) {
    let n = 0;
    let mul = 1;
    for (;;) {
      const c = runs[p++] ?? 0;
      n += (c & 0x7f) * mul;
      mul *= 128;
      if (!(c & 0x80) || p >= runs.length) break;
    }
    if (on) out.fill(1, i, Math.min(out.length, i + n));
    i += n;
    on = !on;
  }
  return out;
}

/** Mask pixel for a world point, -1 outside the mask. */
export function maskIndex(x: number, z: number, size: number, mpp: number): number {
  const col = Math.round(x / mpp) + size / 2;
  const row = Math.round(z / mpp) + size / 2;
  if (col < 0 || row < 0 || col >= size || row >= size) return -1;
  return row * size + col;
}

export function isExplored(mask: Uint8Array | null, x: number, z: number, size = 2048, mpp = 12): boolean {
  if (!mask) return false;
  const i = maskIndex(x, z, size, mpp);
  return i >= 0 && mask[i] === 1;
}

/** Zone byte at or above this is land: four or more objects in the zone. */
export const LAND_LEVEL = 50;

export interface LandFields {
  size: number;
  /** World coordinate of grid point 0 (a zone centre). */
  origin: number;
  step: number;
  /** Smoothed 0..1 land fraction per grid point. */
  land: Float32Array;
  /** Smoothed 0..1 "the world generated this" fraction. */
  generated: Float32Array;
  /** Raw zone bytes. */
  raw: Uint8Array;
}

/** A 1-2-1 blur of a row-major grid, `n` wide and `h` tall; the edges weigh only what is there. */
export function blur3(src: Float32Array, n: number, h = n): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let j = 0; j < h; j++) {
    const r = j * n;
    for (let i = 0; i < n; i++) {
      const l = i > 0 ? src[r + i - 1]! : -1;
      const x = i < n - 1 ? src[r + i + 1]! : -1;
      const c = src[r + i]!;
      tmp[r + i] = l < 0 ? (x < 0 ? c : (2 * c + x) / 3) : x < 0 ? (2 * c + l) / 3 : (l + 2 * c + x) / 4;
    }
  }
  for (let j = 0; j < h; j++) {
    const r = j * n;
    for (let i = 0; i < n; i++) {
      const c = tmp[r + i]!;
      if (j > 0 && j < h - 1) out[r + i] = (tmp[r + i - n]! + 2 * c + tmp[r + i + n]!) / 4;
      else if (h === 1) out[r + i] = c;
      else out[r + i] = (2 * c + tmp[j > 0 ? r + i - n : r + i + n]!) / 3;
    }
  }
  return out;
}

export function landFields(land: MapLand): LandFields {
  const raw = decodeBase64(land.data);
  const n = land.size;
  const l = new Float32Array(n * n);
  const g = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const v = raw[i] ?? 0;
    l[i] = v >= LAND_LEVEL ? 1 : 0;
    g[i] = v > 0 ? 1 : 0;
  }
  return { size: n, origin: land.min * land.zoneSize, step: land.zoneSize, land: blur3(l, n), generated: blur3(g, n), raw };
}

/**
 * Filled iso-region of a grid field as polygons in world coordinates
 * ([x0, z0, x1, z1, ...]). Marching squares with linear interpolation; full
 * cells are merged into one rectangle per run. Saddles connect diagonally.
 */
export function isoPolygons(field: Float32Array, n: number, origin: number, step: number, iso = 0.5): number[][] {
  const polys: number[][] = [];
  const at = (i: number, j: number) => field[j * n + i]!;
  const wx = (i: number) => origin + i * step;
  for (let j = 0; j < n - 1; j++) {
    let runStart = -1;
    const flush = (end: number) => {
      if (runStart < 0) return;
      const x0 = wx(runStart);
      const x1 = wx(end);
      const z0 = wx(j);
      const z1 = wx(j + 1);
      polys.push([x0, z0, x1, z0, x1, z1, x0, z1]);
      runStart = -1;
    };
    for (let i = 0; i < n - 1; i++) {
      // Corners counter-clockwise from the south-west.
      const v = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const inside = v.map((x) => x >= iso);
      const all = inside.every(Boolean);
      if (all) {
        if (runStart < 0) runStart = i;
        continue;
      }
      flush(i);
      if (!inside.some(Boolean)) continue;
      const cx = [wx(i), wx(i + 1), wx(i + 1), wx(i)];
      const cz = [wx(j), wx(j), wx(j + 1), wx(j + 1)];
      const poly: number[] = [];
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        if (inside[k]) poly.push(cx[k]!, cz[k]!);
        if (inside[k] !== inside[k2]) {
          const t = (iso - v[k]!) / (v[k2]! - v[k]!);
          poly.push(cx[k]! + (cx[k2]! - cx[k]!) * t, cz[k]! + (cz[k2]! - cz[k]!) * t);
        }
      }
      polys.push(poly);
    }
    flush(n - 1);
  }
  return polys;
}

/** The iso-line as segments [x1, z1, x2, z2, ...], matching isoPolygons' saddle choice. */
export function isoSegments(field: Float32Array, n: number, origin: number, step: number, iso = 0.5): Float32Array {
  const out: number[] = [];
  const at = (i: number, j: number) => field[j * n + i]!;
  const wx = (i: number) => origin + i * step;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const v = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const inside = v.map((x) => x >= iso);
      const count = inside.filter(Boolean).length;
      if (count === 0 || count === 4) continue;
      const cx = [wx(i), wx(i + 1), wx(i + 1), wx(i)];
      const cz = [wx(j), wx(j), wx(j + 1), wx(j + 1)];
      // Crossing on edge k (corner k to k+1), or null.
      const cross = (k: number): [number, number] | null => {
        const k2 = (k + 1) % 4;
        if (inside[k] === inside[k2]) return null;
        const t = (iso - v[k]!) / (v[k2]! - v[k]!);
        return [cx[k]! + (cx[k2]! - cx[k]!) * t, cz[k]! + (cz[k2]! - cz[k]!) * t];
      };
      const hits: [number, number][] = [];
      for (let k = 0; k < 4; k++) {
        const c = cross(k);
        if (c) hits.push(c);
      }
      if (hits.length === 2) {
        out.push(hits[0]![0], hits[0]![1], hits[1]![0], hits[1]![1]);
        continue;
      }
      // Saddle: the inside corners connect, so each outside corner is cut off
      // by the segment between its two adjacent edges' crossings.
      for (let k = 0; k < 4; k++) {
        if (inside[k]) continue;
        const a = cross((k + 3) % 4);
        const b = cross(k);
        if (a && b) out.push(a[0], a[1], b[0], b[1]);
      }
    }
  }
  return Float32Array.from(out);
}

/**
 * Closed outlines of where a w x h grid field is at or above `iso`, as loops
 * [x0, y0, x1, y1, ...] in grid units (node i, j at x = i, y = j), the high
 * side on the left. Marching squares with linear interpolation, linked into
 * loops by the grid edge each crossing sits on, so the joins are exact.
 * Beyond the grid counts as low, so every loop closes. Saddles connect the
 * high corners, as in isoSegments.
 */
export function fieldLoops(field: Float32Array, w: number, h: number, iso = 0.5): Float32Array[] {
  const W = w + 2;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : field[j * w + i]!);
  // Edge ids: 2 * node for the edge east of a node, 2 * node + 1 for the one north of it.
  const node = (i: number, j: number) => (j + 1) * W + i + 1;
  const next = new Map<number, number>();
  // High or low per node, with the low border around the grid.
  const hi = new Uint8Array(W * (h + 2));
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) hi[node(i, j)] = field[j * w + i]! >= iso ? 1 : 0;
  const e = [0, 0, 0, 0];
  for (let j = -1; j < h; j++) {
    for (let i = -1; i < w; i++) {
      // Corners counter-clockwise from the south-west; edge k runs from corner k to k + 1.
      const a = node(i, j);
      const c = hi[a]! | (hi[a + 1]! << 1) | (hi[a + W + 1]! << 2) | (hi[a + W]! << 3);
      if (c === 0 || c === 15) continue;
      e[0] = 2 * node(i, j);
      e[1] = 2 * node(i + 1, j) + 1;
      e[2] = 2 * node(i, j + 1);
      e[3] = 2 * node(i, j) + 1;
      // A segment leaves through an edge going high to low and ends on the
      // next edge going low to high (in a saddle, the very next edge).
      for (let k = 0; k < 4; k++) {
        if (!(c & (1 << k)) || c & (1 << ((k + 1) % 4))) continue;
        for (let d = 1; d < 4; d++) {
          const m = (k + d) % 4;
          if (!(c & (1 << m)) && c & (1 << ((m + 1) % 4))) {
            next.set(e[k]!, e[m]!);
            break;
          }
        }
      }
    }
  }
  const point = (id: number, out: number[]) => {
    const n = id >> 1;
    const i = (n % W) - 1;
    const j = Math.floor(n / W) - 1;
    const [i2, j2] = id & 1 ? [i, j + 1] : [i + 1, j];
    const a = at(i, j);
    const t = (iso - a) / (at(i2, j2) - a);
    out.push(i + (i2 - i) * t, j + (j2 - j) * t);
  };
  const loops: Float32Array[] = [];
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const pts: number[] = [];
    let id = start;
    for (;;) {
      const to = next.get(id);
      if (to === undefined) break;
      next.delete(id);
      point(id, pts);
      id = to;
      if (id === start) break;
    }
    if (pts.length >= 6) loops.push(Float32Array.from(pts));
  }
  return loops;
}

/** Twice the signed area of a loop (counter-clockwise is positive). */
export function loopArea(loop: Float32Array): number {
  let a = 0;
  const n = loop.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    a += loop[i]! * loop[j + 1]! - loop[j]! * loop[i + 1]!;
  }
  return a;
}

/** A closed loop with the points within `tol` of the line between their neighbours dropped (Douglas-Peucker). */
export function simplifyLoop(loop: Float32Array, tol: number): Float32Array {
  const n = loop.length / 2;
  if (n < 4) return loop;
  // Split at the point farthest from the first, so both halves are open runs.
  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = (loop[2 * i]! - loop[0]!) ** 2 + (loop[2 * i + 1]! - loop[1]!) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const stack: [number, number][] = [
    [0, far],
    [far, n],
  ];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = loop[2 * a]!;
    const ay = loop[2 * a + 1]!;
    const bx = loop[2 * (b % n)]!;
    const by = loop[2 * (b % n) + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = loop[2 * i]! - ax;
      const py = loop[2 * i + 1]! - ay;
      const d = len2 > 0 ? (px * dy - py * dx) ** 2 / len2 : px * px + py * py;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > t2) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(loop[2 * i]!, loop[2 * i + 1]!);
  return Float32Array.from(out);
}

/** Chaikin's corner cutting on a closed loop: each pass doubles the points and rounds the corners. */
export function smoothLoop(loop: Float32Array, passes = 2): Float32Array {
  let cur = loop;
  for (let p = 0; p < passes; p++) {
    const n = cur.length / 2;
    const out = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = cur[2 * i]!;
      const ay = cur[2 * i + 1]!;
      const bx = cur[2 * j]!;
      const by = cur[2 * j + 1]!;
      out[4 * i] = ax * 0.75 + bx * 0.25;
      out[4 * i + 1] = ay * 0.75 + by * 0.25;
      out[4 * i + 2] = ax * 0.25 + bx * 0.75;
      out[4 * i + 3] = ay * 0.25 + by * 0.75;
    }
    cur = out;
  }
  return cur;
}

/**
 * Smooth outlines of a 0/1 grid: blurred so the edge falls between cells,
 * traced, thinned to `tol` cells and rounded in `passes`. Loops under
 * `minArea` square cells (specks and pinholes) are dropped. Grid units, as
 * fieldLoops.
 */
export function gridOutline(cells: Float32Array, w: number, h: number, tol = 0.3, minArea = 3, passes = 3): Float32Array[] {
  const out: Float32Array[] = [];
  for (const loop of fieldLoops(blur3(cells, w, h), w, h)) {
    if (Math.abs(loopArea(loop)) < 2 * minArea) continue;
    out.push(smoothLoop(simplifyLoop(loop, tol), passes));
  }
  return out;
}

/**
 * Whether a terrain image pixel is sea: the agent paints water as a ramp from
 * shallow (116, 156, 164) to deep (38, 66, 92), bluer than any lit biome.
 * Transparent pixels lie beyond the world's edge and count as sea.
 */
export function isWater(r: number, g: number, b: number, a: number): boolean {
  return a < 128 || (b - r >= 30 && g - r >= 18);
}

// ---- view -------------------------------------------------------------------

export interface View {
  /** World point at the centre of the screen. */
  cx: number;
  cz: number;
  /** CSS pixels per metre. */
  scale: number;
  /** Viewport size in CSS pixels. */
  w: number;
  h: number;
}

/** The closest zoom: close enough to read a floor plan wall by wall and follow a player through the rooms. */
export const MAX_SCALE = 24;
/** Jumps to a mark from elsewhere (a search, the village stores) zoom no closer than this. */
export const FOCUS_MAX_SCALE = 8;

/** The smallest scale: the whole world disc with a margin. */
export function minScale(w: number, h: number): number {
  return Math.min(w, h) / (WORLD_RADIUS * 2 * 1.08);
}

export function clampView(v: View): View {
  const scale = Math.min(MAX_SCALE, Math.max(minScale(v.w, v.h), v.scale));
  // Keep the centre inside the world disc.
  const r = Math.hypot(v.cx, v.cz);
  const k = r > WORLD_RADIUS ? WORLD_RADIUS / r : 1;
  return { ...v, scale, cx: v.cx * k, cz: v.cz * k };
}

export function worldToScreen(v: View, x: number, z: number): [number, number] {
  return [v.w / 2 + (x - v.cx) * v.scale, v.h / 2 - (z - v.cz) * v.scale];
}

export function screenToWorld(v: View, sx: number, sy: number): [number, number] {
  return [v.cx + (sx - v.w / 2) / v.scale, v.cz - (sy - v.h / 2) / v.scale];
}

/** Zoom by `factor` keeping the world point under (sx, sy) fixed. */
export function zoomAt(v: View, sx: number, sy: number, factor: number): View {
  const [wx, wz] = screenToWorld(v, sx, sy);
  const scale = Math.min(MAX_SCALE, Math.max(minScale(v.w, v.h), v.scale * factor));
  return clampView({ ...v, scale, cx: wx - (sx - v.w / 2) / scale, cz: wz + (sy - v.h / 2) / scale });
}

/** A view that shows the box [x0, z0]..[x1, z1] with some padding. */
export function fitView(w: number, h: number, x0: number, z0: number, x1: number, z1: number, pad = 0.15): View {
  const bw = Math.max(400, x1 - x0);
  const bh = Math.max(400, z1 - z0);
  const scale = Math.min(w / (bw * (1 + pad * 2)), h / (bh * (1 + pad * 2)));
  return clampView({ cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, scale, w, h });
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * A view that shows the box [x0, z0, x1, z1] inside the screen minus `insets`
 * (CSS px kept clear for controls), with `pad` of the box's size around it.
 */
export function fitBounds(w: number, h: number, box: readonly [number, number, number, number], insets: Insets, pad = 0.06): View {
  const [x0, z0, x1, z1] = box;
  const bw = Math.max(400, x1 - x0) * (1 + pad * 2);
  const bh = Math.max(400, z1 - z0) * (1 + pad * 2);
  const iw = Math.max(1, w - insets.left - insets.right);
  const ih = Math.max(1, h - insets.top - insets.bottom);
  const scale = Math.min(iw / bw, ih / bh);
  // The box's centre lands in the middle of the clear area, not of the screen.
  const dx = (insets.left - insets.right) / 2;
  const dy = (insets.top - insets.bottom) / 2;
  return clampView({ cx: (x0 + x1) / 2 - dx / scale, cz: (z0 + z1) / 2 + dy / scale, scale, w, h });
}

// ---- markers ---------------------------------------------------------------

export type LayerId = "relief" | "fog" | "buildings" | "bases" | "portals" | "graves" | "beds" | "vehicles" | "storage" | "pins" | "locations" | "terrain" | "grid";

export const LAYERS: readonly LayerId[] = ["relief", "fog", "buildings", "bases", "portals", "graves", "beds", "vehicles", "storage", "pins", "locations", "terrain", "grid"];

export const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  // The world generator's terrain, under everything; only drawn when the server has one.
  relief: true,
  fog: true,
  // Floor plans of what players built, at close zoom.
  buildings: true,
  bases: true,
  portals: true,
  graves: true,
  beds: false,
  vehicles: true,
  storage: true,
  pins: true,
  locations: true,
  terrain: false,
  grid: false,
};

/** Icon names, one sprite each (see mapicons.ts). */
export type IconId =
  | "base"
  | "portal"
  | "grave"
  | "bed"
  | "ship"
  | "cart"
  | "chest"
  | "pin-fire"
  | "pin-home"
  | "pin-hammer"
  | "pin-point"
  | "pin-cave"
  | "pin-boss"
  | "loc-boss"
  | "loc-trader"
  | "loc-dungeon"
  | "loc-start";

export type MarkerData =
  | { type: "base"; pieces: number; hasBed: boolean; stations: string[]; zones: number; name?: string }
  | { type: "portal"; tag: string; pairedWith?: string; partnerTag?: string; partner?: { x: number; z: number } }
  | { type: "grave"; owner: string; day: number; items: MapItem[] }
  | { type: "bed"; owner: string }
  | { type: "vehicle"; kind: string; store?: MapContainer }
  /** A chest, or a stack of chests on one spot: `store` is the bottom one, `stack` all of them bottom to top. */
  | { type: "storage"; store: MapContainer; stack?: MapContainer[] }
  | { type: "pin"; kind: string; name: string }
  | { type: "location"; kind: MapLocation["kind"]; name: string; placed: boolean; explored: boolean };

export interface Marker {
  id: string;
  layer: LayerId;
  icon: IconId;
  x: number;
  z: number;
  /** Higher draws later. */
  priority: number;
  /** Who leads a cluster: bases, portals and graves (2) over ships and beds (1) over pins and places (0). */
  tier: number;
  /** Who gets label space first when labels collide. */
  rank: number;
  /** Text shown next to the icon at closer zoom (already translated). */
  label: string;
  /** Scale above which the label shows. */
  labelScale: number;
  data: MarkerData;
}

const PIN_ICONS: Record<string, IconId> = {
  fire: "pin-fire",
  home: "pin-home",
  hammer: "pin-hammer",
  point: "pin-point",
  cave: "pin-cave",
  boss: "pin-boss",
};

const VEHICLE_ICON = (kind: string): IconId => (kind === "Cart" ? "cart" : "ship");

/** Translated name of a location; `lookup` is i18n's runtime key lookup. */
export function locationName(name: string, kind: string, lookup: (key: string) => string | undefined): string {
  return lookup(`map.loc.${name}`) ?? lookup(`map.loc.${locationFamily(name)}`) ?? lookup(`map.locKind.${kind}`) ?? name;
}

/** Locations that share a display name: Crypt2/3/4, the two Dvergr town entrances, ... */
export function locationFamily(name: string): string {
  return name.replace(/\d+$/, "").replace(/_new$/, "");
}

/** Within this many metres of a base, a named home pin names the base. */
export const BASE_NAME_REACH = 120;

/** The name of the nearest named home pin in reach of each base, and which pins gave a name. */
function baseNames(map: ApiMap): { names: (string | undefined)[]; used: Set<number> } {
  const used = new Set<number>();
  const names = map.bases.map((b) => {
    let best = -1;
    let bestD = BASE_NAME_REACH ** 2;
    for (const [i, p] of map.pins.entries()) {
      if (p.kind !== "home" || !p.name) continue;
      const d = (p.x - b.x) ** 2 + (p.z - b.z) ** 2;
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    }
    if (best < 0) return undefined;
    used.add(best);
    return map.pins[best]!.name;
  });
  return { names, used };
}

export function buildMarkers(map: ApiMap, lookup: (key: string) => string | undefined): Marker[] {
  const out: Marker[] = [];
  const byId = new Map(map.portals.map((p) => [p.id, p]));
  const { names, used } = baseNames(map);
  // Label scales: portal tags, base names and graves read from the first view, even on a phone.
  for (const [i, b] of map.bases.entries()) {
    const name = names[i];
    out.push({
      id: `base:${i}`,
      layer: "bases",
      icon: "base",
      x: b.x,
      z: b.z,
      priority: 50 + Math.min(40, Math.log2(b.pieces + 1) * 4),
      tier: 2,
      rank: 280 + Math.min(19, Math.log2(b.pieces + 1)),
      label: name ?? "",
      labelScale: name ? 0.02 : Infinity,
      data: { type: "base", pieces: b.pieces, hasBed: b.hasBed, stations: b.stations, zones: b.zones, name },
    });
  }
  for (const p of map.portals) {
    const partner = p.pairedWith ? byId.get(p.pairedWith) : undefined;
    out.push({
      id: `portal:${p.id}`,
      layer: "portals",
      icon: "portal",
      x: p.x,
      z: p.z,
      priority: 70,
      tier: 2,
      rank: 300,
      label: p.tag,
      labelScale: 0.02,
      data: { type: "portal", tag: p.tag, pairedWith: p.pairedWith, partnerTag: partner?.tag, partner: partner ? { x: partner.x, z: partner.z } : undefined },
    });
  }
  for (const [i, g] of map.tombstones.entries()) {
    out.push({ id: `grave:${i}`, layer: "graves", icon: "grave", x: g.x, z: g.z, priority: 60, tier: 2, rank: 260, label: g.owner, labelScale: 0.04, data: { type: "grave", owner: g.owner, day: g.day, items: g.items ?? [] } });
  }
  for (const [i, b] of map.beds.entries()) {
    out.push({ id: `bed:${i}`, layer: "beds", icon: "bed", x: b.x, z: b.z, priority: 30, tier: 1, rank: 50, label: b.owner, labelScale: 1.2, data: { type: "bed", owner: b.owner } });
  }
  const stores = new Map(map.storage.map((c) => [c.id, c]));
  for (const [i, v] of map.vehicles.entries()) {
    out.push({
      id: `vehicle:${i}`,
      layer: "vehicles",
      icon: VEHICLE_ICON(v.kind),
      x: v.x,
      z: v.z,
      priority: 40,
      tier: 1,
      rank: 100,
      label: lookup(`map.vehicle.${v.kind}`) ?? v.kind,
      labelScale: 0.6,
      data: { type: "vehicle", kind: v.kind, store: v.id ? stores.get(v.id) : undefined },
    });
  }
  // Carts and ships are drawn as vehicles; the storage layer adds the chests,
  // one mark for each stack of them.
  for (const { chests } of groupStacks(map.storage)) {
    const c = chests[0]!;
    const data: MarkerData = chests.length > 1 ? { type: "storage", store: c, stack: chests } : { type: "storage", store: c };
    out.push({ id: `store:${c.id}`, layer: "storage", icon: "chest", x: c.x, z: c.z, priority: 35, tier: 1, rank: 60, label: "", labelScale: Infinity, data });
  }
  for (const [i, p] of map.pins.entries()) {
    out.push({
      id: `pin:${i}`,
      layer: "pins",
      icon: PIN_ICONS[p.kind] ?? "pin-point",
      x: p.x,
      z: p.z,
      priority: 55,
      tier: 0,
      rank: 150,
      // A home pin that names a base lends it the label; the pin keeps its name in the details.
      label: used.has(i) ? "" : p.name,
      labelScale: 0.1,
      data: { type: "pin", kind: p.kind, name: p.name },
    });
  }
  for (const [i, l] of map.locations.entries()) {
    const icon: IconId = l.kind === "boss" ? "loc-boss" : l.kind === "trader" ? "loc-trader" : l.kind === "start" ? "loc-start" : "loc-dungeon";
    const important = l.kind !== "dungeon";
    out.push({
      id: `loc:${i}`,
      layer: "locations",
      icon,
      x: l.x,
      z: l.z,
      priority: important ? 65 : 20,
      tier: 0,
      rank: important ? 200 : 20,
      label: locationName(l.name, l.kind, lookup),
      labelScale: important ? 0.08 : 0.5,
      data: { type: "location", kind: l.kind, name: l.name, placed: l.placed, explored: l.explored },
    });
  }
  // Draw order: low priority first.
  return out.sort((a, b) => a.priority - b.priority);
}

/** The biggest base: the one people call home. */
export function mainBase(markers: readonly Marker[]): Marker | null {
  let best: Marker | null = null;
  for (const m of markers) if (m.data.type === "base" && (!best || m.data.pieces > (best.data as { pieces: number }).pieces)) best = m;
  return best;
}

export function layerCounts(markers: readonly Marker[], map: ApiMap): Record<LayerId, number> {
  const c = Object.fromEntries(LAYERS.map((l) => [l, 0])) as Record<LayerId, number>;
  for (const m of markers) c[m.layer] += m.data.type === "storage" && m.data.stack ? m.data.stack.length : 1;
  c.terrain = map.terrainEdits.length;
  c.fog = map.explored.available ? map.explored.tables : 0;
  c.grid = 0;
  c.relief = 0;
  c.buildings = map.stats.pieces;
  return c;
}

/** Portal pairs as line endpoints, each pair once. */
export function portalLinks(map: ApiMap): [number, number, number, number][] {
  const byId = new Map(map.portals.map((p) => [p.id, p]));
  const out: [number, number, number, number][] = [];
  for (const p of map.portals) {
    const q = p.pairedWith ? byId.get(p.pairedWith) : undefined;
    if (q && p.id < q.id) out.push([p.x, p.z, q.x, q.z]);
  }
  return out;
}

// ---- picking and labels -------------------------------------------------------

export interface ScreenMarker {
  m: Marker;
  sx: number;
  sy: number;
  /** Set when the mark stands for a cluster: every member, the mark itself included. */
  members?: readonly Marker[];
}

/** The marker closest to (sx, sy) within `radius` CSS px, preferring higher priority on ties. */
export function pick(items: readonly ScreenMarker[], sx: number, sy: number, radius = 16): Marker | null {
  return pickItem(items, sx, sy, radius)?.m ?? null;
}

/** Like `pick`, but returns the drawn item, so a cluster comes back with its members. */
export function pickItem(items: readonly ScreenMarker[], sx: number, sy: number, radius = 16): ScreenMarker | null {
  let best: ScreenMarker | null = null;
  let bestD = radius * radius;
  for (const it of items) {
    const d = (it.sx - sx) ** 2 + (it.sy - sy) ** 2;
    if (d < bestD || (d === bestD && best && it.m.priority > best.m.priority)) {
      best = it;
      bestD = d;
    }
  }
  return best;
}

// ---- clusters ---------------------------------------------------------------

export interface Cluster {
  /** The mark drawn for the cluster: the highest tier, then the highest priority. */
  lead: Marker;
  /** Every mark it stands for, the lead first. */
  members: Marker[];
}

/** Marks of another layer join a cluster only when this much closer: they would sit on its icon. */
const CROSS_LAYER = 0.6;

/**
 * Greedy clustering in world space: marks in order of tier and priority each
 * join the nearest cluster within `radius` metres (of the same layer, or a
 * little closer for another layer), or start their own. Computed per zoom
 * level rather than per frame, so a pan never reshuffles it.
 */
export function clusterMarkers(markers: readonly Marker[], radius: number): Cluster[] {
  const order = [...markers].sort((a, b) => b.tier - a.tier || b.priority - a.priority);
  const clusters: Cluster[] = [];
  if (radius <= 0) return order.map((m) => ({ lead: m, members: [m] }));
  const cell = radius;
  const grid = new Map<string, Cluster[]>();
  const key = (cx: number, cz: number) => `${cx},${cz}`;
  for (const m of order) {
    const cx = Math.floor(m.x / cell);
    const cz = Math.floor(m.z / cell);
    let best: Cluster | null = null;
    let bestD = Infinity;
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cz - 1; j <= cz + 1; j++) {
        for (const c of grid.get(key(i, j)) ?? []) {
          const reach = c.lead.layer === m.layer ? radius : radius * CROSS_LAYER;
          const d = Math.hypot(c.lead.x - m.x, c.lead.z - m.z);
          if (d <= reach && d < bestD) {
            best = c;
            bestD = d;
          }
        }
      }
    }
    if (best) best.members.push(m);
    else {
      const c = { lead: m, members: [m] };
      clusters.push(c);
      const k = key(cx, cz);
      const list = grid.get(k);
      if (list) list.push(c);
      else grid.set(k, [c]);
    }
  }
  return clusters;
}

/** World bounds of some marks. */
export function markerBounds(ms: readonly Marker[]): [number, number, number, number] {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const m of ms) {
    x0 = Math.min(x0, m.x);
    z0 = Math.min(z0, m.z);
    x1 = Math.max(x1, m.x);
    z1 = Math.max(z1, m.z);
  }
  return [x0, z0, x1, z1];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedLabel extends Box {
  text: string;
  /** Text anchor inside the box. */
  align: "left" | "right" | "center";
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Greedy label placement: highest priority first, each tries right, left,
 * above and below its icon, then three corners, and takes the first spot that collides with no
 * placed label and no icon. `measure` returns a text width in CSS px.
 */
export function placeLabels(
  items: readonly { sx: number; sy: number; text: string; priority: number; r?: number }[],
  icons: readonly Box[],
  measure: (text: string) => number,
  opts: { iconRadius?: number; lineHeight?: number; max?: number; bounds?: { w: number; h: number } } = {},
): PlacedLabel[] {
  const lh = opts.lineHeight ?? 15;
  const placed: PlacedLabel[] = [];
  // A coarse grid keeps collision checks near-constant per label.
  const cell = 64;
  const grid = new Map<number, Box[]>();
  const key = (cx: number, cy: number) => cx * 73856093 + cy * 19349663;
  const cellsOf = (b: Box) => {
    const out: number[] = [];
    for (let cx = Math.floor(b.x / cell); cx <= Math.floor((b.x + b.w) / cell); cx++) {
      for (let cy = Math.floor(b.y / cell); cy <= Math.floor((b.y + b.h) / cell); cy++) out.push(key(cx, cy));
    }
    return out;
  };
  const add = (b: Box) => {
    for (const k of cellsOf(b)) {
      const list = grid.get(k);
      if (list) list.push(b);
      else grid.set(k, [b]);
    }
  };
  const free = (b: Box) => cellsOf(b).every((k) => !(grid.get(k) ?? []).some((o) => overlaps(o, b)));
  for (const ic of icons) add(ic);
  const order = [...items].sort((a, b) => b.priority - a.priority);
  for (const it of order) {
    if (opts.max !== undefined && placed.length >= opts.max) break;
    if (!it.text) continue;
    const w = measure(it.text) + 6;
    // Each label clears its own icon: bigger bases and counted clusters reach further.
    const r = it.r ?? opts.iconRadius ?? 11;
    const tries: PlacedLabel[] = [
      { x: it.sx + r + 2, y: it.sy - lh / 2, w, h: lh, text: it.text, align: "left" },
      { x: it.sx - r - 2 - w, y: it.sy - lh / 2, w, h: lh, text: it.text, align: "right" },
      { x: it.sx - w / 2, y: it.sy - r - lh - 1, w, h: lh, text: it.text, align: "center" },
      { x: it.sx - w / 2, y: it.sy + r + 1, w, h: lh, text: it.text, align: "center" },
      // Then the corners, for crowded spots.
      { x: it.sx + r - 2, y: it.sy + r * 0.4, w, h: lh, text: it.text, align: "left" },
      { x: it.sx - r + 2 - w, y: it.sy + r * 0.4, w, h: lh, text: it.text, align: "right" },
      { x: it.sx - r + 2 - w, y: it.sy - r * 0.4 - lh, w, h: lh, text: it.text, align: "right" },
    ];
    const b = opts.bounds;
    // On screen, or it might as well not be placed (a label cut by the edge reads as noise).
    const spot = tries.find((t) => (!b || (t.x >= 2 && t.y >= 2 && t.x + t.w <= b.w - 2 && t.y + t.h <= b.h - 2)) && free(t));
    if (spot) {
      placed.push(spot);
      add(spot);
    }
  }
  return placed;
}

// ---- search -----------------------------------------------------------------

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[łŁ]/g, "l").toLowerCase();

/** The container a mark stands for: a chest, a built cart or ship. */
export function markerStore(m: Marker): MapContainer | undefined {
  return m.data.type === "storage" ? m.data.store : m.data.type === "vehicle" ? m.data.store : undefined;
}

/** What a mark holds: a container's items (every chest of a stack) or a grave's. */
export function markerItems(m: Marker): readonly MapItem[] | undefined {
  if (m.data.type === "storage" && m.data.stack) return m.data.stack.flatMap((c) => c.items);
  return m.data.type === "grave" ? m.data.items : markerStore(m)?.items;
}

/** The containers a mark stands for: every chest of a stack, or its one container. */
export function markerStores(m: Marker): readonly MapContainer[] {
  if (m.data.type === "storage") return m.data.stack ?? [m.data.store];
  const s = markerStore(m);
  return s ? [s] : [];
}

/** Markers whose label, owner, tag or kind name contains the query, best first. */
export function searchMarkers(markers: readonly Marker[], query: string, kindName: (m: Marker) => string, limit = 8): Marker[] {
  const q = fold(query.trim());
  if (!q) return [];
  const scored: [number, Marker][] = [];
  for (const m of markers) {
    const text = fold(`${m.label} ${kindName(m)}`);
    const at = text.indexOf(q);
    if (at < 0) continue;
    // Prefix matches on the label first, then by importance.
    const score = (fold(m.label).startsWith(q) ? 1000 : 0) + m.priority - at;
    scored.push([score, m]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, m]) => m);
}

/**
 * Bounds of what people made and where they fell (bases, portals, graves), for
 * the first view when there is no fog to go by. Pins only when there is
 * nothing else: they are often far-flung notes.
 */
export function interestBounds(map: ApiMap): [number, number, number, number] | null {
  let pts: { x: number; z: number }[] = [...map.bases, ...map.portals, ...map.tombstones];
  if (pts.length === 0) pts = map.pins;
  if (pts.length === 0) return null;
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const { x, z } of pts) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return [x0, z0, x1, z1];
}

/** World bounds of the explored area (the mask is row-major from the south-west), or null when nothing is. */
export function exploredBounds(mask: Uint8Array | null, size: number, mpp: number): [number, number, number, number] | null {
  if (!mask) return null;
  let c0 = Infinity;
  let r0 = Infinity;
  let c1 = -Infinity;
  let r1 = -Infinity;
  for (let r = 0; r < size; r++) {
    const row = r * size;
    let first = -1;
    let last = -1;
    for (let c = 0; c < size; c++) {
      if (mask[row + c]) {
        if (first < 0) first = c;
        last = c;
      }
    }
    if (first < 0) continue;
    r0 = Math.min(r0, r);
    r1 = r;
    c0 = Math.min(c0, first);
    c1 = Math.max(c1, last);
  }
  if (r0 === Infinity) return null;
  const w = (i: number) => (i - size / 2) * mpp;
  return [w(c0), w(r0), w(c1), w(r1)];
}
