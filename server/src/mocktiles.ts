import { mockElevation } from "./mapmock";

/**
 * The mock's terrain helpers and its tile pyramid, apart from mockterrain.ts
 * so the web's tests can import them without the PNG encoder (node:zlib).
 * Our noise, not the game's world generator.
 */

export const MOCK_TERRAIN_RADIUS = 10500;
const LAND = 0.5;

export type RGB = [number, number, number];
export const MEADOWS: RGB = [156, 172, 92];
export const FOREST: RGB = [78, 102, 64];
export const SWAMP: RGB = [118, 102, 72];
export const MOUNTAIN: RGB = [226, 226, 230];
export const PLAINS: RGB = [208, 188, 116];
export const MIST: RGB = [112, 98, 124];
export const NORTH: RGB = [206, 220, 232];
export const ASH: RGB = [150, 66, 48];

export const height = (x: number, z: number) => (mockElevation(x, z) - LAND) * 700 + 30;

/**
 * The mock's noise far from the centre, without mockElevation's fall-off
 * towards the world's edge (which, so far out, would leave it always below
 * every threshold): 0..1-ish, for picking biomes and woods.
 */
function noise(x: number, z: number): number {
  const r = Math.hypot(x, z) / 10500;
  return mockElevation(x, z) + r * r * 0.25;
}

export function biome(x: number, z: number, h: number): RGB {
  const r = Math.hypot(x, z);
  if (z > 7600 && r > 7600) return NORTH;
  if (z < -7600 && r > 7600) return ASH;
  if (h > 150) return MOUNTAIN;
  if (r < 2200) return MEADOWS;
  const n = noise(x + 52_000, z - 37_000);
  if (h < 36 && n > 0.45) return SWAMP;
  if (r > 5200) return n > 0.5 ? MIST : PLAINS;
  return n > 0.42 ? FOREST : r > 3600 ? PLAINS : MEADOWS;
}

// ---- tiles ------------------------------------------------------------------
// The mock's terrain as the agent's tile pyramid (GET /terrain/tile), in the
// bridge's binary format (bridge/plugin/TerrainTile.cs): biome indices,
// heights and a forest channel, from the same noise, with two finer octaves
// so close zoom has relief to shade.

export const MOCK_TILE_BUILD = "mock-tiles-1";
const TILE = 256;
const APRON = 2;
const EDGE = TILE + 2 * APRON;
const MAX_LEVEL = 7;
const BIOME_INDEX = new Map<RGB, number>([
  [MEADOWS, 1],
  [SWAMP, 2],
  [MOUNTAIN, 3],
  [FOREST, 4],
  [PLAINS, 5],
  [ASH, 6],
  [NORTH, 7],
  [MIST, 9],
]);

function fine(x: number, z: number): number {
  return (noise(x * 9 + 31_000, z * 9 - 17_000) - 0.45) * 14 + (noise(x * 41 - 9_000, z * 41 + 5_000) - 0.45) * 3;
}

/** The agent's packing before gzip (agent/internal/terrain packHeights): row deltas in two byte planes. */
export function packHeights(raw: Uint8Array): Uint8Array {
  const dv = new DataView(raw.buffer, raw.byteOffset);
  const n = dv.getInt32(8, true);
  const nn = n * n;
  const out = new Uint8Array(raw);
  new DataView(out.buffer).setUint16(6, dv.getUint16(6, true) | 4, true);
  for (let r = 0; r < n; r++) {
    let prev = 0;
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const v = dv.getUint16(24 + nn + 2 * i, true);
      const d = (v - prev) & 0xffff;
      prev = v;
      out[24 + nn + i] = d & 255;
      out[24 + 2 * nn + i] = d >> 8;
    }
  }
  return out;
}

/** The tiles document, as the agent's GET /terrain/tiles.json. */
export function mockTilesDoc(): string {
  return JSON.stringify({
    build: MOCK_TILE_BUILD,
    tileSize: TILE,
    apron: 2,
    maxLevel: MAX_LEVEL,
    gridLevel: -1,
    radius: MOCK_TERRAIN_RADIUS,
    source: "bridge",
    stale: false,
    waterLevel: 30,
    biomes: ["None", "Meadows", "Swamp", "Mountain", "BlackForest", "Plains", "AshLands", "DeepNorth", "Ocean", "Mistlands"],
    forest: "mask",
    palette: { source: "none" },
  });
}

/** Tile z/x/y, ungzipped, or null when there is no such tile. */
export function mockTerrainTile(z: number, x: number, y: number): Uint8Array | null {
  if (!Number.isInteger(z) || z < 0 || z > MAX_LEVEL || x < 0 || y < 0 || x >= 1 << z || y >= 1 << z) return null;
  const R = MOCK_TERRAIN_RADIUS;
  const step = (2 * R) / (TILE << z);
  const x0 = -R + (x * TILE - APRON + 0.5) * step;
  const z0 = R - (y * TILE - APRON + 0.5) * step;
  const n = EDGE;
  const out = new Uint8Array(24 + n * n * 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x31544b53, true);
  dv.setUint16(4, 1, true);
  dv.setUint16(6, 3, true);
  dv.setInt32(8, n, true);
  dv.setFloat32(12, x0, true);
  dv.setFloat32(16, z0, true);
  dv.setFloat32(20, step, true);
  const hOff = 24 + n * n;
  const fOff = hOff + 2 * n * n;
  for (let r = 0; r < n; r++) {
    const wz = z0 - r * step;
    for (let c = 0; c < n; c++) {
      const wx = x0 + c * step;
      const base = height(wx, wz);
      // Fine relief on land only, faded in above the shore so it has no step.
      const h = base + fine(wx, wz) * Math.min(1, Math.max(0, (base - 22) / 10));
      const i = r * n + c;
      const b = h < 30 && base < 22 ? 8 : (BIOME_INDEX.get(biome(wx, wz, base)) ?? 1);
      out[24 + i] = b;
      dv.setUint16(hOff + 2 * i, Math.max(0, Math.min(65535, Math.round((h + 500) * 50))), true);
      const woods = noise(wx * 3 + 7_000, wz * 3 + 3_000);
      const f = b === 4 ? 1 : b === 1 || b === 5 || b === 2 || b === 9 ? (woods > 0.5 ? 1 : 0) : 0;
      out[fOff + i] = f * 255;
    }
  }
  return out;
}
