// Nature: the trees, stumps, logs, rocks, bushes, ore and pickables the world
// generated, from GET /api/nature. The compact answer is decoded once into
// plain items; how each kind is drawn (its tint, its name) is decided here, so
// it is tested without a canvas.

import type { ApiNature, NatureCategory } from "../types";
import { ChunkLoader } from "./pieceload";

export interface NatureItem {
  category: NatureCategory;
  /** A short species: "beech", "copper", "raspberry". */
  species: string;
  x: number;
  z: number;
  /** Degrees clockwise seen from above; also seeds a mark's small irregularities. */
  yaw: number;
  /** Plan-view size in metres: the kind's size times the object's scale. */
  size: number;
}

const CATEGORIES = new Set<NatureCategory>(["tree", "stump", "log", "rock", "bush", "ore", "pickable"]);

/** The answer's items, or null when it is not a nature answer (an older server, a proxy page). */
export function decodeNature(body: unknown): NatureItem[] | null {
  const b = body as Partial<ApiNature> | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.kinds) || !Array.isArray(b.items)) return null;
  const kinds = b.kinds.map((k) => (Array.isArray(k) && CATEGORIES.has(k[1]) && typeof k[3] === "number" ? { category: k[1], species: String(k[2]), size: k[3] } : null));
  const out: NatureItem[] = [];
  for (const row of b.items) {
    if (!Array.isArray(row)) continue;
    const k = kinds[row[0]];
    if (!k) continue;
    const [, x, z, yaw, scale] = row;
    if (![x, z, yaw, scale].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    out.push({ category: k.category, species: k.species, x, z, yaw, size: Math.max(0.1, k.size * (scale > 0 ? scale : 1)) });
  }
  return out;
}

/** Nature is fetched in squares this many metres a side: it is denser than floor plans. */
export const NATURE_CHUNK = 256;
/** Below this scale (px per metre) nature is not fetched; it fades in from FADE_FROM to FADE_FULL. */
export const NATURE_MIN_SCALE = 1;
export const NATURE_FADE_FROM = 0.8;
export const NATURE_FADE_FULL = 1.5;
/** Pickables show from this scale on. */
export const PICKABLE_SCALE = 8;
/** Below this scale crowns are a woodland mass; from here on each tree shows its own rim and trunk. */
export const TREE_DETAIL_SCALE = 4;

export function natureLoader(fetchImpl?: typeof fetch, clock?: () => number): ChunkLoader<NatureItem> {
  return new ChunkLoader({ path: "/api/nature", chunk: NATURE_CHUNK, decode: decodeNature }, fetchImpl, clock);
}

/** Which map layer an item belongs to: ore and pickables are resources, the rest is nature. */
export function natureLayer(category: NatureCategory): "nature" | "resources" {
  return category === "ore" || category === "pickable" ? "resources" : "nature";
}

/** Crown tints by tree species, as ink washes on the parchment. */
const TREE_TINT: Record<string, string> = {
  beech: "#7c9440",
  oak: "#5f7c30",
  birch: "#a7ad4e",
  pine: "#55744a",
  fir: "#466847",
  // Dark and muted: the swamp's old trees are mostly bark and moss.
  swamp: "#5c5a3b",
  yggashoot: "#7f93a4",
  ashwood: "#7d4f3c",
  snowpine: "#7a948f",
  snowfir: "#6c8a86",
};

/**
 * How a crown is drawn seen from above, by species: `lobes` round bumps
 * (or, `spiky`, as many points of a star, for conifers), `rough` how much
 * each one varies, `bulge` how round a lobe is, `crown` the share of the
 * tree's reach its foliage covers (below 1 leaves gaps: a sparse wood).
 */
export interface TreeStyle {
  lobes: number;
  rough: number;
  bulge: number;
  spiky: boolean;
  crown: number;
}

const BROADLEAF: TreeStyle = { lobes: 7, rough: 0.1, bulge: 0.12, spiky: false, crown: 1 };
const CONIFER: TreeStyle = { lobes: 9, rough: 0.06, bulge: 0, spiky: true, crown: 0.92 };

const TREE_STYLE: Record<string, TreeStyle> = {
  beech: BROADLEAF,
  // Broad and billowing.
  oak: { ...BROADLEAF, lobes: 9, bulge: 0.16, rough: 0.08 },
  // Small, neat and light.
  birch: { ...BROADLEAF, lobes: 6, rough: 0.06, bulge: 0.1, crown: 0.85 },
  pine: CONIFER,
  fir: { ...CONIFER, lobes: 10 },
  snowpine: CONIFER,
  snowfir: { ...CONIFER, lobes: 10 },
  // Ancient and gnarled: few, ragged lobes, small crowns with the water showing between.
  swamp: { lobes: 5, rough: 0.32, bulge: 0.2, spiky: false, crown: 0.72 },
  // Mistlands: wide, flat, soft-edged canopies.
  yggashoot: { ...BROADLEAF, lobes: 6, rough: 0.12, bulge: 0.22, crown: 1.05 },
  // Ashlands: charred and sparse, a few sharp points.
  ashwood: { lobes: 7, rough: 0.25, bulge: 0, spiky: true, crown: 0.8 },
};

/** The crown style of a tree species; broadleaf for anything not listed. */
export function treeStyle(species: string): TreeStyle {
  return TREE_STYLE[species] ?? BROADLEAF;
}

/** Rock fills by species; cliffs are outlined rather than filled. */
const ROCK_TINT: Record<string, string> = {
  boulder: "#8d8a82",
  mountain: "#9a9893",
  ice: "#aebfc7",
  pillar: "#857f74",
  mistlands: "#7c7d86",
  ashlands: "#5f524c",
  cliff: "#8a8279",
};

/** Ore marks: a fill that tells the metal apart, outlined in dark ink. */
const ORE_TINT: Record<string, string> = {
  copper: "#d27a32",
  tin: "#a9b6bd",
  iron: "#8f4a2b",
  silver: "#eef0f2",
  obsidian: "#3e2d4f",
  tar: "#1d1915",
  guck: "#6d9a2c",
  meteorite: "#7c2420",
  flametal: "#e2532a",
  giant: "#d8cdb2",
  softtissue: "#c98f8f",
  chitin: "#9aa47e",
};

/** Pickables by species: berries red, blue and yellow, stone grey, branches brown. */
const PICKABLE_TINT: Record<string, string> = {
  stone: "#8a8780",
  flint: "#6f6a64",
  branch: "#7a5530",
  dandelion: "#e8c63a",
  thistle: "#8b62b0",
  mushroom: "#c8402e",
  mushroom_yellow: "#e2b63a",
  mushroom_blue: "#4e7fc4",
  jotunpuffs: "#d9a23f",
  magecap: "#6a5cc8",
  smokepuff: "#9a9a8a",
  raspberry: "#c8283c",
  blueberry: "#3d5fc4",
  cloudberry: "#eaa72e",
  lingonberry: "#b0202c",
  carrotseeds: "#e07a2a",
  turnipseeds: "#c9b46c",
  onionseeds: "#b98ac0",
  barley: "#d8c06a",
  flax: "#7f9ccf",
  fiddlehead: "#5e8a3a",
  royaljelly: "#e9d27a",
  tar: "#1d1915",
  obsidian: "#3e2d4f",
  tin: "#a9b6bd",
  iron: "#8f4a2b",
  meteorite: "#7c2420",
  sulfur: "#e3d23a",
  voltureegg: "#e7dcc6",
};

export const STUMP_TINT = "#6b4a2b";
export const LOG_TINT = "#7a5634";
export const BUSH_TINT = "#9db46a";

/** The tint an item is drawn in. */
export function natureTint(category: NatureCategory, species: string): string {
  switch (category) {
    case "tree":
      return TREE_TINT[species] ?? TREE_TINT.beech!;
    case "rock":
      return ROCK_TINT[species] ?? ROCK_TINT.boulder!;
    case "ore":
      return ORE_TINT[species] ?? "#b07a44";
    case "pickable":
      return PICKABLE_TINT[species] ?? "#8a7a5a";
    case "stump":
      return STUMP_TINT;
    case "log":
      return LOG_TINT;
    case "bush":
      return BUSH_TINT;
  }
}

/** The i18n key of an ore deposit's name. */
export function oreKey(species: string): string {
  return `map.ore.${species}`;
}

/** What mining a deposit gives, as an item name (for its icon and name). */
export const ORE_YIELD: Record<string, string> = {
  copper: "CopperOre",
  tin: "TinOre",
  iron: "IronScrap",
  silver: "SilverOre",
  obsidian: "Obsidian",
  tar: "Tar",
  guck: "Guck",
  meteorite: "FlametalOre",
  softtissue: "Softtissue",
  flametal: "FlametalOreNew",
  chitin: "Chitin",
};

/**
 * A small stable number in [-1, 1] from an item's yaw and position, for the
 * irregularities that keep marks from looking stamped.
 */
export function wobble(item: Pick<NatureItem, "x" | "z" | "yaw">, salt = 0): number {
  let n = Math.imul(Math.round(item.x * 10), 374761393) ^ Math.imul(Math.round(item.z * 10), 668265263) ^ Math.imul(item.yaw + salt * 97, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return (((n ^ (n >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}
