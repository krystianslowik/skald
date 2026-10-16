// Chests stacked on one spot: people pile them up, two or three high, and
// on a map seen from above they are one mark. Grouped by where they stand,
// never by id (ids change with the prefab), and ordered bottom to top.

import type { MapContainer } from "../types";

/** Chests whose centres are at most this far apart, seen from above, are one stack. */
export const STACK_REACH = 0.5;

export interface ChestStack {
  /** Bottom to top. */
  chests: MapContainer[];
  /** False when a chest has no height (an older agent): the order is then a guess. */
  ordered: boolean;
}

export interface StackPlace {
  stack: ChestStack;
  /** 0 for the bottom chest. */
  index: number;
}

/**
 * Chests grouped into stacks: union-find over chests within STACK_REACH of
 * each other, on a grid of that size so only neighbours are compared. Carts
 * and ships are never stacked. Every chest is in exactly one stack.
 */
export function groupStacks(containers: readonly MapContainer[]): ChestStack[] {
  const chests = containers.filter((c) => c.kind === "chest");
  const parent = chests.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const grid = new Map<string, number[]>();
  const cell = (v: number) => Math.floor(v / STACK_REACH);
  for (const [i, c] of chests.entries()) {
    const cx = cell(c.x);
    const cz = cell(c.z);
    for (let a = cx - 1; a <= cx + 1; a++) {
      for (let b = cz - 1; b <= cz + 1; b++) {
        for (const j of grid.get(`${a},${b}`) ?? []) {
          const o = chests[j]!;
          if (Math.hypot(o.x - c.x, o.z - c.z) <= STACK_REACH) parent[find(i)] = find(j);
        }
      }
    }
    const k = `${cx},${cz}`;
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  const by = new Map<number, MapContainer[]>();
  for (const [i, c] of chests.entries()) {
    const r = find(i);
    const list = by.get(r);
    if (list) list.push(c);
    else by.set(r, [c]);
  }
  return [...by.values()].map((list) => {
    const ordered = list.every((c) => typeof c.y === "number");
    // Without heights, the agent's "#n" order (bottom up on new agents) is the best guess.
    list.sort((a, b) => (ordered ? a.y! - b.y! : 0) || a.id.localeCompare(b.id, "en", { numeric: true }));
    return { chests: list, ordered };
  });
}

/**
 * A stack's chests in the order they are seen standing in front of it: the
 * top one first. `index` stays the level from the bottom (0 for the lowest),
 * so "1st from the bottom" is always the last row.
 */
export function topDown<T>(chests: readonly T[]): { chest: T; index: number }[] {
  return chests.map((chest, index) => ({ chest, index })).reverse();
}

/** Where each chest sits in its stack, by container id. */
export function stackIndex(stacks: readonly ChestStack[]): Map<string, StackPlace> {
  const out = new Map<string, StackPlace>();
  for (const stack of stacks) for (const [index, c] of stack.chests.entries()) out.set(c.id, { stack, index });
  return out;
}
