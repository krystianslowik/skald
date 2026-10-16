// Chests stacked on one spot: people pile them up, two or three high, and
// on a map seen from above they are one mark. Grouped by where they stand,
// never by id (ids change with the prefab), and ordered bottom to top.

import type { MapContainer } from "../types";

/**
 * How far apart two stacked chests' centres may be along x and along z.
 * People set each chest a little off the one below (0.4 to 0.6 m is common)
 * and a wood chest is about 1.0 x 0.6 m; the save has no turn for it, so
 * a footprint overlap on both axes is taken as under 0.8 m. Two columns of
 * chests side by side stand 0.85 m and more apart and stay two stacks.
 */
export const STACK_REACH = 0.8;
/** One chest on another: its pivot 0.8 to 1.0 m higher. */
const LEVEL_MIN = 0.5;
/** Up to a level and a bit more: a chest on a shelf over another still belongs to it, a loft floor (3 m) does not. */
const LEVEL_MAX = 2.2;
/** Without heights (an older agent), only chests on one spot can be told to be a stack. */
const FLAT_REACH = 0.5;

/**
 * Whether two chests are neighbours in a stack: their footprints overlap
 * seen from above and one stands a level (or a shelf) over the other.
 * Chests side by side at one height never are, however close.
 */
function stacked(a: MapContainer, b: MapContainer): boolean {
  const dx = Math.abs(a.x - b.x);
  const dz = Math.abs(a.z - b.z);
  if (typeof a.y !== "number" || typeof b.y !== "number") return Math.hypot(dx, dz) <= FLAT_REACH;
  const dy = Math.abs(a.y - b.y);
  return dx < STACK_REACH && dz < STACK_REACH && dy >= LEVEL_MIN && dy <= LEVEL_MAX;
}

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
 * Chests grouped into stacks: union-find over chests that stand on one
 * another (see stacked), so a pile chains level by level even when each
 * chest drifts a little further sideways; on a grid of STACK_REACH so only
 * neighbours are compared. Carts
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
          if (stacked(o, c)) parent[find(i)] = find(j);
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
