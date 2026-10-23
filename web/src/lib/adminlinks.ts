// Each player's link and simulation load, for admins only. They come from
// GET /api/admin/players (the web tier checks the admin session), never from
// the public positions stream, and are polled only while something on the page
// shows them, the page is visible and the viewer may see them. One poll for
// every view: the admin rows and the player sheet share it.

import { useEffect, useSyncExternalStore } from "react";
import type { AdminPlayer } from "../types";
import { getAdminPlayers } from "./admin";

export type PlayerLink = Pick<AdminPlayer, "link" | "sim">;

/** How often the open admin views refresh it. */
export const LINKS_POLL_MS = 5000;

const EMPTY: ReadonlyMap<string, PlayerLink> = new Map();
let current = EMPTY;
const subs = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

function set(next: ReadonlyMap<string, PlayerLink>): void {
  current = next;
  for (const f of subs) f();
}

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

async function poll(): Promise<void> {
  timer = null;
  if (users === 0) return;
  if (!hidden() && !inFlight) {
    inFlight = true;
    try {
      const r = await getAdminPlayers();
      if (users > 0) set(r.data ? new Map(r.data.map((p) => [p.id ?? p.name, { link: p.link, sim: p.sim }])) : EMPTY);
    } catch {
      // Offline or logged out: the rest of the panel says so; keep the last values.
    } finally {
      inFlight = false;
    }
  }
  if (users > 0) timer = setTimeout(() => void poll(), LINKS_POLL_MS);
}

const onVisible = () => {
  if (!hidden() && users > 0) {
    if (timer) clearTimeout(timer);
    void poll();
  }
};

function start(): () => void {
  users += 1;
  if (users === 1) {
    document.addEventListener("visibilitychange", onVisible);
    void poll();
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    users -= 1;
    if (users > 0) return;
    document.removeEventListener("visibilitychange", onVisible);
    if (timer) clearTimeout(timer);
    timer = null;
    set(EMPTY);
  };
}

/** Reads the links again now instead of at the next poll (after a simulation handover). */
export function refreshAdminLinks(): void {
  if (users === 0 || inFlight) return;
  if (timer) clearTimeout(timer);
  void poll();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

/**
 * Players' links by player id while mounted with `on` (an unlocked admin);
 * empty otherwise, and nothing is fetched.
 */
export function useAdminLinks(on: boolean): ReadonlyMap<string, PlayerLink> {
  useEffect(() => (on ? start() : undefined), [on]);
  const links = useSyncExternalStore(subscribe, () => current, () => current);
  return on ? links : EMPTY;
}
