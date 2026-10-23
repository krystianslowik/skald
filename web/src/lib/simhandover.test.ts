import { describe, expect, it } from "vitest";
import { makeI18n } from "../i18n";
import { handoverResult, handoverText } from "./simhandover";

const plain = (s: string) => s.replace(/[  ]/g, " ");

describe("simulation handover wording (#203)", () => {
  const en = makeI18n("en");
  const pl = makeI18n("pl");

  it("says how much the player now simulates, and what stayed", () => {
    const moved = { player: "Ragnar", objects: 1058, zones: 6, fromPeers: 1, already: 180, inUse: 2, capped: false };
    expect(handoverText(en, "Ragnar", moved)).toBe("Ragnar now simulates 1,058 more objects, in 6 zones · 2 in use stay · a few may go back to a player who is changing them");
    expect(plain(handoverText(pl, "Ragnar", moved))).toBe("Ragnar liczy teraz o 1058 obiektów więcej, w 6 strefach · 2 w użyciu zostają · część może wrócić do gracza, który je właśnie zmienia");
    expect(handoverText(en, "Freya", { objects: 1, zones: 1 })).toBe("Freya now simulates 1 more object, in 1 zone · a few may go back to a player who is changing them");
    expect(handoverText(pl, "Freya", { objects: 3, zones: 1 })).toBe("Freya liczy teraz o 3 obiekty więcej, w 1 strefie · część może wrócić do gracza, który je właśnie zmienia");
    expect(handoverText(en, "Freya", { objects: 5000, zones: 9, failed: 2, capped: true })).toBe("Freya now simulates 5,000 more objects, in 9 zones · 2 could not be moved · hand over again for the rest · a few may go back to a player who is changing them");
  });

  it("says why nothing moved", () => {
    expect(handoverText(en, "Ragnar", { objects: 0, already: 1240 })).toBe("Ragnar already simulates everything near them that can move");
    expect(handoverText(en, "Ragnar", { objects: 0 })).toBe("No other player simulates anything near Ragnar");
    expect(handoverText(en, "Ragnar", { objects: 0, inUse: 1 })).toBe("Nothing handed to Ragnar: the one object left is in use");
    expect(handoverText(pl, "Ragnar", { objects: 0, inUse: 2 })).toBe("Nic nie przekazano (Ragnar): zostały 2 obiekty w użyciu");
    expect(handoverText(pl, "Ragnar", {})).toBe("Nikt inny nie liczy niczego obok: Ragnar");
  });

  it("says when objects were left alone on purpose, or failed", () => {
    expect(handoverText(en, "Ragnar", { objects: 0, loose: 2, kept: 40 })).toBe("Nothing handed to Ragnar: the 42 objects near them hold items or lie on the ground, and are left alone on purpose");
    expect(handoverText(en, "Ragnar", { objects: 0, kept: 1 })).toBe("Nothing handed to Ragnar: the one object near them holds items or lies on the ground, and is left alone on purpose");
    expect(handoverText(pl, "Ragnar", { objects: 0, kept: 3 })).toBe("Nic nie przekazano (Ragnar): 3 obiekty obok trzymają przedmioty albo leżą na ziemi i celowo zostają");
    // Failures come first: the admin should know something went wrong.
    expect(handoverText(en, "Ragnar", { objects: 0, failed: 3, kept: 5 })).toBe("Nothing handed to Ragnar: 3 objects could not be moved");
    expect(handoverText(pl, "Ragnar", { objects: 0, failed: 2 })).toBe("Nic nie przekazano (Ragnar): nie dało się przenieść 2 obiektów");
    // Moved some, kept the rest: both said.
    expect(handoverText(en, "Ragnar", { objects: 10, zones: 2, loose: 1, kept: 4 })).toBe("Ragnar now simulates 10 more objects, in 2 zones · 5 holding items stay · a few may go back to a player who is changing them");
  });

  it("reads odd answers as nothing", () => {
    expect(handoverResult(null)).toEqual({ objects: 0, zones: 0, fromPeers: 0, already: 0, inUse: 0, loose: 0, kept: 0, failed: 0, capped: false });
    expect(handoverResult({ objects: "12", zones: -1, capped: "yes" })).toMatchObject({ objects: 0, zones: 0, capped: false });
  });
});
