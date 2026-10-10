import { changedKeys, KEYS, MODIFIER_NAMES, SAVE_INTERVAL, validateSettings, type ModifierName, type SettingsErrors } from "@server/settings";
import type { SettingsCurrent, SettingsInput } from "../types";

/** The settings sheet's working copy. `password` is null while untouched (keep the saved one). */
export interface Draft {
  name: string;
  public: boolean;
  preset: string;
  modifiers: Partial<Record<ModifierName, string>>;
  keys: string[];
  saveInterval: number;
  password: string | null;
}

export type DraftAction =
  | { type: "name"; value: string }
  | { type: "public"; value: boolean }
  /** Picking a preset drops every individual override, like the game's own screen. */
  | { type: "preset"; value: string }
  /** null = back to the preset's (or normal) value. Any override makes the preset "custom". */
  | { type: "modifier"; name: ModifierName; value: string | null }
  | { type: "key"; key: string; on: boolean }
  | { type: "saveInterval"; value: number }
  | { type: "password"; value: string | null }
  | { type: "reset"; to: SettingsCurrent };

export function draftFrom(cur: SettingsCurrent): Draft {
  const modifiers: Partial<Record<ModifierName, string>> = {};
  for (const m of MODIFIER_NAMES) if (cur.modifiers[m]) modifiers[m] = cur.modifiers[m];
  return {
    name: cur.name,
    public: cur.public,
    preset: cur.preset || "normal",
    modifiers,
    keys: KEYS.filter((k) => cur.keys.includes(k)),
    saveInterval: cur.saveInterval || SAVE_INTERVAL.default,
    password: null,
  };
}

export function draftReducer(d: Draft, a: DraftAction): Draft {
  switch (a.type) {
    case "name":
      return { ...d, name: a.value };
    case "public":
      return { ...d, public: a.value };
    case "preset":
      return { ...d, preset: a.value, modifiers: {} };
    case "modifier": {
      const modifiers = { ...d.modifiers };
      if (a.value === null || a.value === "normal") delete modifiers[a.name];
      else modifiers[a.name] = a.value;
      return { ...d, modifiers };
    }
    case "key": {
      const on = new Set(d.keys);
      if (a.on) on.add(a.key);
      else on.delete(a.key);
      return { ...d, keys: KEYS.filter((k) => on.has(k)) };
    }
    case "saveInterval":
      return { ...d, saveInterval: Math.round(Math.min(SAVE_INTERVAL.max, Math.max(SAVE_INTERVAL.min, a.value))) };
    case "password":
      return { ...d, password: a.value };
    case "reset":
      return draftFrom(a.to);
  }
}

/** Any individual modifier set: the preset row shows "Custom". */
export const isCustom = (d: Pick<Draft, "modifiers">): boolean => Object.keys(d.modifiers).length > 0;

/** True when the typed password is a real change (not empty, not the one already saved). */
export function passwordChanged(d: Draft, known: string | null): boolean {
  return d.password !== null && d.password !== "" && d.password !== known;
}

/** What Save would change, in the agent's settings_changed vocabulary. */
export function diff(saved: SettingsCurrent, d: Draft, knownPassword: string | null): string[] {
  return changedKeys(saved, d, passwordChanged(d, knownPassword));
}

export function toInput(d: Draft, knownPassword: string | null): SettingsInput {
  const input: SettingsInput = {
    name: d.name.trim(),
    public: d.public,
    preset: d.preset,
    modifiers: { ...(d.modifiers as Record<string, string>) },
    keys: [...d.keys],
    saveInterval: d.saveInterval,
  };
  if (passwordChanged(d, knownPassword)) input.password = d.password!;
  return input;
}

/**
 * Field errors as you type, with the agent's rules. `passwordSet` false means
 * the server has no password Skald knows of: one must be typed before saving.
 */
export function draftErrors(saved: SettingsCurrent, passwordSet: boolean, knownPassword: string | null, d: Draft): SettingsErrors {
  // An empty field means "keep the saved password".
  return validateSettings(saved, passwordSet ? knownPassword : "", toInput(d, knownPassword));
}

/** A pronounceable password: consonant-vowel syllables plus two digits, e.g. "torvakelin42". */
export function generatePassword(rand: () => number = Math.random): string {
  const c = "bdfghjklmnprstvz";
  const v = "aeiou";
  let out = "";
  for (let i = 0; i < 5; i++) out += c[Math.floor(rand() * c.length)]! + v[Math.floor(rand() * v.length)]!;
  return out + String(10 + Math.floor(rand() * 90));
}

/** Password strength for the meter: 0 weak to 3 strong, from length and variety. */
export function strength(pw: string): 0 | 1 | 2 | 3 {
  if (pw.length < 5) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const score = (pw.length >= 8 ? 1 : 0) + (pw.length >= 12 ? 1 : 0) + (kinds >= 2 ? 1 : 0) + (kinds >= 3 ? 1 : 0);
  return Math.min(3, Math.max(1, score)) as 1 | 2 | 3;
}
