import { encodePng } from "./png";

/**
 * The mock agent's item icon sheet: plain shapes in a colour picked from the
 * item's name, drawn here. No game art, and on purpose nothing that looks like
 * it; it only exercises the same sheet and map.json path as the real icons.
 */

const SIZE = 64;
const COLUMNS = 32;
const COLOURS: [number, number, number][] = [
  [196, 120, 52],
  [120, 150, 70],
  [92, 130, 170],
  [170, 80, 70],
  [150, 120, 170],
  [200, 170, 80],
  [110, 110, 120],
  [80, 150, 140],
];

/**
 * Building materials get a plain colour of their own, so the floor plans'
 * material tones (sampled from these icons) look like wood and stone in the
 * mock too. Only flat colours, chosen by hand.
 */
const MATERIAL_COLOURS: Record<string, [number, number, number]> = {
  Wood: [156, 112, 68],
  RoundLog: [128, 84, 50],
  Stone: [132, 130, 124],
  Iron: [104, 110, 120],
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Inside test for one shape in a unit cell (-1..1). */
const SHAPES: ((x: number, y: number) => boolean)[] = [
  (x, y) => x * x + y * y < 0.72, // disc
  (x, y) => Math.abs(x) < 0.68 && Math.abs(y) < 0.68, // square
  (x, y) => Math.abs(x) + Math.abs(y) < 0.92, // diamond
  (x, y) => y > -0.7 && Math.abs(x) < (0.8 - (y + 0.7) / 1.6) * 0.95 && y < 0.8, // triangle
  (x, y) => Math.max(Math.abs(x) * 0.866 + Math.abs(y) * 0.5, Math.abs(y)) < 0.78, // hexagon
  (x, y) => (Math.abs(x) < 0.26 && Math.abs(y) < 0.8) || (Math.abs(y) < 0.26 && Math.abs(x) < 0.8), // cross
];

export interface MockIcons {
  build: string;
  map: string;
  sheet: Uint8Array;
}

export function mockIcons(names: readonly string[]): MockIcons {
  const list = [...new Set(names)].sort();
  const rows = Math.max(1, Math.ceil(list.length / COLUMNS));
  const W = COLUMNS * SIZE;
  const H = rows * SIZE;
  const px = new Uint8Array(W * H * 4);
  const items: Record<string, [number, number]> = {};
  list.forEach((name, k) => {
    const h = hash(name);
    const inside = SHAPES[h % SHAPES.length]!;
    const [r, g, b] = MATERIAL_COLOURS[name] ?? COLOURS[(h >>> 8) % COLOURS.length]!;
    const ox = (k % COLUMNS) * SIZE;
    const oy = Math.floor(k / COLUMNS) * SIZE;
    items[name] = [ox, oy];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        // 3x3 samples per pixel: soft edges at any display size.
        let cover = 0;
        let rim = 0;
        for (let sy = 0; sy < 3; sy++) {
          for (let sx = 0; sx < 3; sx++) {
            const u = ((x + (sx + 0.5) / 3) / SIZE) * 2 - 1;
            const v = ((y + (sy + 0.5) / 3) / SIZE) * 2 - 1;
            if (inside(u * 1.1, v * 1.1)) {
              cover++;
              if (!inside(u * 1.32, v * 1.32)) rim++;
            }
          }
        }
        if (!cover) continue;
        const i = ((oy + y) * W + ox + x) * 4;
        // A darker rim and a lighter top-left, so the shape reads at 20 px.
        const light = 1 + 0.25 * (1 - (x + y) / SIZE) - (rim / cover) * 0.45;
        px[i] = Math.min(255, r * light);
        px[i + 1] = Math.min(255, g * light);
        px[i + 2] = Math.min(255, b * light);
        px[i + 3] = Math.round((cover / 9) * 255);
      }
    }
  });
  const build = hash(list.join(",")).toString(16).padStart(8, "0");
  const map = JSON.stringify({ version: 1, build, size: SIZE, columns: COLUMNS, width: W, height: H, sheet: `sheet.${build}.webp`, count: list.length, items });
  return { build, map, sheet: encodePng(W, H, px) };
}
