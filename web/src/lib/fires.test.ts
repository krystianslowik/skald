import { describe, expect, it } from "vitest";
import { makeI18n } from "../i18n";
import { fireGroups, fireKind, firesText } from "./fires";

describe("fires by kind", () => {
  it("sorts the game's fire prefabs into kinds people name", () => {
    expect(fireKind("piece_groundtorch_wood")).toBe("torch");
    expect(fireKind("piece_groundtorch_mist")).toBe("torch");
    expect(fireKind("piece_walltorch")).toBe("torch");
    expect(fireKind("fire_pit")).toBe("campfire");
    expect(fireKind("fire_pit_iron")).toBe("campfire");
    expect(fireKind("bonfire")).toBe("campfire");
    expect(fireKind("hearth")).toBe("hearth");
    expect(fireKind("piece_brazierfloor01")).toBe("brazier");
    expect(fireKind("piece_brazierceiling01")).toBe("brazier");
    expect(fireKind("MountainKit_brazier_purple")).toBe("brazier");
    expect(fireKind("piece_hoodedlantern")).toBe("lantern");
    expect(fireKind("piece_jackoturnip")).toBe("lantern");
    expect(fireKind("Candle_resin")).toBe("candle");
    expect(fireKind("piece_modded_glowthing")).toBe("other");
  });

  it("adds the prefabs up per kind, most first", () => {
    expect(fireGroups({ piece_walltorch: 4, fire_pit: 3, piece_groundtorch_wood: 10, hearth: 3 })).toEqual([
      { kind: "torch", n: 14 },
      { kind: "campfire", n: 3 },
      { kind: "hearth", n: 3 },
    ]);
    expect(fireGroups(undefined)).toEqual([]);
    expect(fireGroups({ fire_pit: "x", hearth: 0, bonfire: 2 })).toEqual([{ kind: "campfire", n: 2 }]);
    // Fires the audit event left out of the map still count.
    expect(fireGroups({ fire_pit: 3 }, 5)).toEqual([{ kind: "campfire", n: 3 }, { kind: "other", n: 2 }]);
    expect(fireGroups(undefined, 4)).toEqual([{ kind: "any", n: 4 }]);
    expect(fireGroups({ fire_pit: 3 }, 2)).toEqual([{ kind: "campfire", n: 3 }]);
  });

  it("words the counts in both languages", () => {
    const by = { piece_groundtorch_wood: 10, piece_walltorch: 4, fire_pit: 3 };
    expect(firesText(makeI18n("en"), by)).toBe("14 torches and 3 campfires");
    expect(firesText(makeI18n("en"), { hearth: 1 })).toBe("1 hearth");
    expect(firesText(makeI18n("en"), { piece_brazierfloor01: 2, hearth: 1, Candle_resin: 1, piece_x: 1 })).toBe("2 braziers, 1 hearth, 1 candle and 1 other fire");
    expect(firesText(makeI18n("en"), {}, 1)).toBe("1 fire");
    expect(firesText(makeI18n("pl"), by)).toBe("14 pochodni i 3 ogniska");
    expect(firesText(makeI18n("pl"), {}, 22)).toBe("22 ognie");
    expect(firesText(makeI18n("pl"), { piece_groundtorch_wood: 2, hearth: 1, bonfire: 5 })).toBe("5 ognisk, 2 pochodnie i 1 palenisko");
  });
});
