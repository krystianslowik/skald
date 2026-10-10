// World-map geometry and data shaping: decoders for the agent's compact
// encodings, the view transform, coastlines by marching squares, markers,
// label placement, picking and search. No DOM and no canvas here, so all of
// it is testable in jsdom.
//
// Orientation: world x grows east, world z grows north. On screen north is
// up, so screen y = centre - (z - cz) * scale. The land grid and the
// explored mask are both row-major from the south-west corner.

import type { ApiMap, MapLand, MapLocation } from "../types";

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

function blur3(src: Float32Array, n: number): Float32Array {
  const out = new Float32Array(src.length);
  const k = [1, 2, 1];
  const tmp = new Float32Array(src.length);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      let w = 0;
      for (let d = -1; d <= 1; d++) {
        const ii = i + d;
        if (ii < 0 || ii >= n) continue;
        s += src[j * n + ii]! * k[d + 1]!;
        w += k[d + 1]!;
      }
      tmp[j * n + i] = s / w;
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      let w = 0;
      for (let d = -1; d <= 1; d++) {
        const jj = j + d;
        if (jj < 0 || jj >= n) continue;
        s += tmp[jj * n + i]! * k[d + 1]!;
        w += k[d + 1]!;
      }
      out[j * n + i] = s / w;
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

export const MAX_SCALE = 6;

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

// ---- markers ---------------------------------------------------------------

export type LayerId = "fog" | "bases" | "portals" | "graves" | "beds" | "vehicles" | "pins" | "locations" | "terrain" | "grid";

export const LAYERS: readonly LayerId[] = ["fog", "bases", "portals", "graves", "beds", "vehicles", "pins", "locations", "terrain", "grid"];

export const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  fog: true,
  bases: true,
  portals: true,
  graves: true,
  beds: false,
  vehicles: true,
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
  | { type: "base"; pieces: number; hasBed: boolean; stations: string[]; zones: number }
  | { type: "portal"; tag: string; pairedWith?: string; partnerTag?: string; partner?: { x: number; z: number } }
  | { type: "grave"; owner: string; day: number }
  | { type: "bed"; owner: string }
  | { type: "vehicle"; kind: string }
  | { type: "pin"; kind: string; name: string }
  | { type: "location"; kind: MapLocation["kind"]; name: string; placed: boolean; explored: boolean };

export interface Marker {
  id: string;
  layer: LayerId;
  icon: IconId;
  x: number;
  z: number;
  /** Higher draws later and wins label space. */
  priority: number;
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

export function buildMarkers(map: ApiMap, lookup: (key: string) => string | undefined): Marker[] {
  const out: Marker[] = [];
  const byId = new Map(map.portals.map((p) => [p.id, p]));
  for (const [i, b] of map.bases.entries()) {
    out.push({
      id: `base:${i}`,
      layer: "bases",
      icon: "base",
      x: b.x,
      z: b.z,
      priority: 50 + Math.min(40, Math.log2(b.pieces + 1) * 4),
      label: "",
      labelScale: Infinity,
      data: { type: "base", pieces: b.pieces, hasBed: b.hasBed, stations: b.stations, zones: b.zones },
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
      label: p.tag,
      labelScale: 0.07,
      data: { type: "portal", tag: p.tag, pairedWith: p.pairedWith, partnerTag: partner?.tag, partner: partner ? { x: partner.x, z: partner.z } : undefined },
    });
  }
  for (const [i, g] of map.tombstones.entries()) {
    out.push({ id: `grave:${i}`, layer: "graves", icon: "grave", x: g.x, z: g.z, priority: 60, label: g.owner, labelScale: 0.3, data: { type: "grave", owner: g.owner, day: g.day } });
  }
  for (const [i, b] of map.beds.entries()) {
    out.push({ id: `bed:${i}`, layer: "beds", icon: "bed", x: b.x, z: b.z, priority: 30, label: b.owner, labelScale: 1.2, data: { type: "bed", owner: b.owner } });
  }
  for (const [i, v] of map.vehicles.entries()) {
    out.push({
      id: `vehicle:${i}`,
      layer: "vehicles",
      icon: VEHICLE_ICON(v.kind),
      x: v.x,
      z: v.z,
      priority: 40,
      label: lookup(`map.vehicle.${v.kind}`) ?? v.kind,
      labelScale: 0.6,
      data: { type: "vehicle", kind: v.kind },
    });
  }
  for (const [i, p] of map.pins.entries()) {
    out.push({
      id: `pin:${i}`,
      layer: "pins",
      icon: PIN_ICONS[p.kind] ?? "pin-point",
      x: p.x,
      z: p.z,
      priority: 55,
      label: p.name,
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
      label: locationName(l.name, l.kind, lookup),
      labelScale: important ? 0.08 : 0.5,
      data: { type: "location", kind: l.kind, name: l.name, placed: l.placed, explored: l.explored },
    });
  }
  // Draw order: low priority first.
  return out.sort((a, b) => a.priority - b.priority);
}

export function layerCounts(markers: readonly Marker[], map: ApiMap): Record<LayerId, number> {
  const c = Object.fromEntries(LAYERS.map((l) => [l, 0])) as Record<LayerId, number>;
  for (const m of markers) c[m.layer]++;
  c.terrain = map.terrainEdits.length;
  c.fog = map.explored.available ? map.explored.tables : 0;
  c.grid = 0;
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
}

/** The marker closest to (sx, sy) within `radius` CSS px, preferring higher priority on ties. */
export function pick(items: readonly ScreenMarker[], sx: number, sy: number, radius = 16): Marker | null {
  let best: ScreenMarker | null = null;
  let bestD = radius * radius;
  for (const it of items) {
    const d = (it.sx - sx) ** 2 + (it.sy - sy) ** 2;
    if (d < bestD || (d === bestD && best && it.m.priority > best.m.priority)) {
      best = it;
      bestD = d;
    }
  }
  return best?.m ?? null;
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
 * above and below its icon and takes the first spot that collides with no
 * placed label and no icon. `measure` returns a text width in CSS px.
 */
export function placeLabels(
  items: readonly { sx: number; sy: number; text: string; priority: number }[],
  icons: readonly Box[],
  measure: (text: string) => number,
  opts: { iconRadius?: number; lineHeight?: number; max?: number } = {},
): PlacedLabel[] {
  const r = opts.iconRadius ?? 11;
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
    const tries: PlacedLabel[] = [
      { x: it.sx + r + 2, y: it.sy - lh / 2, w, h: lh, text: it.text, align: "left" },
      { x: it.sx - r - 2 - w, y: it.sy - lh / 2, w, h: lh, text: it.text, align: "right" },
      { x: it.sx - w / 2, y: it.sy - r - lh - 1, w, h: lh, text: it.text, align: "center" },
      { x: it.sx - w / 2, y: it.sy + r + 1, w, h: lh, text: it.text, align: "center" },
    ];
    const spot = tries.find(free);
    if (spot) {
      placed.push(spot);
      add(spot);
    }
  }
  return placed;
}

// ---- search -----------------------------------------------------------------

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

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

/** Bounds of everything people made or found, for the first view. */
export function interestBounds(map: ApiMap): [number, number, number, number] | null {
  const pts: [number, number][] = [
    ...map.bases.map((b) => [b.x, b.z] as [number, number]),
    ...map.portals.map((p) => [p.x, p.z] as [number, number]),
    ...map.tombstones.map((p) => [p.x, p.z] as [number, number]),
    ...map.pins.map((p) => [p.x, p.z] as [number, number]),
  ];
  if (pts.length === 0) return null;
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of pts) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return [x0, z0, x1, z1];
}
