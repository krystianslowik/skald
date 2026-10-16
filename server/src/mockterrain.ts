import { biome, height, MOCK_TERRAIN_RADIUS, type RGB } from "./mocktiles";
import { encodePng } from "./png";

/**
 * The mock agent's terrain: the mock map's own value noise painted like the
 * agent paints a real terrain run (biome colour, hillshade, water by depth),
 * so the web's terrain layer has something to draw in development. It is our
 * noise, not the game's world generator, and looks nothing like a real seed.
 */

export { MOCK_TERRAIN_RADIUS, MOCK_TILE_BUILD, mockTerrainTile, mockTilesDoc, packHeights } from "./mocktiles";

const SIZE = 1024;

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
