import type { MapLocation, MapLocationKind, MapSnapshot } from "./types";

/**
 * A made-up world map for MOCK_AGENT=1, the tests and the screenshots: an
 * archipelago from value noise, three bases, paired portals, graves, beds, a
 * karve, explored corridors between the bases, pins and a seed's worth of
 * locations (most of them never found). Sized like a played 1.0 world (a few
 * thousand generated zones, ~1,400 listed locations, ~30k explored pixels)
 * so the renderer is measured on a realistic load. Nothing here comes from a
 * real save.
 */

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hash2(xi, zi, seed);
  const b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed);
  const d = hash2(xi + 1, zi + 1, seed);
  const u = s(fx);
  const v = s(fz);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Height-ish field in 0..1 at world metres; > LAND is land. */
export function mockElevation(x: number, z: number): number {
  let f = 0;
  let amp = 0.55;
  let freq = 1 / 1400;
  for (let o = 0; o < 4; o++) {
    f += amp * valueNoise(x * freq, z * freq, 11 + o);
    amp *= 0.5;
    freq *= 2.1;
  }
  // Land thins out towards the world's edge.
  const r = Math.hypot(x, z) / 10500;
  return f - r * r * 0.25 + (Math.hypot(x, z) < 500 ? 0.2 : 0);
}

const LAND = 0.5;

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function rle(mask: Uint8Array): { rle: string; pixels: number } {
  const out: number[] = [];
  const put = (n: number) => {
    while (n >= 0x80) {
      out.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
  };
  let cur = 0;
  let run = 0;
  let pixels = 0;
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 1 : 0;
    if (v !== cur) {
      put(run);
      cur = v;
      run = 0;
    }
    run++;
    pixels += v;
  }
  put(run);
  return { rle: base64(Uint8Array.from(out)), pixels };
}

const BASES = [
  { name: "home", x: 220, z: -340, pieces: 1840, hasBed: true, stations: ["artisan", "cauldron", "fire", "forge", "kiln", "smelter", "stonecutter", "ward", "workbench"] },
  { name: "swamp", x: -1460, z: 980, pieces: 212, hasBed: true, stations: ["fire", "workbench"] },
  { name: "mountain", x: 1580, z: 1720, pieces: 96, hasBed: false, stations: ["fire", "workbench"] },
  { name: "outpost", x: -2380, z: -1900, pieces: 31, hasBed: false, stations: ["workbench"] },
];

const DUNGEONS = ["Crypt2", "Crypt3", "Crypt4", "SunkenCrypt4", "TrollCave02", "MountainCave02", "Mistlands_DvergrTownEntrance1", "Mistlands_DvergrTownEntrance2"];
const BOSSES = ["Eikthyrnir", "GDKing", "Bonemass", "Dragonqueen", "GoblinKing", "Mistlands_DvergrBossEntrance1", "FaderLocation"];
const TRADERS = ["Vendor_BlackForest", "Hildir_camp", "BogWitch_Camp"];

export function mockMap(opts: { generation?: number; netTime?: number; savedAt?: string; now?: number; showNames?: boolean } = {}): MapSnapshot {
  const rand = rng(20261010);
  const showNames = opts.showNames ?? true;
  const name = (s: string) => (showNames ? s : "");

  // Land grid: generated zones within ~3.8 km of the origin and around each base.
  const min = -164;
  const size = 329;
  const land = new Uint8Array(size * size);
  let generated = 0;
  const near = (x: number, z: number, r: number) => BASES.some((b) => Math.hypot(x - b.x, z - b.z) < r);
  for (let gz = 0; gz < size; gz++) {
    for (let gx = 0; gx < size; gx++) {
      const x = (gx + min) * 64;
      const z = (gz + min) * 64;
      if (Math.hypot(x, z) > 3300 && !near(x, z, 900)) continue;
      generated++;
      const e = mockElevation(x, z);
      if (e <= LAND) {
        land[gz * size + gx] = 1;
        continue;
      }
      const objects = Math.round(Math.min(4000, Math.pow(2, 4 + (e - LAND) * 22)) * (0.6 + rand() * 0.8));
      land[gz * size + gx] = Math.min(255, Math.round(2 + Math.log2(Math.max(1, objects)) * 24));
    }
  }

  // Explored: discs around spawn and every base, corridors between them.
  const S = 2048;
  const M = 12;
  const mask = new Uint8Array(S * S);
  const disc = (cx: number, cz: number, r: number) => {
    const c0 = Math.round(cx / M) + S / 2;
    const r0 = Math.round(cz / M) + S / 2;
    const rp = Math.ceil(r / M);
    for (let dz = -rp; dz <= rp; dz++) {
      for (let dx = -rp; dx <= rp; dx++) {
        if (dx * dx + dz * dz > rp * rp) continue;
        const col = c0 + dx;
        const row = r0 + dz;
        if (col >= 0 && row >= 0 && col < S && row < S) mask[row * S + col] = 1;
      }
    }
  };
  disc(0, 0, 520);
  const path: [number, number][] = [[0, 0], ...BASES.map((b) => [b.x, b.z] as [number, number])];
  for (const [x, z] of path) disc(x, z, 420);
  for (let i = 1; i < path.length; i++) {
    const [ax, az] = path[i - 1]!;
    const [bx, bz] = path[i]!;
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / 40);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // A wandering route, as walked rather than drawn with a ruler.
      const wob = Math.sin(t * Math.PI * 3 + i) * 120;
      disc(ax + (bx - ax) * t + wob * 0.4, az + (bz - az) * t - wob * 0.3, 90 + 40 * Math.sin(t * 7 + i));
    }
  }
  const explored = rle(mask);
  const isExplored = (x: number, z: number) => {
    const col = Math.round(x / M) + S / 2;
    const row = Math.round(z / M) + S / 2;
    return col >= 0 && row >= 0 && col < S && row < S && mask[row * S + col] === 1;
  };
  const isGenerated = (x: number, z: number) => {
    const gx = Math.floor((x + 32) / 64) - min;
    const gz = Math.floor((z + 32) / 64) - min;
    return gx >= 0 && gz >= 0 && gx < size && gz < size && land[gz * size + gx] !== 0;
  };

  // Locations: a seed's worth across the whole world, on land.
  const locations: MapLocation[] = [];
  const place = (kind: MapLocationKind, locName: string, count: number, spread = 10000) => {
    let tries = 0;
    for (let n = 0; n < count && tries < count * 60; tries++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * spread;
      const x = Math.round(Math.cos(a) * r);
      const z = Math.round(Math.sin(a) * r);
      if (mockElevation(x, z) <= LAND + 0.02) continue;
      const placed = isGenerated(x, z);
      locations.push({ kind, name: locName, x, z, placed, explored: placed && (isExplored(x, z) || near(x, z, 64)) });
      n++;
    }
  };
  locations.push({ kind: "start", name: "StartTemple", x: 0, z: 0, placed: true, explored: true });
  for (const b of BOSSES) place("boss", b, 4);
  // One boss altar each for the first two, right where people have been.
  locations.push({ kind: "boss", name: "Eikthyrnir", x: 330, z: 140, placed: true, explored: true });
  locations.push({ kind: "boss", name: "GDKing", x: -1180, z: 760, placed: true, explored: true });
  for (const tr of TRADERS) place("trader", tr, tr === "BogWitch_Camp" ? 1 : 10);
  locations.push({ kind: "trader", name: "Vendor_BlackForest", x: -860, z: 420, placed: true, explored: true });
  for (const d of DUNGEONS) place("dungeon", d, d.startsWith("Mistlands") ? 120 : 190);
  for (let i = 0; i < 18; i++) place("dungeon", DUNGEONS[i % 4]!, 1, 2600);

  const portalPairs: [string, number, number, number, number][] = [
    ["home", 236, -322, -1450, 1000],
    ["mountain", 210, -350, 1570, 1700],
    ["outpost", 252, -360, -2370, -1880],
  ];
  const portals: MapSnapshot["portals"] = [];
  for (const [tag, ax, az, bx, bz] of portalPairs) {
    const a = `${ax},${az}`;
    const b = `${bx},${bz}`;
    portals.push({ id: a, kind: "portal_wood", x: ax, z: az, tag: name(tag), pairedWith: b });
    portals.push({ id: b, kind: "portal_wood", x: bx, z: bz, tag: name(tag), pairedWith: a });
  }
  portals.push({ id: "-640,-120", kind: "portal_wood", x: -640, z: -120, tag: name("unfinished") });

  return {
    meta: {
      seedName: "ZbzIWkK5KK",
      seed: 353373721,
      worldGenVersion: 2,
      day: Math.floor((opts.netTime ?? 41 * 1800 + 734) / 1800),
      netTime: opts.netTime ?? 41 * 1800 + 734,
      generation: opts.generation ?? 1,
      savedAt: opts.savedAt ?? new Date(opts.now ?? Date.now()).toISOString(),
      generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
      showNames,
    },
    land: { zoneSize: 64, min, size, data: base64(land) },
    explored: { available: true, tables: 2, size: S, metersPerPixel: M, pixels: explored.pixels, rle: explored.rle },
    pins: [
      { type: 1, kind: "home", name: name("Hearthstead"), x: 220, z: -340 },
      { type: 0, kind: "fire", name: name("Swamp camp"), x: -1460, z: 980 },
      { type: 3, kind: "point", name: name("Copper"), x: -320, z: 510 },
      { type: 3, kind: "point", name: name("Copper"), x: -420, z: 640 },
      { type: 3, kind: "point", name: name("Silver?"), x: 1640, z: 1810 },
      { type: 2, kind: "hammer", name: name("Bridge"), x: -760, z: 360 },
      { type: 4, kind: "cave", name: name("Troll cave"), x: 520, z: 780 },
      { type: 9, kind: "boss", name: name("Eikthyr"), x: 330, z: 140 },
      { type: 9, kind: "boss", name: name("The Elder"), x: -1180, z: 760 },
      { type: 0, kind: "fire", name: name("Raspberries"), x: 140, z: 260 },
    ],
    portals,
    tombstones: [
      { x: -1290, z: 1050, owner: name("Bjorn"), day: 36 },
      { x: -1520, z: 905, owner: name("Freya"), day: 38 },
      { x: 1620, z: 1910, owner: name("Ragnar"), day: 40 },
    ],
    beds: [
      { x: 228, z: -332, owner: name("Ragnar") },
      { x: 214, z: -330, owner: name("Freya") },
      { x: 232, z: -350, owner: name("Astrid") },
      { x: -1468, z: 972, owner: name("Bjorn") },
    ],
    vehicles: [
      { kind: "Karve", x: 420, z: -520 },
      { kind: "Raft", x: -980, z: 640 },
      { kind: "Cart", x: 160, z: -300 },
    ],
    bases: BASES.map(({ x, z, pieces, hasBed, stations }) => ({ x, z, pieces, zones: Math.max(1, Math.round(pieces / 300)), hasBed, stations })),
    locations,
    terrainEdits: [
      { x: 192, z: -320, cells: 1400 },
      { x: 256, z: -320, cells: 820 },
      { x: 192, z: -384, cells: 610 },
      { x: 256, z: -384, cells: 240 },
      { x: -1472, z: 960, cells: 380 },
      { x: 1600, z: 1728, cells: 90 },
      { x: -768, z: 384, cells: 160 },
    ],
    stats: {
      zdos: 376000,
      chunks: 36,
      chunksParsed: 36,
      chunksFailed: 0,
      pieces: BASES.reduce((n, b) => n + b.pieces, 0),
      generatedZones: generated,
      locationsTotal: 12400,
      locationsPlaced: locations.filter((l) => l.placed).length + 800,
      buildSeconds: 0.04,
    },
  };
}
