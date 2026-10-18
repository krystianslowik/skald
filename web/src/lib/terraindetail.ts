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

/** The noise texture's side in texels. */
export const NOISE_SIZE = 128;

let cached: Uint8Array<ArrayBuffer> | null = null;

/**
 * A tileable noise texture, NOISE_SIZE a side, one byte a texel, the same on
 * every device: a smooth value-noise fbm (4 cells a side, five octaves),
 * stretched to span 0..255. Built once, in about 5 ms on a laptop. Finer
 * ground detail can add channels here (finer fbm, cell distances) as it
 * needs them.
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
  const vnoise = (x: number, y: number, per: number, s: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const h = (i: number, j: number) => hash(wrap(i, per), wrap(j, per), s);
    return (h(x0, y0) * (1 - sx) + h(x0 + 1, y0) * sx) * (1 - sy) + (h(x0, y0 + 1) * (1 - sx) + h(x0 + 1, y0 + 1) * sx) * sy;
  };
  const fbm = (x: number, y: number, base: number, octaves: number, s: number) => {
    let a = 0;
    let amp = 1;
    let tot = 0;
    let per = base;
    for (let o = 0; o < octaves; o++) {
      a += amp * vnoise((x * per) / N, (y * per) / N, per, s + o);
      tot += amp;
      amp *= 0.5;
      per *= 2;
    }
    return a / tot;
  };
  const v = new Float32Array(N * N);
  let lo = 1;
  let hi = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const r = fbm(x, y, 4, 5, 7);
      v[y * N + x] = r;
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
  }
  const out = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) out[i] = Math.round(((v[i]! - lo) / (hi - lo)) * 255);
  cached = out;
  return out;
}
