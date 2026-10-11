import { mockElevation } from "./mapmock";
import type { ApiNature, NatureCategory, NatureKind, NatureRow } from "./types";

/**
 * Made-up nature for MOCK_AGENT=1, the tests and the screenshots: belts of
 * beech, birch and oak round the home base with a clearing where it stands,
 * a fir wood to its north with copper in it, stumps and logs where wood was
 * cut, boulders, bushes, berries and mushrooms; swamp trees, iron mud piles
 * and guck round the swamp hut; firs, rocks and a silver vein by the mountain
 * hut. Never inside a building. Our own noise, nothing from a real world.
 */

/** The kinds the mock uses, sized like the agent's table. */
const KINDS: Record<string, [NatureCategory, string, number]> = {
  Beech1: ["tree", "beech", 8],
  Beech_small1: ["tree", "beech", 4],
  Birch1: ["tree", "birch", 8],
  Birch2_aut: ["tree", "birch", 8],
  Oak1: ["tree", "oak", 14],
  Pinetree_01: ["tree", "pine", 6],
  FirTree: ["tree", "fir", 5],
  FirTree_small: ["tree", "fir", 6],
  SwampTree1: ["tree", "swamp", 8],
  SwampTree2: ["tree", "swamp", 6],
  Pinetree_Snow: ["tree", "snowpine", 6],
  Beech_Stub: ["stump", "beech", 1.5],
  FirTree_Stub: ["stump", "fir", 1.5],
  OakStub: ["stump", "oak", 2.5],
  beech_log: ["log", "beech", 8],
  beech_log_half: ["log", "beech", 4],
  FirTree_log: ["log", "fir", 8],
  Rock_4: ["rock", "boulder", 1.2],
  Rock_3: ["rock", "boulder", 1.5],
  rock4_forest: ["rock", "boulder", 4],
  rock1_mountain: ["rock", "mountain", 4],
  HeathRockPillar: ["rock", "pillar", 4],
  Bush01: ["bush", "bush", 1.5],
  Bush02_en: ["bush", "bush", 2],
  rock4_copper: ["ore", "copper", 6],
  MineRock_Tin: ["ore", "tin", 2],
  mudpile: ["ore", "iron", 3],
  mudpile2: ["ore", "iron", 3],
  GuckSack: ["ore", "guck", 1],
  silvervein: ["ore", "silver", 4],
  MineRock_Obsidian: ["ore", "obsidian", 3],
  Pickable_Stone: ["pickable", "stone", 0.5],
  Pickable_Flint: ["pickable", "flint", 0.5],
  Pickable_Branch: ["pickable", "branch", 0.8],
  Pickable_Dandelion: ["pickable", "dandelion", 0.5],
  Pickable_Thistle: ["pickable", "thistle", 0.5],
  Pickable_Mushroom: ["pickable", "mushroom", 0.5],
  Pickable_Mushroom_yellow: ["pickable", "mushroom_yellow", 0.5],
  RaspberryBush: ["pickable", "raspberry", 1.5],
  BlueberryBush: ["pickable", "blueberry", 1.5],
  Pickable_BogIronOre: ["pickable", "iron", 0.5],
};

type Item = [name: string, x: number, z: number, yaw: number, scale: number];

/** A small seeded generator, so every run draws the same woods. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in 0..1, for where the woods are. */
function woods(x: number, z: number, seed: number): number {
  const h = (ix: number, iz: number) => {
    let n = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const one = (fx: number, fz: number) => {
    const xi = Math.floor(fx);
    const zi = Math.floor(fz);
    const s = (t: number) => t * t * (3 - 2 * t);
    const u = s(fx - xi);
    const v = s(fz - zi);
    const a = h(xi, zi);
    const b = h(xi + 1, zi);
    const c = h(xi, zi + 1);
    const d = h(xi + 1, zi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return one(x / 90, z / 90) * 0.65 + one(x / 31, z / 31) * 0.35;
}

/** Where buildings stand (from the mock floor plans), with a little room around them. */
const BUILT: [number, number, number, number][] = [
  [196, -368, 258, -314],
  [-1473, 967, -1447, 1002],
  [1567, 1698, 1585, 1731],
];
const built = (x: number, z: number, pad = 0) => BUILT.some(([x0, z0, x1, z1]) => x >= x0 - pad && x <= x1 + pad && z >= z0 - pad && z <= z1 + pad);
/** Metres from the nearest building's box: the clearing round a base. */
const fromBuilt = (x: number, z: number) => Math.min(...BUILT.map(([x0, z0, x1, z1]) => Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1))));

function region(out: Item[], cx: number, cz: number, radius: number, seed: number, land: number, pick: (x: number, z: number, r: () => number) => string | null) {
  const r = rng(seed);
  const cell = 3.2;
  for (let x = cx - radius; x < cx + radius; x += cell) {
    for (let z = cz - radius; z < cz + radius; z += cell) {
      const px = x + r() * cell;
      const pz = z + r() * cell;
      if (Math.hypot(px - cx, pz - cz) > radius || mockElevation(px, pz) < land || built(px, pz, 1)) continue;
      const name = pick(px, pz, r);
      if (name) out.push([name, +px.toFixed(1), +pz.toFixed(1), Math.floor(r() * 360), +(0.8 + r() * 0.45).toFixed(2)]);
    }
  }
}

/** Meadows round the home base: woodland belts, a fir wood to the north, a clearing round the yard. */
function home(out: Item[]) {
  region(out, 224, -340, 420, 7, 0.5, (x, z, r) => {
    const d = fromBuilt(x, z);
    const w = woods(x, z, 3);
    const firs = z > -200 && woods(x, z, 9) > 0.45;
    // The clearing: nothing tall within 28 m of the yard, thinning out to 70 m.
    const open = Math.min(1, Math.max(0, (d - 28) / 42));
    const dense = (w - 0.48) * 4 * open;
    if (r() < dense * 0.62) {
      if (firs) return r() < 0.75 ? "FirTree" : r() < 0.6 ? "FirTree_small" : "Pinetree_01";
      const k = r();
      return k < 0.62 ? "Beech1" : k < 0.78 ? "Beech_small1" : k < 0.93 ? (r() < 0.5 ? "Birch1" : "Birch2_aut") : "Oak1";
    }
    const k = r();
    if (dense > 0 && k < 0.03) return firs ? "BlueberryBush" : "Pickable_Mushroom";
    if (dense > 0 && k < 0.06) return "Pickable_Branch";
    if (dense > -0.1 && k < 0.07) return r() < 0.5 ? "Bush01" : "Bush02_en";
    if (k < 0.085) return r() < 0.8 ? "Rock_4" : "Rock_3";
    if (k < 0.09 && open > 0.5) return "rock4_forest";
    if (firs && k < 0.095) return "Pickable_Thistle";
    if (k < 0.1) return "Pickable_Stone";
    if (k < 0.104) return "Pickable_Flint";
    if (!firs && k < 0.11) return "Pickable_Dandelion";
    if (!firs && dense < 0.2 && k < 0.114) return "RaspberryBush";
    if (firs && k < 0.116) return "Pickable_Mushroom_yellow";
    return null;
  });
  // Where wood was cut: stumps and a few logs at the clearing's edge.
  const r = rng(41);
  for (let i = 0; i < 46; i++) {
    const a = r() * Math.PI * 2;
    const d = 34 + r() * 38;
    const x = 227 + Math.cos(a) * (31 + d);
    const z = -341 + Math.sin(a) * (27 + d);
    if (built(x, z, 2) || mockElevation(x, z) < 0.5) continue;
    const name = i % 6 === 0 ? (i % 12 === 0 ? "beech_log" : "beech_log_half") : i % 5 === 0 ? "OakStub" : "Beech_Stub";
    out.push([name, +x.toFixed(1), +z.toFixed(1), Math.floor(r() * 360), 1]);
  }
  // Copper in the fir wood, tin on the shore of the pond to the south-east.
  out.push(["rock4_copper", 268.4, -128.6, 30, 1.1], ["rock4_copper", 198.2, -96.3, 212, 0.95], ["rock4_copper", 391.5, -154.2, 95, 1]);
  out.push(["MineRock_Tin", 352.3, -452.1, 0, 1], ["MineRock_Tin", 357.9, -458.4, 140, 0.9], ["MineRock_Tin", 344.6, -449.7, 270, 1.1]);
  out.push(["HeathRockPillar", 120.4, -420.5, 15, 1.2], ["FirTree_log", 300.2, -170.5, 70, 1], ["FirTree_Stub", 302.6, -166.1, 0, 1]);
}

/** The swamp hut: twisted swamp trees, iron in mud piles, guck on the trunks. */
function swamp(out: Item[]) {
  region(out, -1460, 982, 380, 13, 0.46, (x, z, r) => {
    const d = fromBuilt(x, z);
    const open = Math.min(1, Math.max(0, (d - 18) / 30));
    const dense = (woods(x, z, 17) - 0.42) * 3 * open;
    if (r() < dense * 0.7) return r() < 0.6 ? "SwampTree1" : "SwampTree2";
    const k = r();
    if (k < 0.012 && open > 0) return "Bush01";
    if (k < 0.02) return "Rock_4";
    if (k < 0.026 && dense > 0) return "GuckSack";
    if (k < 0.03) return "Pickable_Branch";
    if (k < 0.033) return "Pickable_Mushroom";
    return null;
  });
  out.push(["mudpile", -1418.2, 1021.6, 40, 1], ["mudpile2", -1502.7, 948.3, 300, 1.1], ["mudpile", -1381.5, 905.2, 120, 0.9]);
  out.push(["Pickable_BogIronOre", -1412.1, 1030.3, 0, 1]);
}

/** The mountain hut: sparse snowy pines and firs, boulders, a silver vein, obsidian. */
function mountain(out: Item[]) {
  region(out, 1578, 1720, 360, 23, 0.5, (x, z, r) => {
    const d = fromBuilt(x, z);
    const open = Math.min(1, Math.max(0, (d - 20) / 30));
    const dense = (woods(x, z, 29) - 0.55) * 3 * open;
    if (r() < dense * 0.4) return r() < 0.7 ? "Pinetree_Snow" : "FirTree";
    const k = r();
    if (k < 0.02 && open > 0) return "rock1_mountain";
    if (k < 0.03) return "Rock_3";
    if (k < 0.034) return "Pickable_Stone";
    return null;
  });
  out.push(["silvervein", 1630.4, 1781.2, 80, 1], ["silvervein", 1519.8, 1792.6, 200, 0.9], ["MineRock_Obsidian", 1662.3, 1650.7, 0, 1], ["MineRock_Obsidian", 1666.9, 1655.1, 90, 1.1]);
}

/** Every mock nature object, in the agent's compact form. */
export function mockNature(): { kinds: NatureKind[]; items: NatureRow[] } {
  const all: Item[] = [];
  home(all);
  swamp(all);
  mountain(all);
  const index = new Map<string, number>();
  const kinds: NatureKind[] = [];
  const items: NatureRow[] = [];
  for (const [name, x, z, yaw, scale] of all) {
    if (built(x, z)) continue;
    let i = index.get(name);
    if (i === undefined) {
      const [category, species, size] = KINDS[name]!;
      i = kinds.push([name, category, species, size]) - 1;
      index.set(name, i);
    }
    items.push([i, x, z, yaw, scale]);
  }
  return { kinds, items };
}

/** The agent's answer for a box: objects whose position lies inside it, kinds renumbered. */
export function natureIn(all: { kinds: NatureKind[]; items: NatureRow[] }, box: readonly [number, number, number, number], generation: number, spoilers: boolean, max = 30_000): ApiNature {
  const [x0, z0, x1, z1] = box;
  const inside = all.items.filter((p) => p[1] >= x0 && p[1] <= x1 && p[2] >= z0 && p[2] <= z1);
  const keep = inside.slice(0, max);
  const index = new Map<number, number>();
  const kinds: NatureKind[] = [];
  const items = keep.map((p): NatureRow => {
    let i = index.get(p[0]);
    if (i === undefined) {
      i = kinds.push(all.kinds[p[0]]!) - 1;
      index.set(p[0], i);
    }
    return [i, p[1], p[2], p[3], p[4]];
  });
  return { generation, bbox: [x0, z0, x1, z1], spoilers, kinds, items, count: items.length, truncated: inside.length > keep.length };
}
