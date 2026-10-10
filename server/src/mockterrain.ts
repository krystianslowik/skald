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
