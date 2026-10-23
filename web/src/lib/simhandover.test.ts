import { describe, expect, it } from "vitest";
import { makeI18n } from "../i18n";
import { handoverResult, handoverText } from "./simhandover";

const plain = (s: string) => s.replace(/[  ]/g, " ");

describe("simulation handover wording (#203)", () => {
  const en = makeI18n("en");
  const pl = makeI18n("pl");

  it("says how much the player now simulates, and what stayed", () => {
    const moved = { player: "Ragnar", objects: 1058, zones: 6, fromPeers: 1, already: 180, inUse: 2, capped: false };
    expect(handoverText(en, "Ragnar", moved)).toBe("Ragnar now simulates 1,058 more objects, in 6 zones · 2 in use stay");
    expect(plain(handoverText(pl, "Ragnar", moved))).toBe("Ragnar liczy teraz o 1058 obiektów więcej, w 6 strefach · 2 w użyciu zostają");
    expect(handoverText(en, "Freya", { objects: 1, zones: 1 })).toBe("Freya now simulates 1 more object, in 1 zone");
    expect(handoverText(pl, "Freya", { objects: 3, zones: 1 })).toBe("Freya liczy teraz o 3 obiekty więcej, w 1 strefie");
    expect(handoverText(en, "Freya", { objects: 5000, zones: 9, capped: true })).toBe("Freya now simulates 5,000 more objects, in 9 zones · hand over again for the rest");
  });

  it("says why nothing moved", () => {
    expect(handoverText(en, "Ragnar", { objects: 0, already: 1240 })).toBe("Ragnar already simulates everything near them that can move");
    expect(handoverText(en, "Ragnar", { objects: 0 })).toBe("No other player simulates anything near Ragnar");
    expect(handoverText(en, "Ragnar", { objects: 0, inUse: 1 })).toBe("Nothing handed to Ragnar: the one object left is in use");
    expect(handoverText(pl, "Ragnar", { objects: 0, inUse: 2 })).toBe("Nic nie przekazano (Ragnar): zostały 2 obiekty w użyciu");
    expect(handoverText(pl, "Ragnar", {})).toBe("Nikt inny nie liczy niczego obok: Ragnar");
  });

  it("reads odd answers as nothing", () => {
    expect(handoverResult(null)).toEqual({ objects: 0, zones: 0, fromPeers: 0, already: 0, inUse: 0, capped: false });
    expect(handoverResult({ objects: "12", zones: -1, capped: "yes" })).toMatchObject({ objects: 0, zones: 0, capped: false });
  });
});
