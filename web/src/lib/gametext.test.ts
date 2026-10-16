import { describe, expect, it } from "vitest";
import { gateMap } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { makeI18n } from "../i18n";
import { gameName, humanizeToken } from "./gametext";
import { buildMarkers } from "./mapgeo";

const en = makeI18n("en").lookup;
const pl = makeI18n("pl").lookup;

const BOSSES = ["$enemy_eikthyr", "$enemy_gdking", "$enemy_bonemass", "$enemy_dragon", "$enemy_goblinking", "$enemy_seekerqueen", "$enemy_fader"];

describe("gameName", () => {
  it("names every boss a Vegvisir can mark, as the progress board does", () => {
    expect(BOSSES.map((b) => gameName(b, en))).toEqual(["Eikthyr", "The Elder", "Bonemass", "Moder", "Yagluth", "The Queen", "Fader"]);
    expect(BOSSES.map((b) => gameName(b, pl))).toEqual(BOSSES.map((b) => pl(`boss.defeated_${b === "$enemy_seekerqueen" ? "queen" : b.slice(7)}`)));
    expect(gameName("$enemy_gdking", pl)).toBe(pl("boss.defeated_gdking"));
  });

  it("puts tokens it does not know into words, and never shows a raw one", () => {
    for (const raw of ["$enemy_brenna", "$location_old_tower", "$hud_pin_hildir1", "$piece_x", "$$enemy_unknown", "$", "$enemy_", "Camp by $enemy_gdking"]) {
      for (const lookup of [en, pl]) expect(gameName(raw, lookup)).not.toMatch(/\$[A-Za-z]/);
    }
    expect(gameName("$location_old_tower", en)).toBe("Old tower");
    expect(gameName("$hud_pin_hildir1", en)).toBe("Hildir1");
    expect(gameName("$enemy_brenna", en)).toBe("Brenna");
    expect(gameName("Camp by $enemy_gdking", en)).toBe("Camp by The Elder");
    expect(humanizeToken("$enemy_")).toBe("?");
  });

  it("leaves names people typed alone", () => {
    expect(gameName("Copper", en)).toBe("Copper");
    expect(gameName("Ruda miedzi", pl)).toBe("Ruda miedzi");
    expect(gameName("", en)).toBe("");
  });

  it("leaves no token on the map's marks", () => {
    const marks = buildMarkers(gateMap(mockMap({ now: Date.parse("2026-10-10T20:00:00Z") }), false), pl);
    const pins = marks.filter((m) => m.data.type === "pin" && m.data.kind === "boss");
    expect(pins.map((m) => m.label)).toEqual([pl("boss.defeated_eikthyr"), pl("boss.defeated_gdking")]);
    for (const m of marks) {
      expect(m.label).not.toContain("$");
      if (m.data.type === "pin") expect(m.data.name).not.toContain("$");
    }
  });
});
