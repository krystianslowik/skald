// The portal network: portals grouped by tag, what is wrong with them, and
// the shortest way from one spot to another through them. Pure functions over
// the save's portal list; no React, no text (the sheet translates).
//
// Portals are matched by id, never by position: two portals on one spot get
// ids "x,z" and "x,z#1". A portal leads where `pairedWith` says (the agent
// pairs them the way the game does); a tag alone connects nothing.

import type { MapPortal } from "../types";

export interface Spot {
  x: number;
  z: number;
}

export interface PortalGroup {
  /** The shared tag; "" for untagged portals, and for every group when names are hidden. */
  tag: string;
  portals: MapPortal[];
}

export interface PortalWarnings {
  /** Portals that lead nowhere: no partner, or a partner missing from the save. */
  noPartner: MapPortal[];
  /** Tags on more than two portals: only one pair of them connects. */
  crowded: PortalGroup[];
  /** Portals with an empty tag. */
  untagged: MapPortal[];
}

/** The partner of each portal whose partner is in the save (and points back). */
export function partners(portals: readonly MapPortal[]): Map<string, MapPortal> {
  const byId = new Map(portals.map((p) => [p.id, p]));
  const out = new Map<string, MapPortal>();
  for (const p of portals) {
    const q = p.pairedWith ? byId.get(p.pairedWith) : undefined;
    if (q && q.id !== p.id && q.pairedWith === p.id) out.set(p.id, q);
  }
  return out;
}

const byPlace = (a: MapPortal, b: MapPortal) => a.x - b.x || a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Portals by tag, tags in alphabetical order with the untagged last. With
 * names hidden every tag is empty, so the groups are the connected pairs
 * (then the lone portals) instead.
 */
export function portalGroups(portals: readonly MapPortal[], showNames: boolean): PortalGroup[] {
  if (!showNames) {
    const pair = partners(portals);
    const seen = new Set<string>();
    const pairs: PortalGroup[] = [];
    const lone: PortalGroup[] = [];
    for (const p of [...portals].sort(byPlace)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const q = pair.get(p.id);
      if (q) {
        seen.add(q.id);
        pairs.push({ tag: "", portals: [p, q] });
      } else lone.push({ tag: "", portals: [p] });
    }
    return [...pairs, ...lone];
  }
  // A tag of only spaces is no tag.
  const tags = new Map<string, MapPortal[]>();
  for (const p of portals) {
    const tag = p.tag.trim() === "" ? "" : p.tag;
    const list = tags.get(tag);
    if (list) list.push(p);
    else tags.set(tag, [p]);
  }
  return [...tags.entries()]
    .map(([tag, list]) => ({ tag, portals: list.sort(byPlace) }))
    .sort((a, b) => (a.tag === "" ? 1 : b.tag === "" ? -1 : a.tag.localeCompare(b.tag)));
}

/**
 * What needs a look. Tag checks need the tags: with names hidden only the
 * missing partners are reported.
 */
export function portalWarnings(portals: readonly MapPortal[], showNames: boolean): PortalWarnings {
  const pair = partners(portals);
  const noPartner = portals.filter((p) => !pair.has(p.id)).sort(byPlace);
  if (!showNames) return { noPartner, crowded: [], untagged: [] };
  const crowded = portalGroups(portals, true).filter((g) => g.tag !== "" && g.portals.length > 2);
  const untagged = portals.filter((p) => p.tag.trim() === "").sort(byPlace);
  return { noPartner, crowded, untagged };
}

/** True when nothing is wrong. */
export function noWarnings(w: PortalWarnings): boolean {
  return w.noPartner.length === 0 && w.crowded.length === 0 && w.untagged.length === 0;
}

/**
 * What a hop through a portal costs, in metres of walking: the loading
 * screen. It keeps a route from taking a portal to save a few steps.
 */
export const HOP_M = 60;

/** Walking legs shorter than this are counted but not listed. */
export const MIN_LEG_M = 1;

/** A point a route passes: the start, the end, or a portal. */
export interface Stop extends Spot {
  portal?: MapPortal;
}

export type Leg =
  | { kind: "walk"; from: Stop; to: Stop; m: number }
  | { kind: "hop"; from: MapPortal; to: MapPortal };

export interface Route {
  legs: Leg[];
  /** Metres walked, all walking legs together (straight lines). */
  walk: number;
  hops: number;
  /** Metres from start to end as the crow flies, without portals. */
  direct: number;
}

const dist = (a: Spot, b: Spot) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * The shortest way from `from` to `to`: straight walking legs between
 * portals, and hops through connected pairs (each costing `hop` metres).
 * Walking ignores water and mountains; it is the crow's line between stops.
 * With no portal worth taking the route is one walking leg; a start on the
 * end has none.
 */
export function findRoute(from: Spot, to: Spot, portals: readonly MapPortal[], hop = HOP_M): Route {
  const pair = partners(portals);
  // Only connected portals help: walking to a dead end and on is never shorter than walking on.
  const net = portals.filter((p) => pair.has(p.id));
  const nodes: Stop[] = [{ x: from.x, z: from.z }, { x: to.x, z: to.z }, ...net.map((p) => ({ x: p.x, z: p.z, portal: p }))];
  const index = new Map(net.map((p, i) => [p.id, i + 2]));
  const n = nodes.length;
  const cost = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const viaHop = new Array<boolean>(n).fill(false);
  const done = new Array<boolean>(n).fill(false);
  cost[0] = 0;
  // Dense graph (everything walks to everything): the O(n^2) Dijkstra is the right one.
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && cost[i]! < Infinity && (u < 0 || cost[i]! < cost[u]!)) u = i;
    if (u < 0 || u === 1) break;
    done[u] = true;
    const at = nodes[u]!;
    for (let v = 0; v < n; v++) {
      if (done[v] || v === 0) continue;
      const c = cost[u]! + dist(at, nodes[v]!);
      if (c < cost[v]!) {
        cost[v] = c;
        prev[v] = u;
        viaHop[v] = false;
      }
    }
    const other = at.portal ? pair.get(at.portal.id) : undefined;
    const w = other ? index.get(other.id) : undefined;
    if (w !== undefined && !done[w]) {
      const c = cost[u]! + hop;
      if (c < cost[w]!) {
        cost[w] = c;
        prev[w] = u;
        viaHop[w] = true;
      }
    }
  }
  const path: number[] = [];
  for (let v = 1; v >= 0; v = prev[v]!) path.unshift(v);
  const legs: Leg[] = [];
  let walk = 0;
  let hops = 0;
  for (let i = 1; i < path.length; i++) {
    const a = nodes[path[i - 1]!]!;
    const b = nodes[path[i]!]!;
    if (viaHop[path[i]!]) {
      legs.push({ kind: "hop", from: a.portal!, to: b.portal! });
      hops++;
      continue;
    }
    const m = dist(a, b);
    walk += m;
    // A step onto a portal on the same spot is not worth a line of its own.
    if (m >= MIN_LEG_M) legs.push({ kind: "walk", from: a, to: b, m });
  }
  return { legs, walk, hops, direct: dist(from, to) };
}

/** A named place a portal can be described by ("near Hearthstead"). */
export interface Place extends Spot {
  name: string;
}

/** A portal further than this from every named place is given by its coordinates. */
export const NEAR_M = 300;

/** The closest named place within `reach` metres, or null. */
export function nearestPlace(at: Spot, places: readonly Place[], reach = NEAR_M): Place | null {
  let best: Place | null = null;
  let bestD = reach;
  for (const p of places) {
    if (!p.name) continue;
    const d = dist(at, p);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}
