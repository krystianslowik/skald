import { mockElevation } from "./mapmock";
import { encodePng } from "./png";

/**
 * The mock agent's terrain: the mock map's own value noise painted like the
 * agent paints a real terrain run (biome colour, hillshade, water by depth),
 * so the web's terrain layer has something to draw in development. It is our
 * noise, not the game's world generator, and looks nothing like a real seed.
 */

const SIZE = 1024;
export const MOCK_TERRAIN_RADIUS = 10500;
const LAND = 0.5;

type RGB = [number, number, number];
const MEADOWS: RGB = [156, 172, 92];
const FOREST: RGB = [78, 102, 64];
const SWAMP: RGB = [118, 102, 72];
const MOUNTAIN: RGB = [226, 226, 230];
const PLAINS: RGB = [208, 188, 116];
const MIST: RGB = [112, 98, 124];
const NORTH: RGB = [206, 220, 232];
const ASH: RGB = [150, 66, 48];

const height = (x: number, z: number) => (mockElevation(x, z) - LAND) * 700 + 30;

function biome(x: number, z: number, h: number): RGB {
  const r = Math.hypot(x, z);
  if (z > 7600 && r > 7600) return NORTH;
  if (z < -7600 && r > 7600) return ASH;
  if (h > 150) return MOUNTAIN;
  if (r < 2200) return MEADOWS;
  const n = mockElevation(x + 52_000, z - 37_000);
  if (h < 36 && n > 0.45) return SWAMP;
  if (r > 5200) return n > 0.5 ? MIST : PLAINS;
  return n > 0.42 ? FOREST : r > 3600 ? PLAINS : MEADOWS;
}

export interface MockTerrain {
  build: string;
  png: Uint8Array;
  json: string;
}

let cached: MockTerrain | null = null;

export function mockTerrain(): MockTerrain {
  if (cached) return cached;
  const px = new Uint8Array(SIZE * SIZE * 4);
  const step = (2 * MOCK_TERRAIN_RADIUS) / SIZE;
  for (let row = 0; row < SIZE; row++) {
    const z = MOCK_TERRAIN_RADIUS - (row + 0.5) * step;
    for (let col = 0; col < SIZE; col++) {
      const x = -MOCK_TERRAIN_RADIUS + (col + 0.5) * step;
      if (x * x + z * z > MOCK_TERRAIN_RADIUS * MOCK_TERRAIN_RADIUS) continue;
      const h = height(x, z);
      const i = (row * SIZE + col) * 4;
      let c: RGB;
      if (h < 30) {
        const k = Math.min(1, (30 - h) / 80);
        c = [116 + (38 - 116) * k, 156 + (66 - 156) * k, 164 + (92 - 164) * k];
      } else {
        // Light from the north-west.
        const dx = (height(x + step, z) - height(x - step, z)) / (2 * step);
        const dz = (height(x, z + step) - height(x, z - step)) / (2 * step);
        const f = Math.max(0.62, Math.min(1.3, 1 + (dx - dz) * 2.2));
        const b = biome(x, z, h);
        c = [b[0] * f, b[1] * f, b[2] * f];
      }
      px[i] = Math.min(255, c[0]);
      px[i + 1] = Math.min(255, c[1]);
      px[i + 2] = Math.min(255, c[2]);
      px[i + 3] = 255;
    }
  }
  const build = "mock-terrain-1";
  const json = JSON.stringify({
    build,
    stale: false,
    seedHash: 353373721,
    worldGenVersion: 2,
    gameBuild: "l-1.0.17",
    resolution: SIZE,
    radius: MOCK_TERRAIN_RADIUS,
    waterLevel: 30,
    renderedAt: new Date(0).toISOString(),
    biomes: ["None", "Meadows", "Swamp", "Mountain", "BlackForest", "Plains", "AshLands", "DeepNorth", "Ocean", "Mistlands"],
  });
  cached = { build, png: encodePng(SIZE, SIZE, px), json };
  return cached;
}

// ---- tiles ------------------------------------------------------------------
// The mock's terrain as the agent's tile pyramid (GET /terrain/tile), in the
// bridge's binary format (bridge/plugin/TerrainTile.cs): biome indices,
// heights and a forest channel, from the same noise, with two finer octaves
// so close zoom has relief to shade.

export const MOCK_TILE_BUILD = "mock-tiles-1";
const TILE = 256;
const EDGE = TILE + 2;
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
  return (mockElevation(x * 9 + 31_000, z * 9 - 17_000) - 0.45) * 14 + (mockElevation(x * 41 - 9_000, z * 41 + 5_000) - 0.45) * 3;
}

/** The tiles document, as the agent's GET /terrain/tiles.json. */
export function mockTilesDoc(): string {
  return JSON.stringify({
    build: MOCK_TILE_BUILD,
    tileSize: TILE,
    apron: 1,
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
  const x0 = -R + (x * TILE - 0.5) * step;
  const z0 = R - (y * TILE - 0.5) * step;
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
      const h = base + (base > 26 ? fine(wx, wz) : 0);
      const i = r * n + c;
      const b = h < 30 && base < 22 ? 8 : (BIOME_INDEX.get(biome(wx, wz, base)) ?? 1);
      out[24 + i] = b;
      dv.setUint16(hOff + 2 * i, Math.max(0, Math.min(65535, Math.round((h + 500) * 50))), true);
      const woods = mockElevation(wx * 3 + 7_000, wz * 3 + 3_000);
      const f = b === 4 ? 1 : b === 1 || b === 5 || b === 2 || b === 9 ? (woods > 0.5 ? 1 : 0) : 0;
      out[fOff + i] = f * 255;
    }
  }
  return out;
}
