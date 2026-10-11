// The parchment's own textures: a paper tile and a cloud tile for the fog,
// from seamless value noise. Pure pixels, so they are made in the map worker:
// a few hundred thousand noise samples are too many for a phone's main thread
// when the map opens.

export const PAPER_TILE = 256;
export const CLOUD_TILE = 512;

export interface Textures {
  paper: Uint8ClampedArray<ArrayBuffer>;
  clouds: Uint8ClampedArray<ArrayBuffer>;
}

export function textures(): Textures {
  return { paper: paperPixels(), clouds: cloudPixels() };
}

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

/** A seamless paper tile, RGBA: fibres, blotches and specks, as alpha over the paper colour. */
export function paperPixels(size = PAPER_TILE): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(size * size * 4);
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
      data[i] = 92;
      data[i + 1] = 64;
      data[i + 2] = 32;
      data[i + 3] = Math.min(255, a * 255);
    }
  }
  return data;
}

/** Cloudy paper for the fog, RGBA: light, with soft billows. */
export function cloudPixels(size = CLOUD_TILE): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(size * size * 4);
  const cells = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = tiledNoise((x / size) * cells, (y / size) * cells, cells, 5, 21);
      const i = (y * size + x) * 4;
      const l = 0.86 + (n - 0.5) * 0.22;
      data[i] = Math.min(255, 236 * l);
      data[i + 1] = Math.min(255, 224 * l);
      data[i + 2] = Math.min(255, 196 * l);
      data[i + 3] = 255;
    }
  }
  return data;
}
