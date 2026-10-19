// "Since you were last here": what this browser saw when it last marked the
// card read, and what changed since. Kept per device in localStorage; the
// server keeps nothing per viewer.
import type { ApiCatchup, CatchupPlayer, CatchupWorld, MapPoint } from "../types";

const KEY = "skald.catchup";

/** The world as it was when the card was last read. */
export interface Baseline {
  /** The world's opaque identity, and its clock at the save. */
  id: string;
  netTime: number;
  portals: string[];
  bases: [x: number, z: number][];
  ships: number;
  carts: number;
  places: string[];
  exploredM2: number | null;
}

export interface Seen {
  /** The end of the window last read (the server's clock). */
  at: string;
  /** Defeated bosses then; null when the save could not be read. */
  bosses: string[] | null;
  /** Null when the world map was off or not ready. */
  world: Baseline | null;
}

/** A base this close to one seen before is the same base, grown. */
const SAME_BASE_M = 64;
/** Explored land grows by at least this much before it is news (0.05 km²). */
const EXPLORED_MIN_M2 = 50_000;

export type CatchupItem =
  | { kind: "player"; player: CatchupPlayer }
  | { kind: "boss"; key: string }
  | { kind: "place"; place: CatchupWorld["places"][number] }
  | { kind: "places"; n: number; at: MapPoint }
  | { kind: "bases"; n: number; at: MapPoint }
  | { kind: "portals"; n: number; at: MapPoint }
  | { kind: "ships" | "carts" | "shipsLost" | "cartsLost"; n: number }
  | { kind: "explored"; m2: number }
  | { kind: "raids" | "backups" | "restores" | "restarts" | "settings"; n: number }
  | { kind: "update"; version: string };

const placeKey = (p: { kind: string; name: string; x: number; z: number }) => `${p.kind}:${p.name}@${Math.round(p.x)},${Math.round(p.z)}`;

/**
 * What to remember when the card is read. A world or bosses the answer could
 * not give (map off, save unreadable) keep what was known before, so one such
 * read does not wipe the baseline and turn the next one into a pile of news.
 */
export function seenOf(c: ApiCatchup, prev?: Seen | null): Seen {
  const w = c.world;
  return {
    at: c.until,
    bosses: c.bosses ?? prev?.bosses ?? null,
    world: w
      ? {
          id: w.id,
          netTime: w.netTime,
          portals: w.portals.map((p) => p.id),
          bases: w.bases.map((b) => [Math.round(b.x), Math.round(b.z)]),
          ships: w.ships,
          carts: w.carts,
          places: w.places.map(placeKey),
          exploredM2: w.exploredM2,
        }
      : (prev?.world ?? null),
  };
}

/** Another world, or an older copy put back (its clock went back): the stored world no longer applies. */
function otherWorld(c: ApiCatchup, seen: Seen | null): boolean {
  const old = seen?.world;
  const w = c.world;
  return !!old && !!w && (old.id !== w.id || w.netTime < old.netTime);
}

/**
 * The baseline to store at once when the world is another one, keeping the
 * time read so the window's other news stays; null when nothing changes.
 * Without it such a change with nothing else to say would leave no "Got it"
 * to tap, and the stale baseline would hide world news for good. A restore is
 * left to "Got it": it is a line of its own, and taking the world on every
 * answer would swallow what was built after it.
 */
export function rebaseOf(c: ApiCatchup, seen: Seen | null): Seen | null {
  if (!seen || !otherWorld(c, seen)) return null;
  const next = { ...seenOf(c, seen), at: seen.at };
  return JSON.stringify(next) === JSON.stringify(seen) ? null : next;
}

/** One line per kind of news, players first, in the order the card shows them. */
export function catchupItems(c: ApiCatchup, seen: Seen | null): CatchupItem[] {
  // Someone still playing who was already on at the start is not news yet.
  const out: CatchupItem[] = c.players.filter((p) => p.sessions > 0 || p.deaths > 0 || !p.online).map((player) => ({ kind: "player", player }));
  // The world is compared with what this browser saw when it last read the
  // card, however long ago: a snapshot, not a window. Another world, an older
  // copy put back (its clock went back) or a restore makes that snapshot
  // meaningless: no world lines, and reading the card takes a new one.
  const old = seen?.world;
  const w = c.world;
  // A restore in the window also puts back an older world; its own line says so.
  const rebase = c.restores > 0 || otherWorld(c, seen);
  if (!rebase && seen?.bosses && c.bosses) for (const key of c.bosses) if (!seen.bosses.includes(key)) out.push({ kind: "boss", key });
  if (!rebase && old && w) {
    const known = new Set(old.places);
    const found = w.places.filter((p) => !known.has(placeKey(p)));
    if (found.length > 0 && found.length <= 3) for (const place of found) out.push({ kind: "place", place });
    else if (found.length > 3) out.push({ kind: "places", n: found.length, at: found[0]! });
    const bases = w.bases.filter((b) => !old.bases.some(([x, z]) => Math.hypot(b.x - x, b.z - z) < SAME_BASE_M));
    if (bases.length > 0) out.push({ kind: "bases", n: bases.length, at: bases[0]! });
    const portalIds = new Set(old.portals);
    const portals = w.portals.filter((p) => !portalIds.has(p.id));
    if (portals.length > 0) out.push({ kind: "portals", n: portals.length, at: portals[0]! });
    if (w.ships > old.ships) out.push({ kind: "ships", n: w.ships - old.ships });
    if (w.ships < old.ships) out.push({ kind: "shipsLost", n: old.ships - w.ships });
    if (w.carts > old.carts) out.push({ kind: "carts", n: w.carts - old.carts });
    if (w.carts < old.carts) out.push({ kind: "cartsLost", n: old.carts - w.carts });
    if (w.exploredM2 !== null && old.exploredM2 !== null && w.exploredM2 - old.exploredM2 >= EXPLORED_MIN_M2) out.push({ kind: "explored", m2: w.exploredM2 - old.exploredM2 });
  }
  if (c.raids > 0) out.push({ kind: "raids", n: c.raids });
  for (const version of c.updates) out.push({ kind: "update", version });
  if (c.restarts > 0) out.push({ kind: "restarts", n: c.restarts });
  if (c.restores > 0) out.push({ kind: "restores", n: c.restores });
  if (c.backups > 0) out.push({ kind: "backups", n: c.backups });
  if (c.settings > 0) out.push({ kind: "settings", n: c.settings });
  return out;
}

/** What this browser read last; null on a first visit or where storage is refused. */
export function readSeen(): Seen | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Seen> | null;
    if (!raw || typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at))) return null;
    const w = raw.world;
    const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
    const ok =
      !!w &&
      typeof w === "object" &&
      typeof w.id === "string" &&
      Number.isFinite(w.netTime) &&
      strings(w.portals) &&
      strings(w.places) &&
      Array.isArray(w.bases) &&
      w.bases.every((b) => Array.isArray(b) && b.length === 2 && b.every(Number.isFinite)) &&
      Number.isFinite(w.ships) &&
      Number.isFinite(w.carts) &&
      (w.exploredM2 === null || Number.isFinite(w.exploredM2));
    return { at: raw.at, bosses: strings(raw.bosses) ? raw.bosses! : null, world: ok ? w : null };
  } catch {
    return null;
  }
}

/** Remembers the card as read; where storage refuses, it is read for this visit only. */
export function writeSeen(seen: Seen): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    // private mode or full: the caller keeps it in memory
  }
}
