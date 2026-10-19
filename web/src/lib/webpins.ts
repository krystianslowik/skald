// Web pins: map pins placed on the panel (server/src/pins.ts), with a state
// (new, claimed, cleared, depleted). Kept outside React state like the live
// positions: the map's pin layer and the layers panel subscribe. /live sends
// the world's whole list when the socket opens (and again when the world on
// the map changes), then one pin per change (applied by useValheim).

import { useSyncExternalStore } from "react";
import { cutText, DONE_STATES, PIN_ICONS, PIN_NAME_MAX, PIN_STATES, sameName, tidyText, type PinExpect, type PinIcon, type PinState, type WebPin } from "@server/pintypes";
import type { IconId } from "./mapgeo";
import { Optimistic } from "./optimistic";

/** The map mark each web pin icon is drawn with (the map's own line drawings). */
export const PIN_ICON_MARK: Record<PinIcon, IconId> = {
  point: "pin-point",
  dungeon: "loc-dungeon",
  cave: "pin-cave",
  ore: "pin-hammer",
  boss: "pin-boss",
  fire: "pin-fire",
  home: "pin-home",
  chest: "chest",
  portal: "portal",
  trader: "loc-trader",
};

/** "idle" until the socket has sent the list. */
export type PinsLoad = "idle" | "ready";

interface Snapshot {
  pins: readonly WebPin[];
  load: PinsLoad;
}

let byId = new Map<string, WebPin>();
let snap: Snapshot = { pins: [], load: "idle" };
const subs = new Set<() => void>();
/** Pins deleted while this page was open: a late answer about one must not bring it back. */
const gone = new Set<string>();

/** The server's copies in `byId`, with this page's pending changes on top. */
function publish(load: PinsLoad = snap.load): void {
  const pins = [...byId.values()].flatMap((p) => optimistic.view(p.id, p) ?? []);
  snap = { pins: pins.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), load };
  for (const f of subs) f();
}

/** This page's changes still out: shown at once, taken back if the server refuses. */
const optimistic = new Optimistic<string, WebPin, PinCall>({
  server: (id) => byId.get(id),
  ok: (r) => r.ok,
  changed: () => publish(),
});

/** A pin this page can draw: a newer server may know icons or states this build does not. */
const known = (p: WebPin): boolean =>
  !!p && typeof p.id === "string" && typeof p.version === "number" && (PIN_ICONS as readonly string[]).includes(p.icon) && (PIN_STATES as readonly string[]).includes(p.state);

/** The copy to keep: never an older one (a slow answer behind a newer live frame), never a deleted one. */
function take(p: WebPin): boolean {
  if (!known(p) || gone.has(p.id)) return false;
  const have = byId.get(p.id);
  if (have && have.version >= p.version) return false;
  byId.set(p.id, p);
  return true;
}

/** The world's whole list ("pins" on /live). Copies newer than it (an answer that came first) stay. */
export function setPins(list: readonly WebPin[]): void {
  const prev = byId;
  byId = new Map();
  for (const p of list) {
    if (!known(p)) continue;
    const have = prev.get(p.id);
    if (have && have.version > p.version) byId.set(p.id, have);
    else take(p);
  }
  publish("ready");
}

/** One pin added or changed ("pin" on /live, or a change's answer). */
export function putPin(p: WebPin): void {
  if (take(p)) publish();
}

/** One pin deleted ("pin_gone" on /live). */
export function dropPin(id: string): void {
  gone.add(id);
  if (byId.delete(id)) publish();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

/** The current world's web pins, archived ones included. */
export function usePins(): Snapshot {
  return useSyncExternalStore(subscribe, () => snap, () => snap);
}

/** For tests: forget everything. */
export function resetPins(): void {
  byId = new Map();
  optimistic.reset();
  gone.clear();
  snap = { pins: [], load: "idle" };
  for (const f of subs) f();
}

// ---- changes --------------------------------------------------------------------

export type PinError = "bad_request" | "outside" | "not_archived" | "no_world" | "signed_out" | "not_found" | "full" | "stale" | "bad_move" | "rate_limited" | "network" | "failed";
/** `stale`: someone changed the pin first; `pin` is the server's copy now, and the page already shows it. */
export type PinCall = { ok: true; pin?: WebPin } | { ok: false; error: "stale"; pin: WebPin } | { ok: false; error: Exclude<PinError, "stale">; message?: string };

const KNOWN_ERRORS = new Set<string>(["bad_request", "outside", "not_archived", "no_world", "not_found", "full", "bad_move", "rate_limited"]);

async function send(method: string, path: string, body?: unknown): Promise<PinCall> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  // The session ended: the page notices on its next state read and shows the sign-in.
  if (res.status === 401) return { ok: false, error: "signed_out" };
  const json = (await res.json().catch(() => null)) as { ok?: boolean; pin?: WebPin; error?: PinError; message?: string } | null;
  if (res.ok && json?.ok) {
    // Shown at once, whether or not the socket is up; the live copy that follows is the same.
    if (json.pin) putPin(json.pin);
    return { ok: true, pin: json.pin };
  }
  if (json?.error === "stale" && json.pin) {
    putPin(json.pin);
    return { ok: false, error: "stale", pin: json.pin };
  }
  // Only the errors this page has words for; anything else (a proxy, a body refused before parsing) is a plain failure.
  const error = json?.error && json.error !== "stale" && KNOWN_ERRORS.has(json.error) ? json.error : "failed";
  return { ok: false, error, message: json?.message };
}

export const createPin = (p: { x: number; z: number; icon: PinIcon; note: string; by: string }) => send("POST", "/api/pins", p);

/**
 * Changes a pin as this page shows it: only the fields that change go out,
 * with what the page saw of them (`expect`), so a change someone made
 * meanwhile comes back as `stale` instead of being overwritten.
 */
export function updatePin(pin: WebPin, by: string, change: { state?: PinState; note?: string; icon?: PinIcon; archived?: boolean }) {
  const body: Record<string, unknown> = { by };
  const expect: PinExpect = {};
  if (change.state !== undefined && change.state !== pin.state) {
    body.state = change.state;
    expect.state = pin.state;
    expect.claimedBy = pin.claimedBy;
  }
  if (change.note !== undefined && change.note !== pin.note) {
    body.note = change.note;
    expect.note = pin.note;
  }
  if (change.icon !== undefined && change.icon !== pin.icon) {
    body.icon = change.icon;
    expect.icon = pin.icon;
  }
  if (change.archived !== undefined && change.archived !== pin.archived) {
    body.archived = change.archived;
    expect.archived = pin.archived;
  }
  if (Object.keys(body).length === 1) return Promise.resolve<PinCall>({ ok: true, pin });
  return send("PATCH", `/api/pins/${encodeURIComponent(pin.id)}`, { ...body, expect });
}

export async function deletePin(id: string): Promise<PinCall> {
  const res = await send("DELETE", `/api/pins/${encodeURIComponent(id)}`);
  if (res.ok || res.error === "not_found") dropPin(id);
  return res;
}

export type PinChange = { state?: PinState; note?: string; icon?: PinIcon; archived?: boolean };

/** A pin with a change made by `by`, as the server would make it (pins.ts): shown before it answers. */
function changed(p: WebPin, by: string, c: PinChange, now: number): WebPin {
  const next: WebPin = { ...p };
  if (c.state !== undefined && c.state !== p.state) {
    next.state = c.state;
    next.stateBy = by;
    next.stateAt = now;
    if (c.state === "claimed") next.claimedBy = by;
    else if (c.state === "new") next.claimedBy = null;
  }
  if (c.note !== undefined) next.note = c.note;
  if (c.icon !== undefined) next.icon = c.icon;
  if (c.archived !== undefined) next.archived = c.archived;
  const same = next.state === p.state && next.note === p.note && next.icon === p.icon && next.archived === p.archived;
  return same ? p : { ...next, updatedAt: now };
}

/**
 * Changes a pin on the map at once, then saves it. `from`: the pin the change
 * was decided on, for an edit whose guard must stay what the form began
 * from; without it, the change names the server's copy when it goes out, so
 * a second tap right after the first waits for it and still passes the guard.
 * A refusal or a `stale` takes the change back; `pinFailure` says why.
 */
export function changePin(id: string, by: string, change: PinChange, from?: WebPin): Promise<PinCall> {
  const now = Date.now();
  return optimistic.run(
    id,
    (p) => changed(p, by, change, now),
    (base) => {
      const was = from ?? base;
      return was ? updatePin(was, by, change) : Promise.resolve<PinCall>({ ok: false, error: "not_found" });
    },
  );
}

/** Takes a pin off the map at once; it comes back if the server refuses. */
export function removePin(id: string): Promise<PinCall> {
  return optimistic.run(
    id,
    () => undefined,
    async () => {
      const r = await deletePin(id);
      // Gone already is what was asked for.
      return !r.ok && r.error === "not_found" ? { ok: true } : r;
    },
  );
}

/** A change to this pin is still out. */
export const pinPending = (id: string): boolean => optimistic.pending(id);

/** Why the last change to this pin failed, until the next one. */
export const pinFailure = (id: string): PinCall | undefined => optimistic.failure(id);

/** The pin's sheet closed: its last failure has been seen. */
export const dismissPinFailure = (id: string): void => optimistic.dismiss(id);

// ---- who is looking -------------------------------------------------------------

const NAME_KEY = "skald.pins.name";
const nameSubs = new Set<() => void>();
/** The name for this visit when storage refused it. */
let nameMemory: string | null = null;

/** The display name this device places and claims pins under; "" until picked. */
export function pinName(): string {
  if (nameMemory !== null) return nameMemory;
  try {
    return cutText(tidyText(localStorage.getItem(NAME_KEY) ?? ""), PIN_NAME_MAX);
  } catch {
    return "";
  }
}

export function setPinName(name: string): void {
  const v = cutText(tidyText(name), PIN_NAME_MAX);
  try {
    localStorage.setItem(NAME_KEY, v);
    nameMemory = null;
  } catch {
    nameMemory = v;
  }
  for (const f of nameSubs) f();
}

export function usePinName(): string {
  return useSyncExternalStore(
    (f) => {
      nameSubs.add(f);
      return () => nameSubs.delete(f);
    },
    pinName,
    pinName,
  );
}

// ---- filters --------------------------------------------------------------------

/** Whose pins: everyone's (the group) or only mine (placed or claimed by me). */
export type PinWho = "group" | "mine";
/** Which: still to do (new, claimed) or done (cleared, depleted). */
export type PinStatus = "open" | "completed";

export interface PinFilter {
  /** Web pins on the map at all. */
  show: boolean;
  who: PinWho;
  status: PinStatus;
}

export const DEFAULT_PIN_FILTER: PinFilter = { show: true, who: "group", status: "open" };

/** The server's rule (pintypes.ts): case does not matter, accents do. */
export { sameName };

/** Placed or claimed by this name (case does not matter). */
export const isMine = (p: WebPin, me: string): boolean => sameName(p.author, me) || sameName(p.claimedBy, me);

export const isDone = (p: WebPin): boolean => DONE_STATES.includes(p.state);

/** The pins a filter shows, archived ones never. */
export function filterPins(pins: readonly WebPin[], f: PinFilter, me: string): WebPin[] {
  if (!f.show) return [];
  return pins.filter((p) => !p.archived && isDone(p) === (f.status === "completed") && (f.who === "group" || isMine(p, me)));
}

const FILTER_KEY = "skald.map.pins";

export function storedPinFilter(): PinFilter {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null") as Partial<PinFilter> | null;
    if (raw && typeof raw === "object") {
      return {
        show: typeof raw.show === "boolean" ? raw.show : DEFAULT_PIN_FILTER.show,
        who: raw.who === "mine" || raw.who === "group" ? raw.who : DEFAULT_PIN_FILTER.who,
        status: raw.status === "completed" || raw.status === "open" ? raw.status : DEFAULT_PIN_FILTER.status,
      };
    }
  } catch {
    // storage blocked or garbage: defaults
  }
  return { ...DEFAULT_PIN_FILTER };
}

export function storePinFilter(f: PinFilter): void {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(f));
  } catch {
    // not remembered; fine
  }
}
