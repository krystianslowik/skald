// Inputs for the terrain shader's close-zoom detail (mapgl.ts TILE_FS): how
// far the detail is faded in at a zoom, and the world-anchored noise it reads.

/** The zoom (CSS px per metre) where close-zoom detail starts to show, and where it is fully in. */
export const DETAIL_FROM = 3;
export const DETAIL_TO = 12;

/** How much close-zoom detail a view at `scale` CSS px per metre shows: 0 at DETAIL_FROM and wider, 1 at DETAIL_TO and closer, even in log zoom between. */
export function detailAt(scale: number): number {
  if (!(scale > 0)) return 0;
  const t = Math.log2(scale / DETAIL_FROM) / Math.log2(DETAIL_TO / DETAIL_FROM);
  return Math.min(1, Math.max(0, t));
}

// How strongly each part of the close-zoom detail shows at full detail (uDetail 1), for tuning.
/** Micro relief: noise added to the height's gradient (scaled by each biome's roughness). */
export const MICRO_RELIEF = 0.3;
/** Biome grain: a multiplier on each biome's tone variation (meadow mottle, litter, combed grass...). */
export const GRAIN = 1;
/** Bare rock on slopes steeper than about 45 degrees: how far the ground turns to stone. */
export const ROCK = 0.6;
/** Contour lines, as ink over the ground: every 2 m, and every 10 m. */
export const CONTOUR_2M = 0.16;
export const CONTOUR_10M = 0.32;

/** The noise texture's side in texels. */
export const NOISE_SIZE = 128;

let cached: Uint8Array<ArrayBuffer> | null = null;

/**
 * A tileable noise texture, NOISE_SIZE a side, four bytes a texel, the same
 * on every device. R: a smooth value-noise fbm (4 cells a side, five
 * octaves); G: a finer one (16 cells, four octaves); B: the distance to the
 * nearest of 8 x 8 jittered points (Voronoi F1) and A: the gap to the second
 * nearest (F2 - F1, near 0 along the cell walls), both in cells. R and G are
 * stretched to span 0..255. R is the field the terrain's border nudge has
 * always read, at every zoom, unchanged. Built once per page, in about 10 ms
 * on a laptop.
 */
export function noiseTexture(): Uint8Array<ArrayBuffer> {
  if (cached) return cached;
  const N = NOISE_SIZE;
  const hash = (x: number, y: number, s: number) => {
    let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const wrap = (i: number, per: number) => ((i % per) + per) % per;
  // An fbm's octaves: per x per lattice values each, hashed once, wrapping.
  const octaves = (base: number, count: number, s: number) =>
    Array.from({ length: count }, (_, o) => {
      const per = base * 2 ** o;
      const l = new Float64Array(per * per);
      for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) l[j * per + i] = hash(i, j, s + o);
      return { per, l, amp: 0.5 ** o };
    });
  const fbm = (x: number, y: number, oct: readonly { per: number; l: Float64Array; amp: number }[]) => {
    let a = 0;
    let tot = 0;
    for (const { per, l, amp } of oct) {
      const u = (x * per) / N;
      const v = (y * per) / N;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const i0 = wrap(x0, per);
      const i1 = wrap(x0 + 1, per);
      const j0 = wrap(y0, per) * per;
      const j1 = wrap(y0 + 1, per) * per;
      a += amp * ((l[j0 + i0]! * (1 - sx) + l[j0 + i1]! * sx) * (1 - sy) + (l[j1 + i0]! * (1 - sx) + l[j1 + i1]! * sx) * sy);
      tot += amp;
    }
    return a / tot;
  };
  const smooth = octaves(4, 5, 7);
  const fine = octaves(16, 4, 31);
  const CELLS = 8;
  const cell = N / CELLS;
  const pts: [number, number][] = [];
  for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) pts.push([(i + 0.15 + 0.7 * hash(i, j, 91)) * cell, (j + 0.15 + 0.7 * hash(i, j, 92)) * cell]);
  const R = new Float32Array(N * N);
  const G = new Float32Array(N * N);
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      R[i] = fbm(x, y, smooth);
      G[i] = fbm(x, y, fine);
      let d1 = 1e9;
      let d2 = 1e9;
      const ci = Math.floor(x / cell);
      const cj = Math.floor(y / cell);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = ci + di;
          const jj = cj + dj;
          const p = pts[wrap(jj, CELLS) * CELLS + wrap(ii, CELLS)]!;
          const dx = p[0] + Math.floor(ii / CELLS) * N - x - 0.5;
          const dy = p[1] + Math.floor(jj / CELLS) * N - y - 0.5;
          const d = dx * dx + dy * dy;
          if (d < d1) {
            d2 = d1;
            d1 = d;
          } else if (d < d2) d2 = d;
        }
      }
      d1 = Math.sqrt(d1);
      d2 = Math.sqrt(d2);
      out[4 * i + 2] = Math.min(255, Math.round((d1 / cell) * 255));
      out[4 * i + 3] = Math.min(255, Math.round(((d2 - d1) / cell) * 255));
    }
  }
  const span = (v: Float32Array) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of v) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    return [lo, hi - lo] as const;
  };
  const [r0, rs] = span(R);
  const [g0, gs] = span(G);
  for (let i = 0; i < N * N; i++) {
    out[4 * i] = Math.round(((R[i]! - r0) / rs) * 255);
    out[4 * i + 1] = Math.round(((G[i]! - g0) / gs) * 255);
  }
  cached = out;
  return out;
}
