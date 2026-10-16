import { describe, expect, it } from "bun:test";
import {
  buildArgs,
  changedKeys,
  KEYS,
  MODIFIERS,
  NAME_LEN,
  normalize,
  parseArgs,
  PASSWORD_LEN,
  PRESETS,
  SAVE_INTERVAL,
  validateName,
  validatePassword,
  validateSettings,
} from "../src/settings";
import type { SettingsInput } from "../src/types";

/**
 * The agent's rules file (agent/internal/settings/testdata/rules.json). The
 * agent's tests load the same file, so a rule changed on one side only fails
 * a test on that side.
 */
interface Rules {
  presets: string[];
  modifiers: { name: string; values: string[] }[];
  keys: string[];
  saveInterval: { min: number; max: number; default: number };
  nameLength: { min: number; max: number };
  passwordLength: { min: number; max: number };
  names: { name: string; want: string | null }[];
  passwords: { password: string; name: string; want: string | null }[];
  inputs: {
    prev: { name: string; password: string };
    base: SettingsInput;
    cases: { desc: string; edit: Partial<SettingsInput>; errors: Record<string, string> }[];
  };
}
const rules: Rules = await Bun.file(new URL("../../agent/internal/settings/testdata/rules.json", import.meta.url)).json();

describe("validation mirrors the agent", () => {
  it("allow-lists and limits", () => {
    expect<unknown>([...PRESETS]).toEqual(rules.presets);
    expect<unknown>(Object.entries(MODIFIERS).map(([name, values]) => ({ name, values: [...values] }))).toEqual(rules.modifiers);
    expect<unknown>([...KEYS]).toEqual(rules.keys);
    expect<unknown>({ ...SAVE_INTERVAL }).toEqual(rules.saveInterval);
    expect<unknown>({ ...NAME_LEN }).toEqual(rules.nameLength);
    expect<unknown>({ ...PASSWORD_LEN }).toEqual(rules.passwordLength);
  });

  it("names", () => {
    for (const { name, want } of rules.names) expect([name, validateName(name)]).toEqual([name, want]);
  });

  it("passwords", () => {
    for (const { password, name, want } of rules.passwords) expect([password, validatePassword(password, name)]).toEqual([password, want]);
  });

  const prev = { name: rules.inputs.prev.name };
  const base = rules.inputs.base;
  it("whole input", () => {
    for (const { desc, edit, errors } of rules.inputs.cases)
      expect<unknown>([desc, validateSettings(prev, rules.inputs.prev.password, { ...base, ...edit })]).toEqual([desc, errors]);
  });

  it("grandfathers unchanged legacy values and requires a password when none is known", () => {
    const legacy = { name: "Viking & Co" };
    expect(validateSettings(legacy, "pw 1", { ...base, name: "Viking & Co", public: false })).toEqual({});
    expect(validateSettings(legacy, "pw 1", { ...base, name: "Viking & Sons" }).name).toBe("chars");
    expect(validateSettings(legacy, "", { ...base, name: "Viking & Co" }).password).toBe("required");
    // The browser does not know the password until revealed: keeping it is fine.
    expect(validateSettings(prev, null, base)).toEqual({});
  });
});

describe("args", () => {
  it("parses like the agent", () => {
    expect(parseArgs("-crossplay -modifier raids less -modifier deathpenalty casual")).toEqual({
      preset: "normal",
      modifiers: { raids: "less", deathpenalty: "casual" },
      keys: [],
      saveInterval: 1800,
      unmanaged: ["-crossplay"],
    });
    expect(parseArgs("-Preset Hard -Modifier DeathPenalty Hardcore -setkey NoMap -saveinterval 600 -backups 4")).toEqual({
      preset: "hard",
      modifiers: { deathpenalty: "hardcore" },
      keys: ["nomap"],
      saveInterval: 600,
      unmanaged: ["-backups", "4"],
    });
    expect(parseArgs("-modifier raids none -preset casual -modifier combat easy").modifiers).toEqual({ combat: "easy" });
    expect(parseArgs("-modifier raids sometimes -setkey godmode -saveinterval 5 -preset").unmanaged).toEqual([
      "-modifier", "raids", "sometimes", "-setkey", "godmode", "-saveinterval", "5", "-preset",
    ]);
  });

  it("round-trips and orders managed options first", () => {
    for (const a of ["", "-preset hard", "-preset hammer -modifier combat veryeasy -modifier raids none -setkey nobuildcost -setkey nomap -saveinterval 900", "-modifier portals casual -crossplay -instanceid 2"]) {
      expect(buildArgs(parseArgs(a))).toBe(a);
    }
    expect(buildArgs(parseArgs("-crossplay -backups 4 -modifier raids less"))).toBe("-modifier raids less -crossplay -backups 4");
  });

  it("normalizes input and lists changed keys", () => {
    const n = normalize({ name: " Hall ", public: false, preset: "HARD", modifiers: { Raids: "None", portals: "normal" }, keys: ["nomap", "nobuildcost"], saveInterval: 1800 }, ["-crossplay"]);
    expect(n).toEqual({ name: "Hall", public: false, preset: "hard", modifiers: { raids: "none" }, keys: ["nobuildcost", "nomap"], saveInterval: 1800, unmanaged: ["-crossplay"] });
    const m = { ...n, name: "Other", modifiers: { raids: "none", combat: "hard" }, keys: ["nomap"], saveInterval: 600 };
    expect(changedKeys(n, m, true)).toEqual(["name", "password", "modifier.combat", "key.nobuildcost", "saveInterval"]);
    expect(changedKeys(n, n)).toEqual([]);
  });
});
