// Paints one terrain tile (the agent's /terrain/tile, the bridge's binary
// format) into RGBA pixels, the same way at every level so a place has one
// colour at every zoom: biome colour, forest darkening, hillshade and water
// by depth. Runs in the tile worker; pure, so it is tested directly.
//
// The colours are the game's own minimap colours when the bridge could read
// them (tiles.json palette.source "instance" or "prefab"); a dedicated server
// usually has no minimap, and then the tuned values below are used. They are
// ours, picked by eye to sit close to the game's map, not copied from it.

export const TILE_MAGIC = 0x31544b53;
const HEADER = 24;
/** Flag: heights packed by the agent for gzip (agent/internal/terrain packHeights). */
const PACKED = 4;

export interface DecodedTile {
  n: number;
  x0: number;
  z0: number;
  step: number;
  biomes: Uint8Array;
  heights: Uint16Array;
  /** 0..255 per sample, or null when the tile has no forest channel (grid levels). */
  forest: Uint8Array | null;
}

/** Parses an ungzipped tile; throws on anything that is not one. */
export function decodeTile(buf: ArrayBuffer): DecodedTile {
  const dv = new DataView(buf);
  if (buf.byteLength < HEADER || dv.getUint32(0, true) !== TILE_MAGIC || dv.getUint16(4, true) !== 1) throw new Error("not a terrain tile");
  const flags = dv.getUint16(6, true);
  const n = dv.getInt32(8, true);
  const nn = n * n;
  const hasForest = (flags & 1) !== 0;
  if (n < 3 || n > 1024 || buf.byteLength !== HEADER + nn * (hasForest ? 4 : 3)) throw new Error("terrain tile of the wrong size");
  const heights = new Uint16Array(nn);
  if (flags & PACKED) {
    // The agent's packing: west-to-east deltas, low byte plane then high.
    const lo = new Uint8Array(buf, HEADER + nn, nn);
    const hi = new Uint8Array(buf, HEADER + 2 * nn, nn);
    for (let r = 0; r < n; r++) {
      let v = 0;
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        v = (v + (lo[i]! | (hi[i]! << 8))) & 0xffff;
        heights[i] = v;
      }
    }
  } else {
    for (let i = 0; i < nn; i++) heights[i] = dv.getUint16(HEADER + nn + 2 * i, true);
  }
  return {
    n,
    x0: dv.getFloat32(12, true),
    z0: dv.getFloat32(16, true),
    step: dv.getFloat32(20, true),
    biomes: new Uint8Array(buf, HEADER, nn),
    heights,
    forest: hasForest ? new Uint8Array(buf, HEADER + 3 * nn, nn) : null,
  };
}

type RGB = readonly [number, number, number];

/** Biome index order of the tiles (TerrainTile.BiomeNames). */
export const BIOMES = ["None", "Meadows", "Swamp", "Mountain", "BlackForest", "Plains", "AshLands", "DeepNorth", "Ocean", "Mistlands"] as const;

/** Tuned colours, close to the game's map; used when the bridge has no palette. */
export const TUNED: Record<(typeof BIOMES)[number], RGB> = {
  None: [128, 116, 92],
  Meadows: [142, 166, 82],
  // A dark, muddy olive brown: the swamp's ground is mostly at the water line.
  Swamp: [98, 86, 58],
  Mountain: [226, 226, 232],
  BlackForest: [84, 108, 62],
  Plains: [200, 180, 104],
  AshLands: [128, 52, 38],
  DeepNorth: [214, 226, 236],
  Ocean: [64, 94, 112],
  Mistlands: [104, 96, 112],
};
const WATER_SHALLOW: RGB = [84, 120, 124];
const WATER_DEEP: RGB = [30, 52, 74];
/**
 * How much of a biome is forest on average, for tiles without a forest
 * channel (levels from the terrain Job's grid), so their colour matches the
 * bridge's tiles of the same place.
 */
const MEAN_FOREST: Partial<Record<(typeof BIOMES)[number], number>> = { Meadows: 0.25, BlackForest: 0.85, Swamp: 0.35, Plains: 0.15, Mistlands: 0.4 };
const FOREST_DARKEN = 0.32;
const SWAMP = BIOMES.indexOf("Swamp");
/** Relief exaggeration: the same at every level, so shading does not change with zoom. */
const RELIEF = 2.2;

export interface Palette {
  /** RGB per biome index. */
  biome: RGB[];
  meanForest: number[];
}

function hex(s: string | undefined): RGB | null {
  const m = /^#([0-9a-f]{6})$/i.exec(s ?? "");
  if (!m) return null;
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** The palette for tiles.json's `palette`: the game's colours where given, tuned ones elsewhere. */
export function paletteOf(game?: { source?: string; biomes?: Record<string, string> } | null): Palette {
  const useGame = !!game && game.source !== "none" && !!game.biomes;
  return {
    biome: BIOMES.map((b) => (useGame ? hex(game!.biomes![b]) : null) ?? TUNED[b]),
    meanForest: BIOMES.map((b) => MEAN_FOREST[b] ?? 0),
  };
}

/** Quadratic B-spline weights of the four samples at offsets -1..2 from a cell at fraction f. */
function spline(f: number, w: Float32Array) {
  for (let k = 0; k < 4; k++) {
    const d = Math.abs(k - 1 - f);
    w[k] = d < 0.5 ? 0.75 - d * d : d < 1.5 ? 0.5 * (1.5 - d) * (1.5 - d) : 0;
  }
}

/** Mean colour of biome `b`'s samples among the 4 x 4 around cell (r0, c0), weighted by the kernel, into `out`. */
function biomeColour(biomes: Uint8Array, col: Float32Array, n: number, r0: number, c0: number, b: number, kx: Float32Array, kz: Float32Array, out: Float32Array) {
  let R = 0, G = 0, B = 0, ws = 0;
  for (let a = 0; a < 4; a++) {
    const row = (r0 - 1 + a) * n + c0 - 1;
    for (let q = 0; q < 4; q++) {
      const i = row + q;
      if (biomes[i] !== b) continue;
      const w = kz[a]! * kx[q]!;
      R += col[3 * i]! * w;
      G += col[3 * i + 1]! * w;
      B += col[3 * i + 2]! * w;
      ws += w;
    }
  }
  out[0] = R / ws;
  out[1] = G / ws;
  out[2] = B / ws;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface PaintOptions {
  /** Output pixels per tile pixel (1, 2 or 4): finer biome edges and coasts. */
  factor: number;
  palette: Palette;
  waterLevel: number;
  /** The world's radius: outside it is transparent. */
  radius: number;
  /** Samples around the tile on each side (tiles.json apron); 2 when left out. */
  apron?: number;
}

/**
 * RGBA pixels, (size*factor)^2, north up, for the tile's inner size x size
 * samples (the apron only feeds shading and edges). Heights are
 * interpolated between samples, so coasts are smooth curves; near a biome
 * border the pixel takes the biome with the most weight under a smooth
 * kernel over the samples around it, so borders are curves instead of
 * blocks, and colour is only blended within a biome, so they stay sharp.
 */
export function paintTile(t: DecodedTile, o: PaintOptions): Uint8ClampedArray<ArrayBuffer> {
  const { n, step } = t;
  const apron = o.apron ?? 2;
  const size = n - 2 * apron;
  const f = o.factor;
  const S = size * f;
  const out = new Uint8ClampedArray(S * S * 4);
  // Per sample: height in metres, the forest value and the land colour:
  // biome and hillshade. Slopes are centred differences, so with a two-sample apron
  // every sample a pixel can touch has the same slope as in the
  // neighbouring tile, and tiles meet without a seam.
  const h = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) h[i] = t.heights[i]! / 50 - 500;
  const col = new Float32Array(n * n * 3);
  const fo = new Float32Array(n * n);
  // Light from the north-west, 45 degrees up.
  const lx = -0.5, lz = 0.5, ly = Math.SQRT1_2;
  for (let r = 0; r < n; r++) {
    const rn = Math.max(0, r - 1), rs = Math.min(n - 1, r + 1);
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const cw = Math.max(0, c - 1), ce = Math.min(n - 1, c + 1);
      const dhdx = (h[r * n + ce]! - h[r * n + cw]!) / ((ce - cw) * step);
      // Row r-1 is north: +z.
      const dhdz = (h[rn * n + c]! - h[rs * n + c]!) / ((rs - rn) * step);
      const nx = -dhdx * RELIEF, nz = -dhdz * RELIEF;
      const lit = (nx * lx + nz * lz + ly) / Math.sqrt(nx * nx + nz * nz + 1) / ly;
      const shade = Math.min(1.22, Math.max(0.58, 1 + (lit - 1) * 0.85));
      const b = t.biomes[i]! < o.palette.biome.length ? t.biomes[i]! : 0;
      const base = o.palette.biome[b]!;
      fo[i] = t.forest ? t.forest[i]! / 255 : o.palette.meanForest[b]!;
      col[3 * i] = base[0] * shade * 0.94;
      col[3 * i + 1] = base[1] * shade;
      col[3 * i + 2] = base[2] * shade * 0.9;
    }
  }
  // Cells (by their north-west sample) whose 4 x 4 samples around share one biome.
  const uniform = new Uint8Array(n * n);
  for (let r = 1; r < n - 2; r++) {
    for (let c = 1; c < n - 2; c++) {
      const b = t.biomes[(r - 1) * n + c - 1];
      let same = 1;
      for (let a = 0; a < 4 && same; a++) for (let q = 0; q < 4; q++) if (t.biomes[(r - 1 + a) * n + c - 1 + q] !== b) same = 0;
      uniform[r * n + c] = same;
    }
  }
  const votes = new Float32Array(256);
  const rgb = new Float32Array(3);
  const kx = new Float32Array(4);
  const kz = new Float32Array(4);
  const r2 = o.radius * o.radius;
  const water = o.waterLevel;
  let p = 0;
  for (let py = 0; py < S; py++) {
    // Sample-space row: inner pixel j sits at sample j + apron.
    const v = apron - 0.5 + (py + 0.5) / f;
    const r0 = Math.min(n - 2, Math.floor(v));
    const fy = v - r0;
    const wz = t.z0 - v * step;
    for (let px = 0; px < S; px++, p += 4) {
      const u = apron - 0.5 + (px + 0.5) / f;
      const c0 = Math.min(n - 2, Math.floor(u));
      const fx = u - c0;
      const wx = t.x0 + u * step;
      if (wx * wx + wz * wz > r2) continue;
      const i00 = r0 * n + c0, i01 = i00 + 1, i10 = i00 + n, i11 = i10 + 1;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      const hh = h[i00]! * w00 + h[i01]! * w01 + h[i10]! * w10 + h[i11]! * w11;
      let best = t.biomes[i00]!;
      let R: number, G: number, B: number;
      // The forest under the smooth kernel: the game's mask is mostly on or
      // off per sample, and bilinear would draw its edge as steps.
      spline(fx, kx);
      spline(fy, kz);
      let forest = 0;
      for (let a = 0; a < 4; a++) {
        const row = (r0 - 1 + a) * n + c0 - 1;
        forest += kz[a]! * (kx[0]! * fo[row]! + kx[1]! * fo[row + 1]! + kx[2]! * fo[row + 2]! + kx[3]! * fo[row + 3]!);
      }
      if (uniform[r0 * n + c0]) {
        // One biome all round: the corners' colours, bilinear.
        R = col[3 * i00]! * w00 + col[3 * i01]! * w01 + col[3 * i10]! * w10 + col[3 * i11]! * w11;
        G = col[3 * i00 + 1]! * w00 + col[3 * i01 + 1]! * w01 + col[3 * i10 + 1]! * w10 + col[3 * i11 + 1]! * w11;
        B = col[3 * i00 + 2]! * w00 + col[3 * i01 + 2]! * w01 + col[3 * i10 + 2]! * w10 + col[3 * i11 + 2]! * w11;
      } else {
        // Near a border: each biome's share under a smooth (quadratic
        // B-spline) kernel over the 4 x 4 samples around the pixel; the
        // largest wins. The border is then a smooth curve through the
        // samples, not a staircase of whole samples, and stays sharp.
        votes.fill(0);
        for (let a = 0; a < 4; a++) {
          const row = (r0 - 1 + a) * n + c0 - 1;
          for (let q = 0; q < 4; q++) votes[t.biomes[row + q]!]! += kz[a]! * kx[q]!;
        }
        let bw = -1;
        let second = -1;
        let sw = -1;
        for (let k = 0; k < votes.length; k++) {
          const w = votes[k]!;
          if (w > bw) {
            second = best;
            sw = bw;
            bw = w;
            best = k;
          } else if (w > sw) {
            second = k;
            sw = w;
          }
        }
        // Colour from that biome's samples only, under the same kernel.
        biomeColour(t.biomes, col, n, r0, c0, best, kx, kz, rgb);
        R = rgb[0]!;
        G = rgb[1]!;
        B = rgb[2]!;
        // Right at the border, blend towards the runner-up over about one
        // output pixel: an anti-aliased edge, so it stays a clean line when
        // the map scales the tile up at close zoom.
        const k = 0.5 + 0.5 * smooth(0, 1.6 / f, bw - sw);
        if (sw > 0 && k < 1) {
          biomeColour(t.biomes, col, n, r0, c0, second, kx, kz, rgb);
          R = R * k + rgb[0]! * (1 - k);
          G = G * k + rgb[1]! * (1 - k);
          B = B * k + rgb[2]! * (1 - k);
        }
      }
      const dark = 1 - FOREST_DARKEN * forest;
      R *= dark;
      G *= dark;
      B *= dark;
      const depth = water - hh;
      if (depth > 0) {
        // Water takes the sea's colour within a metre, so coasts read as
        // water, not as a band of beach; only swamp pools keep some of the
        // mud under them, as the game's swamp does.
        // Below a few metres the ground no longer shows at all, so biome
        // borders under the sea do not show either.
        const a = best === SWAMP ? Math.max(0.55 * smooth(0, 3, depth), smooth(3, 8, depth)) : smooth(0, 0.8, depth);
        const d = smooth(2, 70, depth);
        R += (WATER_SHALLOW[0] + (WATER_DEEP[0] - WATER_SHALLOW[0]) * d - R) * a;
        G += (WATER_SHALLOW[1] + (WATER_DEEP[1] - WATER_SHALLOW[1]) * d - G) * a;
        B += (WATER_SHALLOW[2] + (WATER_DEEP[2] - WATER_SHALLOW[2]) * d - B) * a;
      }
      out[p] = R;
      out[p + 1] = G;
      out[p + 2] = B;
      out[p + 3] = 255;
    }
  }
  return out;
}
