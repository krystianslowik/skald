// The list a tapped pile of marks opens: what each container holds in a few
// words, the pile's combined top items, and the rows from fullest to empty.

import type { MapItem } from "../types";
import { itemCategory, itemLabel, type Category } from "./storage";
import { markerItems, markerStore, type Marker } from "./mapgeo";

type Lookup = (key: string) => string | undefined;

export interface Stack {
  name: string;
  label: string;
  category: Category;
  total: number;
}

export interface Summary {
  /** The biggest stacks, most first. */
  top: Stack[];
  /** How many more kinds of item there are past `top`. */
  more: number;
}

/** Items merged by name, the biggest total first. */
export function mergeStacks(items: readonly MapItem[], lookup: Lookup): Stack[] {
  const by = new Map<string, Stack>();
  for (const it of items) {
    const s = by.get(it.name);
    if (s) s.total += it.stack;
    else by.set(it.name, { name: it.name, label: itemLabel(it.name, lookup), category: itemCategory(it.name, it.type), total: it.stack });
  }
  return [...by.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

/** The `limit` biggest stacks and how many kinds are left out. */
export function summarize(items: readonly MapItem[], lookup: Lookup, limit = 3): Summary {
  const all = mergeStacks(items, lookup);
  return { top: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

/** "50× Wood". */
export const stackText = (s: Stack, number: (n: number) => string): string => `${number(s.total)}× ${s.label}`;

/** What a mark can say about its contents: none (not a container), or a list. */
export type Contents = { kind: "none" } | { kind: "unreadable" } | { kind: "noHold" } | { kind: "items"; items: readonly MapItem[] };

export function contentsOf(m: Marker): Contents {
  const store = markerStore(m);
  if (store) {
    if (store.unreadable) return { kind: "unreadable" };
    if (store.width === 0) return { kind: "noHold" };
    return { kind: "items", items: store.items };
  }
  const items = markerItems(m);
  return items ? { kind: "items", items } : { kind: "none" };
}

const total = (items: readonly MapItem[]) => items.reduce((n, i) => n + i.stack, 0);

/** Rows by number of items, most first, then marks with no contents, then empty ones. Ties keep their order. */
export function sortCluster(group: readonly Marker[]): Marker[] {
  const key = (m: Marker): [number, number] => {
    const c = contentsOf(m);
    if (c.kind === "none") return [1, 0];
    const n = c.kind === "items" ? total(c.items) : 0;
    return n > 0 ? [2, n] : [0, 0];
  };
  return group
    .map((m, i) => ({ m, i, k: key(m) }))
    .sort((a, b) => b.k[0] - a.k[0] || b.k[1] - a.k[1] || a.i - b.i)
    .map((x) => x.m);
}

/** Everything in the pile, merged: the header's top items. */
export function clusterSummary(group: readonly Marker[], lookup: Lookup, limit = 5): Summary {
  const items: MapItem[] = [];
  for (const m of group) {
    const c = contentsOf(m);
    if (c.kind === "items") items.push(...c.items);
  }
  return summarize(items, lookup, limit);
}
