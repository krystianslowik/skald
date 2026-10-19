// What a few things cost to build, for expanding a task's material list.
// A short hand-kept table, not data read from the game: the agent and the
// icons sidecar read item icons and inventories, never recipes, and the
// project ships nothing taken out of the game's files. Quantities are those
// of Valheim 1.0; a correction is a one-line change. Names are item prefabs,
// so every material already has a label in both languages (`item.<prefab>`).
// Kept free of Bun/Node imports: the web compiles it via `@server/*`.

import { TASK_LIMITS, type TaskMaterial, type TaskTarget } from "./taskmodel";

export type RecipeKind = "station" | "piece" | "vehicle" | "offering";

export interface Recipe {
  /** The thing's prefab, or for an offering the boss's global key; its label is `task.recipe.<id>`. */
  id: string;
  kind: RecipeKind;
  materials: readonly TaskMaterial[];
  /** An offering's boss, set as the task's target when it is picked. */
  target?: TaskTarget;
}

const m = (pairs: Record<string, number>): TaskMaterial[] => Object.entries(pairs).map(([item, qty]) => ({ item, qty }));
const boss = (key: string): TaskTarget => ({ kind: "boss", key });

export const RECIPE_KINDS: readonly RecipeKind[] = ["station", "piece", "vehicle", "offering"];

export const RECIPES: readonly Recipe[] = [
  { id: "piece_workbench", kind: "station", materials: m({ Wood: 10 }) },
  { id: "forge", kind: "station", materials: m({ Stone: 4, Coal: 4, Wood: 10, Copper: 6 }) },
  { id: "smelter", kind: "station", materials: m({ Stone: 50, SurtlingCore: 5 }) },
  { id: "charcoal_kiln", kind: "station", materials: m({ Stone: 20, SurtlingCore: 5 }) },
  { id: "piece_cauldron", kind: "station", materials: m({ Tin: 10 }) },
  { id: "fermenter", kind: "station", materials: m({ FineWood: 30, Bronze: 5, Resin: 10 }) },
  { id: "piece_stonecutter", kind: "station", materials: m({ Wood: 10, Iron: 2, Stone: 4 }) },
  { id: "piece_artisanstation", kind: "station", materials: m({ Wood: 10, DragonTear: 2 }) },
  { id: "blastfurnace", kind: "station", materials: m({ Stone: 20, SurtlingCore: 5 }) },
  { id: "portal_wood", kind: "piece", materials: m({ FineWood: 20, GreydwarfEye: 10, SurtlingCore: 2 }) },
  { id: "piece_chest_wood", kind: "piece", materials: m({ Wood: 10 }) },
  { id: "piece_chest", kind: "piece", materials: m({ FineWood: 10, Iron: 2 }) },
  { id: "bed", kind: "piece", materials: m({ Wood: 8 }) },
  { id: "fire_pit", kind: "piece", materials: m({ Stone: 5, Wood: 2 }) },
  { id: "piece_beehive", kind: "piece", materials: m({ Wood: 10, QueenBee: 1 }) },
  { id: "Cart", kind: "vehicle", materials: m({ Wood: 20, BronzeNails: 10 }) },
  { id: "Raft", kind: "vehicle", materials: m({ Wood: 20, LeatherScraps: 6, Resin: 6 }) },
  { id: "Karve", kind: "vehicle", materials: m({ FineWood: 30, DeerHide: 10, Resin: 20, BronzeNails: 80 }) },
  { id: "VikingShip", kind: "vehicle", materials: m({ FineWood: 40, RoundLog: 40, IronNails: 100, DeerHide: 10 }) },
  { id: "defeated_eikthyr", kind: "offering", materials: m({ TrophyDeer: 2 }), target: boss("defeated_eikthyr") },
  { id: "defeated_gdking", kind: "offering", materials: m({ AncientSeed: 3 }), target: boss("defeated_gdking") },
  { id: "defeated_bonemass", kind: "offering", materials: m({ WitheredBone: 10 }), target: boss("defeated_bonemass") },
  // Eggs count wherever the index sees them: chests, and carts, the usual way to haul them (they cannot go through a portal).
  { id: "defeated_dragon", kind: "offering", materials: m({ DragonEgg: 3 }), target: boss("defeated_dragon") },
  { id: "defeated_goblinking", kind: "offering", materials: m({ GoblinTotem: 5 }), target: boss("defeated_goblinking") },
  { id: "defeated_fader", kind: "offering", materials: m({ BellFragment: 3 }), target: boss("defeated_fader") },
];

/**
 * A material list with a recipe's lines added, `times` over: items already
 * listed add up (to the limit of one line), new ones go at the end.
 */
export function expandRecipe(list: readonly TaskMaterial[], recipe: Recipe, times = 1): TaskMaterial[] {
  const out = new Map(list.map((l) => [l.item, l.qty]));
  for (const r of recipe.materials) out.set(r.item, Math.min(TASK_LIMITS.qty, (out.get(r.item) ?? 0) + r.qty * times));
  return [...out].map(([item, qty]) => ({ item, qty }));
}
