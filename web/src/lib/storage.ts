// Player storage: item names and categories, the village's totals and item
// search. Item names come from the dictionaries (`item.<Prefab>`) for the
// common things and a prettified prefab name for the rest. Search matches every
// loaded language whatever the UI language, so "iron" and "żelazo" find the
// same; a search box loads the other dictionaries once used (`useEveryLocale`).

import { loadedDicts, localesVersion } from "../i18n/load";
import type { MapContainer, MapItem } from "../types";

export type Category = "wood" | "ore" | "metal" | "food" | "seed" | "material" | "weapon" | "armor" | "tool" | "trophy" | "misc";

/** Display order of the stores' groups. */
export const CATEGORIES: readonly Category[] = ["wood", "ore", "metal", "food", "seed", "material", "weapon", "armor", "tool", "trophy", "misc"];

const WOOD = /^(Wood|FineWood|RoundLog|ElderBark|YggdrasilWood|Blackwood|Ashwood)$/;
const METAL = /^(Copper|Tin|Bronze|Iron|Silver|BlackMetal|Flametal|Gold|BronzeNails|IronNails)$/;
const ORE = /(Ore|Scrap)$/;
const SEED = /(Seeds?|Cone)$|^(Acorn|AncientSeed|Sapling.*)$/;

const BY_TYPE: Record<string, Category> = {
  Consumable: "food",
  Fish: "food",
  OneHandedWeapon: "weapon",
  TwoHandedWeapon: "weapon",
  TwoHandedWeaponLeft: "weapon",
  Bow: "weapon",
  Ammo: "weapon",
  AmmoNonEquipable: "weapon",
  Shield: "armor",
  Helmet: "armor",
  Chest: "armor",
  Legs: "armor",
  Shoulder: "armor",
  Utility: "armor",
  Trinket: "armor",
  Tool: "tool",
  Torch: "tool",
  Trophy: "trophy",
  Misc: "misc",
};

/** What kind of thing an item is, from its prefab name and the game's item type. */
export function itemCategory(name: string, type?: string): Category {
  if (WOOD.test(name)) return "wood";
  if (METAL.test(name)) return "metal";
  if (ORE.test(name)) return "ore";
  if (SEED.test(name)) return "seed";
  if (name.startsWith("Trophy")) return "trophy";
  if (type && BY_TYPE[type]) return BY_TYPE[type]!;
  return type === "Material" ? "material" : "misc";
}

function words(name: string): string[] {
  return name
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/);
}

const sentence = (ws: string[]) => ws.map((w, i) => (i === 0 ? w : /^[A-Z][a-z]/.test(w) ? w.toLowerCase() : w)).join(" ");

/** Gear is named noun first ("SwordBronze"); people say the material first. */
const GEAR = new Set(["Sword", "Axe", "Battleaxe", "Bow", "Crossbow", "Knife", "Mace", "Sledge", "Atgeir", "Spear", "Shield", "Pickaxe", "Arrow", "Bolt", "Helmet", "Cape", "Trinket", "Club", "Trophy"]);

/**
 * A readable name from a prefab: "SwordBronze" -> "Bronze sword",
 * "ArmorTrollLeatherChest" -> "Troll leather chest", "TrophyDeer" -> "Deer
 * trophy", anything else split into words. "#1a2b3c4d" stays as it is.
 */
export function prettify(name: string): string {
  if (name.startsWith("#")) return name;
  const ws = words(name);
  if (ws[0] === "Armor" && ws.length > 2) return sentence(ws.slice(1));
  if (GEAR.has(ws[0]!) && ws.length > 1 && /^[A-Z]/.test(ws[1]!)) return sentence([...ws.slice(1), ws[0]!.toLowerCase()]);
  return sentence(ws);
}

type Lookup = (key: string) => string | undefined;

/** The item's name in the UI language. */
export function itemLabel(name: string, lookup: Lookup): string {
  return lookup(`item.${name}`) ?? prettify(name);
}

/** Lower case without accents (and ł as l), for search in either language. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/Ł/g, "l").toLowerCase();
}

const searchCache = new Map<string, string>();
let cacheVersion = -1;

/**
 * Items the game itself marks as cut: Valheim's own name for them carries the
 * word UNUSED (ShieldKnight is "Knight shield UNUSED" in every language), so
 * they cannot be had in play and are never offered. Any loaded dictionary
 * tells, so it works whichever language this visit loaded.
 */
export function isUnusedItem(name: string): boolean {
  const key = `item.${name}`;
  return loadedDicts().some((d) => {
    const label = (d as Record<string, unknown>)[key];
    return typeof label === "string" && /\bUNUSED\b/.test(label);
  });
}

/** Everything an item can be found by: its names in the loaded languages and its prefab. */
export function itemSearchText(name: string): string {
  if (cacheVersion !== localesVersion()) {
    searchCache.clear();
    cacheVersion = localesVersion();
  }
  let s = searchCache.get(name);
  if (s === undefined) {
    const key = `item.${name}`;
    const names = loadedDicts().map((d) => (d as Record<string, unknown>)[key]);
    s = fold([...names, prettify(name), name].filter((x) => typeof x === "string").join(" | "));
    searchCache.set(name, s);
  }
  return s;
}

export function itemMatches(name: string, foldedQuery: string): boolean {
  return foldedQuery !== "" && itemSearchText(name).includes(foldedQuery);
}

/** Total count of things in a list of stacks. */
export const countItems = (items: readonly MapItem[]): number => items.reduce((n, i) => n + i.stack, 0);

export interface StorePlace {
  container: MapContainer;
  count: number;
}

export interface StoreEntry {
  name: string;
  label: string;
  category: Category;
  total: number;
  /** Where it is, most first. */
  places: StorePlace[];
}

/** One entry per item across every container, by category then name. */
export function aggregate(containers: readonly MapContainer[], lookup: Lookup): StoreEntry[] {
  const by = new Map<string, StoreEntry>();
  for (const c of containers) {
    const here = new Map<string, number>();
    const types = new Map<string, string | undefined>();
    for (const it of c.items) {
      here.set(it.name, (here.get(it.name) ?? 0) + it.stack);
      if (!types.has(it.name)) types.set(it.name, it.type);
    }
    for (const [name, count] of here) {
      let e = by.get(name);
      if (!e) {
        e = { name, label: itemLabel(name, lookup), category: itemCategory(name, types.get(name)), total: 0, places: [] };
        by.set(name, e);
      }
      e.total += count;
      e.places.push({ container: c, count });
    }
  }
  const order = new Map(CATEGORIES.map((c, i) => [c, i]));
  const out = [...by.values()];
  for (const e of out) e.places.sort((a, b) => b.count - a.count || a.container.id.localeCompare(b.container.id));
  return out.sort((a, b) => order.get(a.category)! - order.get(b.category)! || a.label.localeCompare(b.label));
}

/** Entries whose names (in either language) contain the query. */
export function searchStore(entries: readonly StoreEntry[], query: string): StoreEntry[] {
  const q = fold(query.trim());
  if (!q) return entries as StoreEntry[];
  return entries.filter((e) => fold(e.label).includes(q) || itemMatches(e.name, q));
}

/** A container's items that match the query, merged by name, most first. */
export function matchingItems(items: readonly MapItem[], foldedQuery: string, lookup: Lookup): { name: string; label: string; count: number }[] {
  const by = new Map<string, number>();
  for (const it of items) if (itemMatches(it.name, foldedQuery)) by.set(it.name, (by.get(it.name) ?? 0) + it.stack);
  return [...by].map(([name, count]) => ({ name, label: itemLabel(name, lookup), count })).sort((a, b) => b.count - a.count);
}

// Category glyphs: own simple line drawings on a 24 x 24 box, not the game's icons.
export const CATEGORY_GLYPH: Record<Category, string> = {
  // Two logs.
  wood: "M4 9h13a2.5 2.5 0 0 1 0 5H4a2.5 2.5 0 0 1 0-5zM17 11.5h.01M6 15h13a2.5 2.5 0 0 1 0 5H6a2.5 2.5 0 0 1 0-5zM19 17.5h.01",
  // A rough lump with veins.
  ore: "M5 16l2-7 6-3 6 4 1 7-6 3-7-1zM9 11l3 2 3-3M12 13v4",
  // An ingot.
  metal: "M3 16l3-7h12l3 7zM3 16h18M8 12h8",
  // A drumstick.
  food: "M14 4a6 6 0 0 1 0 12h-1l-5 5-2-2 5-5v-1a6 6 0 0 1 3-9z",
  // A sprout.
  seed: "M12 21v-8M12 13c0-4 3-7 7-7 0 4-3 7-7 7zM12 15c0-3-2-5-6-5 0 3 2 5 6 5z",
  // A bundle tied with a cord.
  material: "M6 7h12l-1 13H7zM6 7l2-3h8l2 3M10 11h4",
  // A sword.
  weapon: "M19 4l-9 9M15 4h4v4M7 13l4 4M8.5 15.5L4 20",
  // A helmet.
  armor: "M5 14a7 7 0 0 1 14 0v4h-4v-3H9v3H5zM12 7v8",
  // A hammer.
  tool: "M5 8l5-4 3 3-5 4zM9.5 9.5L19 19M17 21l4-4",
  // A horned skull.
  trophy: "M7 11a5 5 0 0 1 10 0v4l-2 2H9l-2-2zM7 9L4 5M17 9l3-4M10 12h.01M14 12h.01",
  // A small sack.
  misc: "M8 8h8l3 12H5zM9 8c0-2 1-4 3-4s3 2 3 4",
};
