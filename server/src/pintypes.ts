// Web pins: map pins placed on the panel, kept apart from the save's in-game
// pins. Kept free of Bun/Node imports: the web package compiles this file
// through its `@server/*` path alias.

/** The marks a web pin can wear; the web draws each with one of the map's own icons. */
export const PIN_ICONS = ["point", "dungeon", "cave", "ore", "boss", "fire", "home", "chest", "portal", "trader"] as const;
export type PinIcon = (typeof PIN_ICONS)[number];

/**
 * Where a pin stands: `new` nobody has taken it, `claimed` someone is on the
 * way, `cleared` (a crypt emptied, a camp burnt) and `depleted` (a mine dug
 * out) are done and stay as a record.
 */
export const PIN_STATES = ["new", "claimed", "cleared", "depleted"] as const;
export type PinState = (typeof PIN_STATES)[number];

/** Done pins: what the "completed" filter shows. */
export const DONE_STATES: readonly PinState[] = ["cleared", "depleted"];

/** Limits the server holds pins to, in characters (code points). */
export const PIN_NOTE_MAX = 140;
export const PIN_NAME_MAX = 24;
/** Pins kept at once, archived ones included; the oldest archived go first when a new one needs room. */
export const PIN_MAX = 500;

/**
 * Bidi controls and characters that draw nothing (zero-width spaces and
 * joiners, soft hyphens, fillers, word joiners): they turn a name or a note
 * around or make two look the same. Removed from both before they are kept.
 * The emoji presentation selectors stay, so a heart keeps its colour.
 */
export const INVISIBLE = /(?![\uFE0E\uFE0F])[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}\u3164\uFFA0\u115F\u1160]/gu;

/** A name or a note as the server keeps it: no control or invisible characters, single spaces, trimmed. */
export function tidyText(v: string): string {
  return v
    .replace(INVISIBLE, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first `max` characters, by code point (an emoji is one, as the server counts). */
export const cutText = (v: string, max: number): string => [...v].slice(0, max).join("");

/**
 * The same display name: case does not matter, accents do ("Bjorn" is not
 * "Björn"). There are no accounts, so a name is only a label.
 */
export const sameName = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.localeCompare(b, "en", { sensitivity: "accent" }) === 0;

export interface WebPin {
  id: string;
  x: number;
  z: number;
  icon: PinIcon;
  note: string;
  /** The display name the pin was placed under (picked once per device; no accounts). */
  author: string;
  /** Goes up by one with every change: a page keeps the highest it has seen. */
  version: number;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  state: PinState;
  /** Who claimed it; set while `claimed`, kept as a record once done. */
  claimedBy: string | null;
  /** Who moved it to its current state, and when (epoch ms). */
  stateBy: string;
  stateAt: number;
  /** Hidden from the map and the lists, but kept; only an archived pin can be deleted for good. */
  archived: boolean;
}

/**
 * What an edit saw of the fields it changes. A field someone else changed
 * meanwhile makes the edit stale (409 with the current pin) instead of
 * overwriting their change.
 */
export interface PinExpect {
  state?: PinState;
  claimedBy?: string | null;
  note?: string;
  icon?: PinIcon;
}

/** GET /api/pins: the current world's pins. */
export interface PinList {
  ok: true;
  pins: WebPin[];
}

/**
 * Pins on /live: the current world's whole list when a socket opens (and again
 * when the world changes), then one pin per change.
 */
export type PinMessage = { type: "pins"; pins: WebPin[] } | { type: "pin"; pin: WebPin } | { type: "pin_gone"; id: string };
