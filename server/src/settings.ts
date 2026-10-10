// Server settings: the allow-list, validation and SERVER_ARGS rendering. A
// mirror of agent/internal/settings (the agent is the authority; this copy
// lets the dashboard validate as you type and powers the mock agent). Kept
// free of Bun/Node imports: the web package compiles it via `@server/*`.
//
// Launch options follow Iron Gate's dedicated server guide,
// https://valheimgame.com/support/a-guide-to-dedicated-servers/ ("List of
// console commands": -preset, -modifier, -setkey, -saveinterval).

import type { SettingsCurrent, SettingsInput } from "./types";

export const PRESETS = ["normal", "casual", "easy", "hard", "hardcore", "immersive", "hammer"] as const;
export type Preset = (typeof PRESETS)[number];

/** Documented values per modifier, mildest first. "normal" (no override) is never emitted. */
export const MODIFIERS = {
  combat: ["veryeasy", "easy", "hard", "veryhard"],
  deathpenalty: ["casual", "veryeasy", "easy", "hard", "hardcore"],
  resources: ["muchless", "less", "more", "muchmore", "most"],
  raids: ["none", "muchless", "less", "more", "muchmore"],
  portals: ["casual", "hard", "veryhard"],
} as const satisfies Record<string, readonly string[]>;
export type ModifierName = keyof typeof MODIFIERS;
export const MODIFIER_NAMES = Object.keys(MODIFIERS) as ModifierName[];

/**
 * Where the neutral step ("normal", or "preset" under a preset) sits on each
 * scale, so the stepped control reads mild -> harsh around it.
 */
export const NEUTRAL_AT: Record<ModifierName, number> = { combat: 2, deathpenalty: 3, resources: 2, raids: 3, portals: 1 };

export const KEYS = ["nobuildcost", "playerevents", "passivemobs", "nomap"] as const;
export type WorldKey = (typeof KEYS)[number];

export const SAVE_INTERVAL = { min: 60, max: 7200, default: 1800 } as const;
export const NAME_LEN = { min: 3, max: 40 } as const;
export const PASSWORD_LEN = { min: 5, max: 32 } as const;

export type FieldError = "length" | "chars" | "inName" | "required" | "value" | "unknown" | "range";
export type SettingsErrors = Record<string, FieldError>;

const NAME_CHARS = /^[\p{L}\p{N} \-_.'!]+$/u;

/** Code points, like the agent's rune count. */
const len = (s: string) => [...s].length;

export function validateName(name: string): FieldError | null {
  const n = len(name);
  if (n < NAME_LEN.min || n > NAME_LEN.max) return "length";
  if (!NAME_CHARS.test(name)) return "chars";
  return null;
}

/** Length, printable non-space ASCII, and Valheim's rule: not inside the name (case-insensitive). */
export function validatePassword(password: string, name: string): FieldError | null {
  if (password.length < PASSWORD_LEN.min || password.length > PASSWORD_LEN.max) return "length";
  for (let i = 0; i < password.length; i++) {
    const c = password.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return "chars";
  }
  if (name.toLowerCase().includes(password.toLowerCase())) return "inName";
  return null;
}

/** No control characters: safe for one KEY=value line. */
function safe(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/**
 * Validates `input` against the saved settings, like the agent's Apply:
 * changed fields get the strict rules, values carried over unchanged (seeded
 * from the environment) only have to be safe. `prevPassword` is the saved
 * password, or "" when none is known; null when the caller does not know it
 * (the browser before a reveal): then an omitted password counts as kept.
 */
export function validateSettings(prev: Pick<SettingsCurrent, "name">, prevPassword: string | null, input: SettingsInput): SettingsErrors {
  const errs: SettingsErrors = {};
  const name = input.name.trim();
  if (name !== prev.name) {
    const e = validateName(name);
    if (e) errs.name = e;
  } else if (!name || !safe(name)) errs.name = "chars";

  if (input.password !== undefined && input.password !== prevPassword) {
    const e = validatePassword(input.password, name);
    if (e) errs.password = e;
  } else if (prevPassword === "") {
    errs.password = "required";
  } else if (prevPassword !== null && name !== prev.name && name.toLowerCase().includes(prevPassword.toLowerCase())) {
    errs.password = "inName";
  }

  const preset = (input.preset || "normal").toLowerCase();
  if (!(PRESETS as readonly string[]).includes(preset)) errs.preset = "value";
  for (const [k, v] of Object.entries(input.modifiers ?? {})) {
    const key = k.toLowerCase();
    const val = v.toLowerCase();
    if (!val || val === "normal") continue;
    const allowed = (MODIFIERS as Record<string, readonly string[]>)[key];
    if (!allowed) errs[`modifier.${key}`] = "unknown";
    else if (!allowed.includes(val)) errs[`modifier.${key}`] = "value";
  }
  for (const k of input.keys ?? []) if (!(KEYS as readonly string[]).includes(k.toLowerCase())) errs.keys = "value";
  const si = input.saveInterval;
  if (si !== SAVE_INTERVAL.default && si !== 0 && (si < SAVE_INTERVAL.min || si > SAVE_INTERVAL.max)) errs.saveInterval = "range";
  return errs;
}

/** Normalized structured settings (no password) from valid input. */
export function normalize(input: SettingsInput, unmanaged: string[]): SettingsCurrent {
  const modifiers: Partial<Record<ModifierName, string>> = {};
  for (const name of MODIFIER_NAMES) {
    const v = Object.entries(input.modifiers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1]?.toLowerCase();
    if (v && v !== "normal") modifiers[name] = v;
  }
  const keys = new Set((input.keys ?? []).map((k) => k.toLowerCase()));
  return {
    name: input.name.trim(),
    public: input.public,
    preset: (input.preset || "normal").toLowerCase(),
    modifiers,
    keys: KEYS.filter((k) => keys.has(k)),
    saveInterval: input.saveInterval || SAVE_INTERVAL.default,
    unmanaged,
  };
}

/** The SERVER_ARGS string the agent writes: managed options first, unmanaged tokens after. */
export function buildArgs(s: Omit<SettingsCurrent, "name" | "public">): string {
  const out: string[] = [];
  if (s.preset && s.preset !== "normal") out.push("-preset", s.preset);
  for (const name of MODIFIER_NAMES) {
    const v = s.modifiers[name];
    if (v) out.push("-modifier", name, v);
  }
  for (const k of KEYS) if (s.keys.includes(k)) out.push("-setkey", k);
  if (s.saveInterval && s.saveInterval !== SAVE_INTERVAL.default) out.push("-saveinterval", String(s.saveInterval));
  out.push(...s.unmanaged);
  return out.join(" ");
}

/** Splits SERVER_ARGS like the agent's ParseArgs: allow-listed options, the rest verbatim. */
export function parseArgs(args: string): Omit<SettingsCurrent, "name" | "public"> {
  const tok = args.split(/\s+/).filter(Boolean);
  let preset = "normal";
  let modifiers: Partial<Record<ModifierName, string>> = {};
  const keys = new Set<string>();
  let saveInterval: number = SAVE_INTERVAL.default;
  const unmanaged: string[] = [];
  for (let i = 0; i < tok.length; i++) {
    const w = tok[i]!.toLowerCase();
    const a = tok[i + 1]?.toLowerCase();
    const b = tok[i + 2]?.toLowerCase();
    if (w === "-preset" && a && (PRESETS as readonly string[]).includes(a)) {
      preset = a;
      modifiers = {};
      i += 1;
      continue;
    }
    if (w === "-modifier" && a && b && (MODIFIERS as Record<string, readonly string[]>)[a]?.includes(b)) {
      modifiers[a as ModifierName] = b;
      i += 2;
      continue;
    }
    if (w === "-setkey" && a && (KEYS as readonly string[]).includes(a)) {
      keys.add(a);
      i += 1;
      continue;
    }
    if (w === "-saveinterval" && a && /^\d+$/.test(a)) {
      const n = Number(a);
      if (n >= SAVE_INTERVAL.min && n <= SAVE_INTERVAL.max) {
        saveInterval = n;
        i += 1;
        continue;
      }
    }
    unmanaged.push(tok[i]!);
  }
  return { preset, modifiers, keys: KEYS.filter((k) => keys.has(k)), saveInterval, unmanaged };
}

/** What differs, in the agent's settings_changed vocabulary. */
export function changedKeys(a: Omit<SettingsCurrent, "unmanaged">, b: Omit<SettingsCurrent, "unmanaged">, passwordChanged = false): string[] {
  const out: string[] = [];
  if (a.name.trim() !== b.name.trim()) out.push("name");
  if (passwordChanged) out.push("password");
  if (a.public !== b.public) out.push("public");
  if ((a.preset || "normal") !== (b.preset || "normal")) out.push("preset");
  for (const m of MODIFIER_NAMES) if ((a.modifiers[m] ?? "") !== (b.modifiers[m] ?? "")) out.push(`modifier.${m}`);
  for (const k of KEYS) if (a.keys.includes(k) !== b.keys.includes(k)) out.push(`key.${k}`);
  if ((a.saveInterval || SAVE_INTERVAL.default) !== (b.saveInterval || SAVE_INTERVAL.default)) out.push("saveInterval");
  return out;
}
