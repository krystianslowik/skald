import { describe, expect, it } from "vitest";
import type { MapPortal } from "../types";
import { findRoute, HOP_M, nearestPlace, noWarnings, partners, portalGroups, portalWarnings } from "./portalnet";

/** A synthetic portal; `to` pairs it (the fixture lists both ends). */
const P = (id: string, x: number, z: number, tag: string, to?: string): MapPortal => ({ id, kind: "portal_wood", x, z, tag, ...(to ? { pairedWith: to } : {}) });

// Two clean pairs, a tag on three portals (one pair plus a leftover), a lone
// portal, an untagged pair and two portals stacked on one spot.
const NET: MapPortal[] = [
  P("0,0", 0, 0, "alpha", "4000,0"),
  P("4000,0", 4000, 0, "alpha", "0,0"),
  P("10,0", 10, 0, "beta", "0,3000"),
  P("0,3000", 0, 3000, "beta", "10,0"),
  P("20,0", 20, 0, "gamma", "-3000,0"),
  P("-3000,0", -3000, 0, "gamma", "20,0"),
  P("-3100,50", -3100, 50, "gamma"),
  P("500,500", 500, 500, "delta"),
  P("30,0", 30, 0, "", "30,0#1"),
  P("30,0#1", 30, 0, "", "30,0"),
];

describe("partners", () => {
  it("pairs by id, so two portals on one spot stay apart", () => {
    const pair = partners(NET);
    expect(pair.get("30,0")?.id).toBe("30,0#1");
    expect(pair.get("30,0#1")?.id).toBe("30,0");
  });
  it("ignores a partner missing from the save or not pointing back", () => {
    const pair = partners([P("a", 0, 0, "x", "gone"), P("b", 1, 1, "y", "c"), P("c", 2, 2, "y", "d"), P("d", 3, 3, "y", "c")]);
    expect(pair.has("a")).toBe(false);
    expect(pair.has("b")).toBe(false);
    expect(pair.get("c")?.id).toBe("d");
  });
});

describe("portalGroups", () => {
  it("groups by tag, alphabetically, the untagged last", () => {
    const g = portalGroups(NET, true);
    expect(g.map((x) => x.tag)).toEqual(["alpha", "beta", "delta", "gamma", ""]);
    expect(g.find((x) => x.tag === "gamma")!.portals).toHaveLength(3);
  });
  it("groups connected pairs, then lone portals, when names are hidden", () => {
    const hidden = NET.map((p) => ({ ...p, tag: "" }));
    const g = portalGroups(hidden, false);
    expect(g.every((x) => x.tag === "")).toBe(true);
    expect(g.map((x) => x.portals.length)).toEqual([2, 2, 2, 2, 1, 1]);
    expect(g.slice(4).flatMap((x) => x.portals.map((p) => p.id)).sort()).toEqual(["-3100,50", "500,500"]);
  });
});

describe("portalWarnings", () => {
  it("finds portals without a partner, crowded tags and untagged portals", () => {
    const w = portalWarnings(NET, true);
    expect(w.noPartner.map((p) => p.id)).toEqual(["-3100,50", "500,500"]);
    expect(w.crowded.map((g) => [g.tag, g.portals.length])).toEqual([["gamma", 3]]);
    expect(w.untagged.map((p) => p.id).sort()).toEqual(["30,0", "30,0#1"]);
    expect(noWarnings(w)).toBe(false);
  });
  it("skips the tag checks when names are hidden", () => {
    const hidden = NET.map((p) => ({ ...p, tag: "" }));
    const w = portalWarnings(hidden, false);
    expect(w.untagged).toEqual([]);
    expect(w.crowded).toEqual([]);
    expect(w.noPartner).toHaveLength(2);
  });
  it("treats a tag of only spaces as no tag", () => {
    const blank = [P("a", 0, 0, " "), P("b", 1, 0, " "), P("c", 2, 0, "  ")];
    const w = portalWarnings(blank, true);
    expect(w.untagged).toHaveLength(3);
    expect(w.crowded).toEqual([]);
    expect(portalGroups(blank, true).map((g) => g.tag)).toEqual([""]);
  });
  it("is quiet for a clean network", () => {
    expect(noWarnings(portalWarnings(NET.slice(0, 4), true))).toBe(true);
    expect(noWarnings(portalWarnings([], true))).toBe(true);
  });
});

describe("findRoute", () => {
  it("walks straight when no portal helps", () => {
    const r = findRoute({ x: 100, z: 100 }, { x: 200, z: 100 }, NET);
    expect(r.hops).toBe(0);
    expect(r.legs).toHaveLength(1);
    expect(r.walk).toBe(100);
    expect(r.direct).toBe(100);
  });
  it("takes a portal across the map: walk, hop, walk", () => {
    const r = findRoute({ x: 0, z: 50 }, { x: 4000, z: 120 }, NET);
    expect(r.legs.map((l) => l.kind)).toEqual(["walk", "hop", "walk"]);
    const hop = r.legs[1]!;
    expect(hop.kind === "hop" && [hop.from.id, hop.to.id]).toEqual(["0,0", "4000,0"]);
    expect(r.walk).toBe(170);
    expect(r.hops).toBe(1);
  });
  it("chains portals, walking between them", () => {
    const chain = [P("a1", 0, 0, "a", "a2"), P("a2", 5000, 0, "a", "a1"), P("b1", 5040, 0, "b", "b2"), P("b2", 5000, 5000, "b", "b1")];
    const r = findRoute({ x: 10, z: 0 }, { x: 5000, z: 5030 }, chain);
    expect(r.legs.map((l) => l.kind)).toEqual(["walk", "hop", "walk", "hop", "walk"]);
    expect(r.hops).toBe(2);
    expect(r.walk).toBe(10 + 40 + 30);
  });
  it("never takes a hop that saves less than the hop costs", () => {
    const pair = [P("a", 0, 0, "t", "b"), P("b", HOP_M / 2, 0, "t", "a")];
    const r = findRoute({ x: 0, z: 0 }, { x: HOP_M / 2, z: 0 }, pair);
    expect(r.hops).toBe(0);
  });
  it("ignores portals without a partner", () => {
    const lone = [P("a", 0, 0, "t", "gone"), P("b", 9000, 0, "t")];
    const r = findRoute({ x: 0, z: 0 }, { x: 9000, z: 0 }, lone);
    expect(r.hops).toBe(0);
    expect(r.walk).toBe(9000);
  });
  it("goes through two portals on one spot to the right partner", () => {
    const stacked = [P("0,0", 0, 0, "x", "3000,0"), P("0,0#1", 0, 0, "y", "0,3000"), P("3000,0", 3000, 0, "x", "0,0"), P("0,3000", 0, 3000, "y", "0,0#1")];
    const r = findRoute({ x: 5, z: 0 }, { x: 0, z: 3010 }, stacked);
    const hop = r.legs.find((l) => l.kind === "hop");
    expect(hop?.kind === "hop" && hop.to.id).toBe("0,3000");
  });
  it("has no legs from a spot to itself", () => {
    const r = findRoute({ x: 7, z: 7 }, { x: 7, z: 7 }, NET);
    expect(r.legs).toEqual([]);
    expect(r.walk).toBe(0);
  });
  it("leaves out a step of less than a metre onto a portal, but counts it", () => {
    const pair = [P("a", 0, 0, "t", "b"), P("b", 5000, 0, "t", "a")];
    const r = findRoute({ x: 0.4, z: 0 }, { x: 5000, z: 300 }, pair);
    expect(r.legs.map((l) => l.kind)).toEqual(["hop", "walk"]);
    expect(r.walk).toBeCloseTo(300.4, 5);
  });
});

describe("nearestPlace", () => {
  const places = [
    { name: "Hearth", x: 0, z: 0 },
    { name: "", x: 50, z: 0 },
    { name: "Camp", x: 400, z: 0 },
  ];
  it("names the closest named place in reach", () => {
    expect(nearestPlace({ x: 60, z: 0 }, places)?.name).toBe("Hearth");
    expect(nearestPlace({ x: 300, z: 0 }, places)?.name).toBe("Camp");
  });
  it("gives nothing when every place is out of reach", () => {
    expect(nearestPlace({ x: 2000, z: 0 }, places)).toBeNull();
  });
});
