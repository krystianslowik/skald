import { createHmac } from "node:crypto";
import { derivePlayers, WEEK_MS } from "./history";
import type { AgentEvent, ApiCatchup, ApiMap, CatchupPlayer, CatchupWorld } from "./types";

/** Away longer than this, or never here: the summary covers the last week instead. */
export const CATCHUP_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The start of the window a viewer asked for: their last visit, or the last
 * week when there was none, it does not parse, or it is more than 30 days
 * back. `clamped` says the week was used.
 */
export function catchupSince(raw: string | undefined, now: number): { since: number; clamped: boolean } {
  const at = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(at) || at < now - CATCHUP_MAX_MS) return { since: now - WEEK_MS, clamped: true };
  return { since: Math.min(at, now), clamped: false };
}

/** How long an agent stream has been open before its replayed backlog is surely stored. */
export const CATCHUP_SETTLE_MS = 30_000;

/** A restart this close to a restore, an update or a settings apply is part of it, not news of its own. */
const EXPLAINED_MS = 10 * 60 * 1000;

/**
 * What happened since `since`, from the stored events (ascending). The window
 * is (since, until]: an event at exactly `since` was in the last one read.
 * With the agent stream `live` (up, and past the backlog it replays on
 * connect) it runs to `now`. Otherwise events may still arrive late, stamped
 * inside the window, so it stops just short of the newest stored event (never
 * before `since`); reading it then cannot skip them.
 * Playtime is the part of each session inside the window: the fold up to
 * `since` is taken off the fold up to `until`, so a session that was open at
 * `since` counts only from there; events after `until` wait for the next
 * window. Routine saves and the game's own backups
 * are not news; join codes are never part of it.
 */
export function summarize(events: AgentEvent[], since: number, now: number, live = true): Omit<ApiCatchup, "clamped" | "bosses" | "world"> {
  const newest = Date.parse(events.at(-1)?.ts ?? "");
  // Just short of the newest event: a twin with the same time stored a moment later falls in the next window too.
  const until = live ? now : Math.max(since, Math.min(now, Number.isFinite(newest) ? newest - 1 : since));
  const upTo = (t: number) => {
    const i = events.findIndex((e) => Date.parse(e.ts) > t);
    return i === -1 ? events : events.slice(0, i);
  };
  const was = new Map(derivePlayers(upTo(since), since).map((p) => [p.name, p]));
  // Cut at `until` itself, even live: an event stamped a moment ahead of the clock belongs to the next window only.
  const atEnd = derivePlayers(upTo(until), until);
  const players: CatchupPlayer[] = [];
  for (const p of atEnd) {
    const old = was.get(p.name);
    const playtimeMs = p.playtimeMs - (old?.playtimeMs ?? 0);
    const sessions = p.sessions - (old?.sessions ?? 0);
    const deaths = p.deaths - (old?.deaths ?? 0);
    if (playtimeMs > 0 || sessions > 0 || deaths > 0) players.push({ name: p.name, playtimeMs, sessions, deaths, online: p.online });
  }
  players.sort((a, b) => b.playtimeMs - a.playtimeMs || a.name.localeCompare(b.name));

  let raids = 0;
  let backups = 0;
  let restores = 0;
  let settings = 0;
  const updates: string[] = [];
  /** Starts after a stop, and the restores, updates and applies that stop the server on purpose. */
  const starts: number[] = [];
  const planned: number[] = [];
  let lastStatus = "";
  let lastVersion = "";
  for (const e of events) {
    const at = Date.parse(e.ts);
    const inside = at > since && at <= until;
    const d = e.data;
    switch (e.type) {
      case "raid":
        if (inside) raids++;
        break;
      case "action":
        // Only a backup someone asked for; the game's own every two hours are routine.
        if (inside && d.name === "backup" && d.ok === true) backups++;
        break;
      case "admin":
        if (d.command !== "restore") break;
        planned.push(at);
        if (inside && d.step === "done" && d.result === "ok") restores++;
        break;
      case "settings_apply":
        if (d.state === "applying" || d.state === "applied") planned.push(at);
        break;
      case "server_state": {
        const status = String(d.status ?? "");
        // The first state ever seen is not a restart.
        if (status === "running" && lastStatus !== "" && lastStatus !== "running") starts.push(at);
        lastStatus = status;
        break;
      }
      case "version": {
        const v = String(d.version ?? "");
        // The first version seen is a baseline, not an update.
        if (v && lastVersion && v !== lastVersion) {
          planned.push(at);
          if (inside && !updates.includes(v)) updates.push(v);
        }
        if (v) lastVersion = v;
        break;
      }
      case "settings_changed":
        if (inside && Array.isArray(d.changedKeys) && d.changedKeys.length > 0) settings++;
        break;
    }
  }
  const restarts = starts.filter((at) => at > since && at <= until && !planned.some((p) => Math.abs(p - at) <= EXPLAINED_MS)).length;
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    partial: !live,
    players,
    raids,
    backups,
    restores,
    restarts,
    updates,
    settings,
  };
}

/**
 * The parts of the world a returning player may want to compare with what
 * they saw last time: portals, bases, ships and carts, the places someone
 * has found, and how much of the map is explored. Taken from the gated map,
 * so with spoilers off nothing undiscovered is in it; places are also kept
 * to found ones when spoilers are on.
 */
export function worldFacts(map: ApiMap): Omit<CatchupWorld, "id"> {
  const ex = map.explored;
  const m = map.meta;
  return {
    netTime: m.netTime,
    portals: map.portals.map((p) => ({ id: p.id, x: p.x, z: p.z })),
    bases: map.bases.map((b) => ({ x: b.x, z: b.z })),
    ships: map.vehicles.filter((v) => v.kind !== "Cart").length,
    carts: map.vehicles.filter((v) => v.kind === "Cart").length,
    places: map.locations.filter((l) => l.kind !== "start" && l.placed && l.explored).map((l) => ({ kind: l.kind, name: l.name, x: l.x, z: l.z })),
    exploredM2: ex.available ? Math.round(ex.pixels * ex.metersPerPixel * ex.metersPerPixel) : null,
  };
}

/**
 * The opaque identity of a world: an HMAC of its seed name and seed under the
 * panel's session secret. It tells one world from another (a new world,
 * another seed) and stays the same across saves and game updates. Keyed, so a
 * viewer cannot try seed names against it to recover the seed.
 */
export function worldId(secret: string, seedName: string, seed: number): string {
  return createHmac("sha256", secret).update(`${seedName}|${seed}`).digest("base64url").slice(0, 16);
}
