// Adding items to a chest from the map (agent command chest-add, bridge
// POST /v1/containers/add). The map shows chests as the last world save left
// them, so what an admin put in since is kept here until a save shows it.

import { useSyncExternalStore } from "react";
import type { MapContainer, MapItem } from "../types";
import { stackSize } from "./admin";

/** One slot the bridge filled: how many went in and the stack it holds now. */
export interface ChestSlot {
  x: number;
  y: number;
  added: number;
  stack: number;
}

/** The bridge's answer to chest-add. */
export interface ChestAddResult {
  item: string;
  amount: number;
  /** A player had the chest's area loaded: they see it within a second. */
  loaded: boolean;
  /** How many more of the item would still fit. */
  room: number;
  slots: ChestSlot[];
}

/** The plugin's cap on one add. */
export const MAX_CHEST_ADD = 9999;

/** Only chests that stay put take items, ones the save could read, with the height that tells stacked chests apart (agents before 2026.10 send none). */
export const canAddTo = (c: MapContainer): boolean => c.kind === "chest" && !c.unreadable && c.width > 0 && typeof c.y === "number";

/**
 * How many of `item` fit, by the stack size the web knows (the bridge checks
 * the real one): the free space of its quality-1 stacks, plus a full stack
 * for every empty slot. A stack already bigger than the guess raises it.
 */
export function chestRoom(c: Pick<MapContainer, "width" | "height">, items: readonly MapItem[], item: string): number {
  const max = Math.max(stackSize(item), ...items.filter((i) => i.name === item).map((i) => i.stack));
  const rows = Math.max(c.height, ...items.map((i) => i.y + 1));
  const used = new Set(items.filter((i) => i.x < c.width).map((i) => `${i.x},${i.y}`));
  const free = items.filter((i) => i.name === item && (i.quality ?? 1) === 1).reduce((n, i) => n + Math.max(0, max - i.stack), 0);
  return Math.min(MAX_CHEST_ADD, free + Math.max(0, c.width * rows - used.size) * max);
}

/** The items after an add: the slots the bridge reported, grown or new. */
export function withSlots(items: readonly MapItem[], item: string, slots: readonly ChestSlot[]): MapItem[] {
  const out = items.map((i) => ({ ...i }));
  for (const s of slots) {
    const hit = out.find((i) => i.x === s.x && i.y === s.y);
    if (hit) hit.stack = s.stack;
    else out.push({ name: item, stack: s.stack, x: s.x, y: s.y });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

// ---- pending until the next save --------------------------------------------

/** A chest's contents after adds, and the saved contents they were made on. */
interface Pending {
  saved: string;
  items: MapItem[];
}

const pending = new Map<string, Pending>();
const listeners = new Set<() => void>();
let version = 0;

const fingerprint = (items: readonly MapItem[]) => JSON.stringify(items.map((i) => [i.name, i.stack, i.x, i.y, i.quality ?? 1]));

/** The live contents of a chest, or null when nothing was added since the save it shows. */
export function pendingItems(c: MapContainer): MapItem[] | null {
  const p = pending.get(c.id);
  // A newer save holds something else: it is the truth again.
  return p && p.saved === fingerprint(c.items) ? p.items : null;
}

/** Remembers what the chest holds now that `slots` went in. */
export function notePending(c: MapContainer, item: string, slots: readonly ChestSlot[]): MapItem[] {
  const items = withSlots(pendingItems(c) ?? c.items, item, slots);
  pending.set(c.id, { saved: fingerprint(c.items), items });
  version++;
  for (const fn of listeners) fn();
  return items;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Re-renders when a chest gets items; returns the live contents (or null) for `c`. */
export function usePendingItems(c: MapContainer | undefined): MapItem[] | null {
  useSyncExternalStore(subscribe, () => version);
  return c ? pendingItems(c) : null;
}

/** For tests. */
export function clearPending(): void {
  pending.clear();
  version++;
  for (const fn of listeners) fn();
}
