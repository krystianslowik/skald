import { describe, expect, it } from "vitest";
import type { SettingsCurrent } from "../types";
import { diff, draftErrors, draftFrom, draftReducer, generatePassword, isCustom, strength, toInput, worldOnly, type Draft, type DraftAction } from "./settingsForm";

const saved: SettingsCurrent = {
  name: "My Valheim",
  public: true,
  preset: "normal",
  modifiers: { raids: "less", deathpenalty: "casual" },
  keys: [],
  saveInterval: 1800,
  unmanaged: ["-crossplay"],
};

const apply = (d: Draft, ...actions: DraftAction[]) => actions.reduce(draftReducer, d);

describe("settings draft", () => {
  it("starts unchanged", () => {
    const d = draftFrom(saved);
    expect(diff(saved, d, null)).toEqual([]);
    expect(draftErrors(saved, true, null, d)).toEqual({});
    expect(isCustom(d)).toBe(true);
  });

  it("a preset clears the overrides; an override makes it custom again", () => {
    let d = apply(draftFrom(saved), { type: "preset", value: "hard" });
    expect(d.preset).toBe("hard");
    expect(d.modifiers).toEqual({});
    expect(isCustom(d)).toBe(false);
    d = apply(d, { type: "modifier", name: "raids", value: "none" });
    expect(isCustom(d)).toBe(true);
    expect(d.preset).toBe("hard"); // still the base the overrides apply on
    expect(toInput(d, null)).toMatchObject({ preset: "hard", modifiers: { raids: "none" } });
    d = apply(d, { type: "modifier", name: "raids", value: null });
    expect(isCustom(d)).toBe(false);
    expect(diff(saved, d, null)).toEqual(["preset", "modifier.deathpenalty", "modifier.raids"]);
  });

  it("counts every kind of change", () => {
    const d = apply(
      draftFrom(saved),
      { type: "name", value: "Hall of Ash" },
      { type: "public", value: false },
      { type: "key", key: "nomap", on: true },
      { type: "saveInterval", value: 600 },
      { type: "password", value: "embers-42" },
    );
    expect(diff(saved, d, "ognisko")).toEqual(["name", "password", "public", "key.nomap", "saveInterval"]);
    // Typing the saved password back is not a change.
    expect(diff(saved, apply(d, { type: "password", value: "ognisko" }), "ognisko")).not.toContain("password");
    // Whitespace around the name is not a change either.
    expect(diff(saved, apply(draftFrom(saved), { type: "name", value: " My Valheim " }), null)).toEqual([]);
  });

  it("validates as you type, with the agent's rules", () => {
    const d = draftFrom(saved);
    expect(draftErrors(saved, true, null, apply(d, { type: "name", value: "ab" }))).toEqual({ name: "length" });
    expect(draftErrors(saved, true, null, apply(d, { type: "name", value: "Hall $(id)" }))).toEqual({ name: "chars" });
    expect(draftErrors(saved, true, null, apply(d, { type: "password", value: "abc" }))).toEqual({ password: "length" });
    expect(draftErrors(saved, true, null, apply(d, { type: "password", value: "has space" }))).toEqual({ password: "chars" });
    expect(draftErrors(saved, true, null, apply(d, { type: "password", value: "valheim" }))).toEqual({ password: "inName" });
    // Renaming the server around a password it already has.
    expect(draftErrors(saved, true, "ognisko", apply(d, { type: "name", value: "Ognisko Hall" }))).toEqual({ password: "inName" });
    // No password known: one must be typed; an empty field is not enough.
    expect(draftErrors(saved, false, null, d)).toEqual({ password: "required" });
    expect(draftErrors(saved, false, null, apply(d, { type: "password", value: "" }))).toEqual({ password: "required" });
    expect(draftErrors(saved, false, null, apply(d, { type: "password", value: "embers-42" }))).toEqual({});
  });

  it("clamps the save interval and resets", () => {
    let d = apply(draftFrom(saved), { type: "saveInterval", value: 10 });
    expect(d.saveInterval).toBe(60);
    d = apply(d, { type: "saveInterval", value: 99_999 });
    expect(d.saveInterval).toBe(7200);
    expect(apply(d, { type: "reset", to: saved })).toEqual(draftFrom(saved));
  });

  it("leaves the password out of the payload unless it changed", () => {
    expect(toInput(draftFrom(saved), null)).not.toHaveProperty("password");
    expect(toInput(apply(draftFrom(saved), { type: "password", value: "embers-42" }), null).password).toBe("embers-42");
  });

  it("generates pronounceable passwords that pass the rules", () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword(rand);
      expect(pw).toMatch(/^([bdfghjklmnprstvz][aeiou]){5}\d{2}$/);
      expect(draftErrors(saved, true, null, apply(draftFrom(saved), { type: "password", value: pw }))).toEqual({});
    }
  });

  it("rates strength", () => {
    expect(strength("abc")).toBe(0);
    expect(strength("abcde")).toBe(1);
    expect(strength("torvakelin42")).toBe(3);
  });
});

describe("worldOnly", () => {
  it("names world modifiers the saved settings show as normal", () => {
    expect(worldOnly(saved, { resources: "muchmore", portals: "casual", raids: "more", combat: "bogus", other: "x" })).toEqual({ resources: "muchmore", portals: "casual" });
    expect(worldOnly(saved, null)).toEqual({});
    expect(worldOnly(saved, undefined)).toEqual({});
  });
  it("stays quiet under a preset, which sets every modifier itself", () => {
    expect(worldOnly({ ...saved, preset: "hard", modifiers: {} }, { resources: "muchmore" })).toEqual({});
  });
});

describe("the world's own modifiers as the baseline", () => {
  const world = { resources: "muchmore", portals: "casual" };

  it("opens with them selected and nothing to save", () => {
    const d = draftFrom(saved, world);
    expect(d.modifiers).toEqual({ raids: "less", deathpenalty: "casual", resources: "muchmore", portals: "casual" });
    expect(diff(saved, d, null, world)).toEqual([]);
  });

  it("keeps them on undo", () => {
    const d = apply(draftFrom(saved, world), { type: "modifier", name: "combat", value: "hard" }, { type: "reset", to: saved, world });
    expect(d.modifiers).toMatchObject(world);
    expect(diff(saved, d, null, world)).toEqual([]);
  });

  it("does not count one set back to normal, which would save what is already saved", () => {
    const d = apply(draftFrom(saved, world), { type: "modifier", name: "resources", value: null });
    expect(diff(saved, d, null, world)).toEqual([]);
  });

  it("counts real modifier edits and saves the world's along with them", () => {
    const d = apply(draftFrom(saved, world), { type: "modifier", name: "resources", value: "more" }, { type: "modifier", name: "combat", value: "hard" });
    expect(diff(saved, d, null, world).sort()).toEqual(["modifier.combat", "modifier.resources"]);
    expect(toInput(d, null).modifiers).toEqual({ raids: "less", deathpenalty: "casual", resources: "more", portals: "casual", combat: "hard" });
  });

  it("comes back clean after a preset and back to normal", () => {
    const d = apply(draftFrom({ ...saved, modifiers: {} }, world), { type: "preset", value: "hard" }, { type: "preset", value: "normal" });
    expect(diff({ ...saved, modifiers: {} }, d, null, world)).toEqual([]);
  });
});
