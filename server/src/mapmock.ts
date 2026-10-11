import { MOCK_GROUND } from "./mockpieces";
import type { MapContainer, MapItem, MapLocation, MapLocationKind, MapSnapshot } from "./types";

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

// btoa rather than Buffer: the web build typechecks this file too, without Node types.
function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
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

/** Item prefab -> game item type, for the made-up stores. */
const ITEM_TYPES: Record<string, string> = {
  Wood: "Material", FineWood: "Material", RoundLog: "Material", ElderBark: "Material", Stone: "Material", Flint: "Material",
  Resin: "Material", LeatherScraps: "Material", DeerHide: "Material", TrollHide: "Material", BoneFragments: "Material",
  CopperOre: "Material", TinOre: "Material", Copper: "Material", Tin: "Material", Bronze: "Material", IronScrap: "Material",
  Iron: "Material", Silver: "Material", Coal: "Material", SurtlingCore: "Material", Chitin: "Material", Guck: "Material",
  GreydwarfEye: "Material", Feathers: "Material", Coins: "Material", Ruby: "Material", Amber: "Material",
  WolfPelt: "Material", Obsidian: "Material", FreezeGland: "Material",
  CarrotSeeds: "Material", TurnipSeeds: "Material", BeechSeeds: "Material", PineCone: "Material", BirchSeeds: "Material", AncientSeed: "Material",
  Honey: "Consumable", Raspberry: "Consumable", Blueberries: "Consumable", Carrot: "Consumable", Turnip: "Consumable",
  Mushroom: "Consumable", MushroomYellow: "Consumable", CookedMeat: "Consumable", CookedDeerMeat: "Consumable",
  CarrotSoup: "Consumable", QueensJam: "Consumable", Sausages: "Consumable", SerpentStew: "Consumable", TurnipStew: "Consumable",
  MeadHealthMinor: "Consumable", MeadStaminaMinor: "Consumable", MeadPoisonResist: "Consumable", MeadFrostResist: "Consumable",
  RawMeat: "Consumable", DeerMeat: "Consumable",
  SwordBronze: "OneHandedWeapon", AxeBronze: "OneHandedWeapon", MaceIron: "OneHandedWeapon", KnifeCopper: "OneHandedWeapon",
  AtgeirBronze: "TwoHandedWeapon", BowFineWood: "Bow", ShieldBronzeBuckler: "Shield", ArrowWood: "Ammo", ArrowFlint: "Ammo", ArrowFire: "Ammo",
  ArmorBronzeChest: "Chest", ArmorBronzeLegs: "Legs", HelmetBronze: "Helmet", ArmorTrollLeatherChest: "Chest", CapeDeerHide: "Shoulder",
  PickaxeBronze: "Tool", Hammer: "Tool", Hoe: "Tool", Cultivator: "Tool", Torch: "Torch",
  TrophyDeer: "Trophy", TrophyBoar: "Trophy", TrophyGreydwarf: "Trophy", TrophyTroll: "Trophy", TrophyEikthyr: "Trophy",
  CryptKey: "Misc", Wishbone: "Misc", BronzeNails: "Material", IronNails: "Material",
};

/** A stack: [prefab, stack, quality?, durability?, crafter?]. Slots fill row by row. */
type Stack = [name: string, stack: number, quality?: number, durability?: number, crafter?: string];

function fill(width: number, stacks: Stack[], showNames: boolean): MapItem[] {
  return stacks.map(([name, stack, quality, durability, crafter], i) => {
    const it: MapItem = { name, type: ITEM_TYPES[name], stack, x: i % width, y: Math.floor(i / width) };
    if (quality && quality > 1) it.quality = quality;
    if (durability !== undefined) it.durability = durability;
    if (crafter && showNames) it.crafter = crafter;
    return it;
  });
}

const GRID: Record<string, [number, number]> = { piece_chest_wood: [5, 2], piece_chest: [6, 4], piece_chest_private: [3, 2], piece_chest_barrel: [6, 2], Cart: [6, 3], Karve: [2, 2], Raft: [0, 0] };

/**
 * Made-up stores: a home base full of chests sorted the way people sort them
 * (wood, ores, food, gear), a swamp outpost, a loaded cart and karve. No
 * world chests, like the agent.
 */
function mockStorage(showNames: boolean): MapContainer[] {
  const c = (prefab: string, x: number, z: number, stacks: Stack[], y = MOCK_GROUND.home + 0.05): MapContainer => {
    const [width, height] = GRID[prefab] ?? [5, 2];
    const kind = prefab === "Cart" ? "cart" : prefab === "Karve" || prefab === "Raft" ? "ship" : "chest";
    return { id: `${prefab}@${x},${z}`, kind, prefab, x, y: +y.toFixed(2), z, width, height, items: fill(width, stacks, showNames) };
  };
  // A chest stacked on another one, about 0.9 m up.
  const on = (below: MapContainer, stacks: Stack[]): MapContainer => c(below.prefab, below.x, below.z, stacks, below.y! + 0.9);
  const two = c("piece_chest_wood", 208, -352, [["Wood", 50], ["Wood", 50], ["Wood", 50], ["Wood", 50], ["Wood", 37], ["FineWood", 50], ["FineWood", 22], ["RoundLog", 50], ["ElderBark", 31], ["Resin", 44]]);
  const three = c("piece_chest_wood", 233, -346, [["LeatherScraps", 50], ["LeatherScraps", 22], ["DeerHide", 26], ["TrollHide", 4]]);
  const middle = on(three, [["Feathers", 48], ["Resin", 30], ["GreydwarfEye", 17]]);
  const all = [
    two,
    on(two, [["Wood", 50], ["Wood", 50], ["FineWood", 50], ["RoundLog", 18]]),
    three,
    middle,
    on(middle, [["Flint", 30], ["Stone", 50], ["Stone", 50]]),
    // Up in the loft of the longhouse.
    c("piece_chest", 226, -348, [["Coal", 50], ["Coal", 50], ["Coal", 31], ["Copper", 20], ["Tin", 12]], MOCK_GROUND.upper + 0.05),
    c("piece_chest_wood", 230, -354, [["Honey", 20], ["QueensJam", 4], ["Raspberry", 12]], MOCK_GROUND.upper + 0.05),
    c("piece_chest_wood", 211, -352, [["Stone", 50], ["Stone", 50], ["Stone", 18], ["Flint", 27], ["Coal", 50], ["Coal", 12], ["SurtlingCore", 9], ["BoneFragments", 36]]),
    c("piece_chest", 214, -352, [
      ["CopperOre", 30], ["CopperOre", 30], ["CopperOre", 11], ["TinOre", 30], ["TinOre", 4], ["Copper", 50], ["Copper", 23], ["Tin", 18],
      ["Bronze", 34], ["IronScrap", 30], ["IronScrap", 30], ["IronScrap", 30], ["IronScrap", 7], ["Iron", 50], ["Iron", 41], ["Silver", 12],
      ["BronzeNails", 80], ["IronNails", 54], ["Obsidian", 22], ["Chitin", 15],
    ]),
    c("piece_chest_wood", 217, -352, [["Honey", 50], ["Honey", 50], ["Honey", 12], ["Raspberry", 38], ["Blueberries", 44], ["Carrot", 27], ["Turnip", 19], ["Mushroom", 23], ["QueensJam", 8], ["Sausages", 6]]),
    c("piece_chest_wood", 220, -352, [["CarrotSeeds", 46], ["TurnipSeeds", 31], ["BeechSeeds", 12], ["PineCone", 9], ["BirchSeeds", 17], ["AncientSeed", 3]]),
    c("piece_chest_private", 223, -350, [
      ["SwordBronze", 1, 3, 287.5, "Ragnar"], ["ShieldBronzeBuckler", 1, 2, 214, "Freya"], ["BowFineWood", 1, 2, 96.4, "Astrid"],
      ["ArrowFire", 84], ["ArrowFlint", 100], ["Coins", 412],
    ]),
    c("piece_chest_wood", 226, -352, [
      ["ArmorBronzeChest", 1, 2, 1200, "Ragnar"], ["ArmorBronzeLegs", 1, 1, 640.2, "Ragnar"], ["HelmetBronze", 1, 2, 1045, "Freya"],
      ["CapeDeerHide", 1, 1, 400, "Astrid"], ["PickaxeBronze", 1, 2, 180.6, "Bjorn"], ["Hammer", 1, 1, 87.3], ["Cultivator", 1, 1, 200, "Freya"], ["Torch", 1, 1, 6.2],
    ]),
    c("piece_chest_wood", 229, -352, [["TrophyDeer", 6], ["TrophyBoar", 4], ["TrophyGreydwarf", 11], ["TrophyTroll", 2], ["TrophyEikthyr", 1], ["Wishbone", 1], ["CryptKey", 1], ["Ruby", 4], ["Amber", 7]]),
    c("piece_chest_barrel", 236, -334, [["MeadHealthMinor", 10], ["MeadStaminaMinor", 10], ["MeadPoisonResist", 6], ["MeadFrostResist", 4], ["CarrotSoup", 9], ["TurnipStew", 5]]),
    c("piece_chest_wood", 202, -330, []),
    c("piece_chest_wood", -1466, 986, [["Guck", 14], ["Iron", 18], ["IronScrap", 30], ["IronScrap", 22], ["Chitin", 8], ["SerpentStew", 3], ["CookedDeerMeat", 7], ["Wood", 41]], MOCK_GROUND.swamp + 0.05 + 16 * 0.06),
    c("piece_chest_wood", -1452, 990, [["TrollHide", 9], ["DeerHide", 26], ["LeatherScraps", 31], ["Feathers", 48], ["GreydwarfEye", 37], ["WolfPelt", 6], ["FreezeGland", 5]], MOCK_GROUND.swamp + 0.05 + 20 * 0.06),
    c("piece_chest_wood", 1574, 1726, [["Silver", 30], ["Silver", 12], ["Obsidian", 40], ["WolfPelt", 11], ["FreezeGland", 13]], MOCK_GROUND.mountain + 0.05),
    c("Cart", 160, -300, [["CopperOre", 30], ["CopperOre", 30], ["CopperOre", 30], ["TinOre", 30], ["TinOre", 18], ["Stone", 50], ["Wood", 50], ["Wood", 50], ["Resin", 12]], 33.1),
    c("Karve", 420, -520, [["IronScrap", 30], ["IronScrap", 30], ["Wood", 50], ["CookedMeat", 8]], 29.85),
    c("Raft", -980, 640, [], 30),
  ];
  // Chests on one metre get "#n" from the bottom up, as the agent names them.
  const seen = new Map<string, number>();
  for (const s of all) {
    const n = seen.get(s.id) ?? 0;
    seen.set(s.id, n + 1);
    if (n > 0) s.id = `${s.id}#${n}`;
  }
  return all;
}

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
      { x: -1290, z: 1050, owner: name("Bjorn"), day: 36, items: fill(8, [["AxeBronze", 1, 2, 132.5, "Bjorn"], ["ArmorTrollLeatherChest", 1, 1, 380, "Freya"], ["Hoe", 1, 1, 100], ["Guck", 6], ["Torch", 1, 1, 14.8], ["RawMeat", 4]], showNames) },
      { x: -1520, z: 905, owner: name("Freya"), day: 38, items: fill(8, [["KnifeCopper", 1, 2, 241, "Freya"], ["Bronze", 6], ["Blueberries", 12]], showNames) },
      { x: 1620, z: 1910, owner: name("Ragnar"), day: 40, items: fill(8, [["MaceIron", 1, 3, 305, "Ragnar"], ["ArmorBronzeChest", 1, 2, 1180, "Ragnar"], ["Silver", 14], ["Obsidian", 9], ["MeadFrostResist", 2]], showNames) },
    ],
    beds: [
      { x: 228, z: -332, owner: name("Ragnar") },
      { x: 214, z: -330, owner: name("Freya") },
      { x: 232, z: -350, owner: name("Astrid") },
      { x: -1468, z: 972, owner: name("Bjorn") },
    ],
    vehicles: [
      { id: "Karve@420,-520", kind: "Karve", x: 420, z: -520 },
      { id: "Raft@-980,640", kind: "Raft", x: -980, z: 640 },
      { id: "Cart@160,-300", kind: "Cart", x: 160, z: -300 },
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
    storage: mockStorage(showNames),
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
