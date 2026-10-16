// Fields for the WebGL map, built in the map worker once per snapshot: the
// fog as a signed distance field from the explored area's traced outline
// (the same rings the Canvas2D map clips with), so the GPU can draw its edge
// sharp at any zoom and its soft rim a fixed number of screen pixels wide;
// and the generated zones as a smooth mask, the clip for terrain without
// spoilers.

import type { MapLand } from "../types";
import { landFields, WORLD_RADIUS } from "./mapgeo";

/**
 * Signed distance in metres to the explored area's edge, positive in the
 * fog. Texel (i, j) is centred on (x0 + (i + 0.5) * cell, z0 + (j + 0.5) *
 * cell); outside the field everything is fog, far from any edge.
 */
export interface FogField {
  data: Float32Array<ArrayBuffer>;
  w: number;
  h: number;
  x0: number;
  z0: number;
  cell: number;
}

/** Generated zones, 0..255, smooth; texel i is centred on origin + i * step (as the Canvas2D map's marching squares). */
export interface SeaMask {
  data: Uint8Array<ArrayBuffer>;
  n: number;
  origin: number;
  step: number;
}

/** How far past the explored area the field reaches: beyond the widest fog rim. */
const MARGIN = 900;
/** Within this many cells of the edge the distance is exact, to the outline's own segments. */
const EXACT = 3;
const INF = 1e20;

/** Felzenszwalb's 1D squared distance transform of grid (length n, stride s from o), in place (as mapbox's tiny-sdf). */
function edt1(grid: Float64Array, o: number, s: number, n: number, f: Float64Array, v: Int32Array, z: Float64Array) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[o]!;
  for (let q = 1, k = 0, x = 0; q < n; q++) {
    f[q] = grid[o + q * s]!;
    do {
      const r = v[k]!;
      x = (f[q]! - f[r]! + q * q - r * r) / (q - r) / 2;
    } while (x <= z[k]! && --k > -1);
    k++;
    v[k] = q;
    z[k] = x;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const r = v[k]!;
    grid[o + q * s] = f[r]! + (q - r) * (q - r);
  }
}

/** Squared distance, in cells, from every cell to the nearest seed (seed cells hold 0, others INF). */
function edt2(f: Float64Array, w: number, h: number) {
  const n = Math.max(w, h);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let i = 0; i < w; i++) edt1(f, i, w, h, d, v, z);
  for (let j = 0; j < h; j++) edt1(f, j * w, 1, w, d, v, z);
}

/** Squared distance from point (px, pz) to segment a-b. */
function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l = dx * dx + dz * dz;
  let t = l > 0 ? ((px - ax) * dx + (pz - az) * dz) / l : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px;
  const ez = az + dz * t - pz;
  return ex * ex + ez * ez;
}

/**
 * The fog field for the explored area's closed outline `rings` (world
 * units, filled even-odd), at `cell` metres a texel, at most `maxDim`
 * texels a side (coarser cells otherwise). Null when nothing is explored.
 */
export function fogField(rings: readonly Float32Array[], cell: number, maxDim = 2048, radius = WORLD_RADIUS): FogField | null {
  let bx0 = Infinity;
  let bz0 = Infinity;
  let bx1 = -Infinity;
  let bz1 = -Infinity;
  let segs = 0;
  for (const r of rings) {
    segs += r.length / 2;
    for (let i = 0; i < r.length; i += 2) {
      bx0 = Math.min(bx0, r[i]!);
      bx1 = Math.max(bx1, r[i]!);
      bz0 = Math.min(bz0, r[i + 1]!);
      bz1 = Math.max(bz1, r[i + 1]!);
    }
  }
  if (!segs || !(cell > 0)) return null;
  const lim = radius + MARGIN;
  bx0 = Math.max(-lim, bx0 - MARGIN);
  bz0 = Math.max(-lim, bz0 - MARGIN);
  bx1 = Math.min(lim, bx1 + MARGIN);
  bz1 = Math.min(lim, bz1 + MARGIN);
  while ((bx1 - bx0) / cell > maxDim || (bz1 - bz0) / cell > maxDim) cell *= 2;
  const w = Math.max(2, Math.ceil((bx1 - bx0) / cell));
  const h = Math.max(2, Math.ceil((bz1 - bz0) / cell));
  const x0 = bx0;
  const z0 = bz0;
  // Segments, flat: ax, az, bx, bz.
  const seg = new Float64Array(segs * 4);
  let s = 0;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      seg[s++] = r[2 * i]!;
      seg[s++] = r[2 * i + 1]!;
      seg[s++] = r[2 * j]!;
      seg[s++] = r[2 * j + 1]!;
    }
  }
  // Inside or out at every texel centre: even-odd scanlines, crossings bucketed by row.
  const rowOf = (z: number) => (z - z0) / cell - 0.5;
  const count = new Int32Array(h + 1);
  const span = (a: number, b: number): [number, number] => [Math.max(0, Math.ceil(rowOf(Math.min(a, b)))), Math.min(h - 1, Math.ceil(rowOf(Math.max(a, b))) - 1)];
  for (let k = 0; k < segs; k++) {
    const [j0, j1] = span(seg[4 * k + 1]!, seg[4 * k + 3]!);
    for (let j = j0; j <= j1; j++) count[j + 1]!++;
  }
  for (let j = 0; j < h; j++) count[j + 1]! += count[j]!;
  const xs = new Float64Array(count[h]!);
  const fill = count.slice(0, h);
  for (let k = 0; k < segs; k++) {
    const ax = seg[4 * k]!;
    const az = seg[4 * k + 1]!;
    const bx = seg[4 * k + 2]!;
    const bz = seg[4 * k + 3]!;
    const [j0, j1] = span(az, bz);
    for (let j = j0; j <= j1; j++) {
      const zc = z0 + (j + 0.5) * cell;
      xs[fill[j]!++] = ax + ((zc - az) / (bz - az)) * (bx - ax);
    }
  }
  const inside = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const row = xs.subarray(count[j]!, count[j + 1]!).sort();
    for (let q = 0; q + 1 < row.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((row[q]! - x0) / cell - 0.5));
      const i1 = Math.min(w - 1, Math.ceil((row[q + 1]! - x0) / cell - 0.5) - 1);
      for (let i = i0; i <= i1; i++) inside[j * w + i] = 1;
    }
  }
  // Distance from each cell to the nearest cell of the other side, then the
  // edge half a cell short of it.
  const out = new Float64Array(w * h);
  const inn = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    out[i] = inside[i] ? 0 : INF;
    inn[i] = inside[i] ? INF : 0;
  }
  edt2(out, w, h);
  edt2(inn, w, h);
  const data = new Float32Array(w * h);
  const cap = (Math.max(w, h) + 1) * cell;
  for (let i = 0; i < w * h; i++) {
    const d = inside[i] ? -(Math.sqrt(inn[i]!) - 0.5) : Math.sqrt(out[i]!) - 0.5;
    data[i] = Math.max(-cap, Math.min(cap, d * cell));
  }
  // Near the edge, the true distance to the outline's segments: the edge then
  // follows the traced curve between texels instead of the cells' staircase.
  const B = 8;
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const bcount = new Int32Array(bw * bh + 1);
  const reach = (EXACT + 1) * cell;
  const cells = (k: number) => {
    const ax = seg[4 * k]!;
    const az = seg[4 * k + 1]!;
    const bx = seg[4 * k + 2]!;
    const bz = seg[4 * k + 3]!;
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / cell / B));
    const c1 = Math.min(bw - 1, Math.floor((Math.max(ax, bx) + reach - x0) / cell / B));
    const r0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - z0) / cell / B));
    const r1 = Math.min(bh - 1, Math.floor((Math.max(az, bz) + reach - z0) / cell / B));
    return [c0, c1, r0, r1] as const;
  };
  for (let k = 0; k < segs; k++) {
    const [c0, c1, r0, r1] = cells(k);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) bcount[r * bw + c + 1]!++;
  }
  for (let b = 0; b < bw * bh; b++) bcount[b + 1]! += bcount[b]!;
  const bseg = new Int32Array(bcount[bw * bh]!);
  const bfill = bcount.slice(0, bw * bh);
  for (let k = 0; k < segs; k++) {
    const [c0, c1, r0, r1] = cells(k);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) bseg[bfill[r * bw + c]!++] = k;
  }
  for (let j = 0; j < h; j++) {
    const pz = z0 + (j + 0.5) * cell;
    for (let i = 0; i < w; i++) {
      const at = j * w + i;
      if (Math.abs(data[at]!) > EXACT * cell) continue;
      const px = x0 + (i + 0.5) * cell;
      const b = ((j / B) | 0) * bw + ((i / B) | 0);
      let best = INF;
      for (let q = bcount[b]!; q < bcount[b + 1]!; q++) {
        const k = bseg[q]!;
        const d2 = segDist2(px, pz, seg[4 * k]!, seg[4 * k + 1]!, seg[4 * k + 2]!, seg[4 * k + 3]!);
        if (d2 < best) best = d2;
      }
      if (best < INF) data[at] = (inside[at] ? -1 : 1) * Math.sqrt(best);
    }
  }
  return { data, w, h, x0, z0, cell };
}

/** The generated zones of the save's land grid, as the Canvas2D map's clip traces them. */
export function seaMask(land: MapLand): SeaMask {
  const f = landFields(land);
  const data = new Uint8Array(f.size * f.size);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(f.generated[i]! * 255);
  return { data, n: f.size, origin: f.origin, step: f.step };
}
