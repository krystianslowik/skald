import { describe, expect, it } from "bun:test";
import { buildArgs, changedKeys, normalize, parseArgs, validateName, validatePassword, validateSettings } from "../src/settings";
import type { SettingsInput } from "../src/types";

// The same table as agent/internal/settings: both validators must agree.
describe("validation mirrors the agent", () => {
  it("names", () => {
    const cases: [string, string | null][] = [
      ["Midgard", null],
      ["Łódź Długa Noc", null],
      ["Ragnar's Hall!", null],
      ["a-b_c.d", null],
      ["abc", null],
      ["x".repeat(40), null],
      ["ab", "length"],
      ["x".repeat(41), "length"],
      ["ż".repeat(40), null],
      ["Hall $(id)", "chars"],
      ["Hall `id`", "chars"],
      ["Hall; rm", "chars"],
      ["tab\there", "chars"],
      ["new\nline", "chars"],
      ["a=b c", "chars"],
    ];
    for (const [name, want] of cases) expect([name, validateName(name)]).toEqual([name, want]);
  });

  it("passwords", () => {
    const cases: [string, string, string | null][] = [
      ["ognisko", "Midgard", null],
      ["a$b`c;d=e'f\"", "Midgard", null],
      ["abcd", "Midgard", "length"],
      ["x".repeat(32), "Midgard", null],
      ["x".repeat(33), "Midgard", "length"],
      ["has space", "Midgard", "chars"],
      ["zażółć", "Midgard", "chars"],
      ["tab\tx1", "Midgard", "chars"],
      ["midga", "Midgard", "inName"],
      ["HALL1", "The hall1 of fire", "inName"],
    ];
    for (const [pw, name, want] of cases) expect([pw, validatePassword(pw, name)]).toEqual([pw, want]);
  });

  const prev = { name: "Midgard Hall" };
  const base: SettingsInput = { name: "Midgard Hall", public: true, preset: "normal", modifiers: {}, keys: [], saveInterval: 1800 };
  it("whole input", () => {
    const cases: [Partial<SettingsInput>, Record<string, string>][] = [
      [{}, {}],
      [{ name: "  Midgard Hall  " }, {}],
      [{ name: "x" }, { name: "length" }],
      [{ password: "abc" }, { password: "length" }],
      [{ name: "Ognisko Hall" }, { password: "inName" }],
      [{ preset: "Hardcore" }, {}],
      [{ preset: "nightmare" }, { preset: "value" }],
      [{ modifiers: { raids: "none", Combat: "VeryHard" } }, {}],
      [{ modifiers: { raids: "normal" } }, {}],
      [{ modifiers: { raids: "most" } }, { "modifier.raids": "value" }],
      [{ modifiers: { weather: "none" } }, { "modifier.weather": "unknown" }],
      [{ modifiers: { raids: "none;id" } }, { "modifier.raids": "value" }],
      [{ keys: ["nomap", "nobuildcost"] }, {}],
      [{ keys: ["godmode"] }, { keys: "value" }],
      [{ saveInterval: 600 }, {}],
      [{ saveInterval: 59 }, { saveInterval: "range" }],
      [{ saveInterval: 7201 }, { saveInterval: "range" }],
    ];
    for (const [edit, want] of cases) expect([edit, validateSettings(prev, "ognisko", { ...base, ...edit })]).toEqual([edit, want]);
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
