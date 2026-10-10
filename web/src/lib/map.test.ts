import { describe, expect, it } from "vitest";
import { gateMap } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { makeI18n } from "../i18n";
import {
  buildMarkers,
  clampView,
  decodeRLE,
  fitView,
  isExplored,
  isoPolygons,
  isoSegments,
  layerCounts,
  pick,
  placeLabels,
  portalLinks,
  screenToWorld,
  searchMarkers,
  worldToScreen,
  zoomAt,
  type Box,
} from "./mapgeo";
import { inertiaStep, releaseVelocity, springStep } from "./mapmotion";
import { mapUrlAt, terrainUrl } from "./world";

const snap = mockMap({ now: Date.parse("2026-10-10T20:00:00Z") });
const lookup = makeI18n("en").lookup;

describe("decoders", () => {
  it("decodes the explored runs and agrees with the agent's flags", () => {
    const mask = decodeRLE(snap.explored.rle, snap.explored.size);
    expect(mask.reduce((a, b) => a + b, 0)).toBe(snap.explored.pixels);
    // Orientation proof: every location flagged explored by the mask reads explored here.
    const flagged = snap.locations.filter((l) => l.explored && l.placed);
    const inMask = flagged.filter((l) => isExplored(mask, l.x, l.z));
    expect(inMask.length / flagged.length).toBeGreaterThan(0.9);
    // Swapping x and z must not agree as well.
    const swapped = flagged.filter((l) => isExplored(mask, l.z, l.x));
    expect(swapped.length).toBeLessThan(inMask.length);
    expect(isExplored(mask, 0, 0)).toBe(true);
    expect(isExplored(mask, 9000, -9000)).toBe(false);
    expect(isExplored(null, 0, 0)).toBe(false);
  });
});

describe("marching squares", () => {
  // A 4x4 field with a 2x2 island in the middle.
  const f = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
  it("fills the inside and draws a closed coast", () => {
    const polys = isoPolygons(f, 4, 0, 10);
    expect(polys.length).toBeGreaterThan(0);
    for (const p of polys) for (let i = 0; i < p.length; i += 2) expect(p[i]! >= 0 && p[i]! <= 30).toBe(true);
    const seg = isoSegments(f, 4, 0, 10);
    expect(seg.length % 4).toBe(0);
    // Every segment end is shared by another segment: the coast is closed.
    const ends = new Map<string, number>();
    for (let i = 0; i < seg.length; i += 2) {
      const k = `${seg[i]!.toFixed(3)},${seg[i + 1]!.toFixed(3)}`;
      ends.set(k, (ends.get(k) ?? 0) + 1);
    }
    expect([...ends.values()].every((n) => n === 2)).toBe(true);
  });
});

describe("view", () => {
  const v = clampView({ cx: 100, cz: -200, scale: 0.5, w: 800, h: 600 });
  it("round-trips screen and world with north up", () => {
    const [sx, sy] = worldToScreen(v, 150, -150);
    expect(sx).toBeCloseTo(425);
    expect(sy).toBeCloseTo(275); // north of the centre is above it
    const [x, z] = screenToWorld(v, sx, sy);
    expect(x).toBeCloseTo(150);
    expect(z).toBeCloseTo(-150);
  });
  it("zooms around the pointer", () => {
    const before = screenToWorld(v, 600, 100);
    const z = zoomAt(v, 600, 100, 2);
    expect(z.scale).toBeCloseTo(1);
    const after = screenToWorld(z, 600, 100);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });
  it("never zooms out past the whole world or leaves it", () => {
    const far = clampView({ cx: 50_000, cz: 0, scale: 1e-6, w: 800, h: 600 });
    expect(far.scale).toBeGreaterThan(0.02);
    expect(Math.hypot(far.cx, far.cz)).toBeLessThanOrEqual(10_500.001);
    const f = fitView(800, 600, -100, -100, 100, 100);
    expect(f.cx).toBe(0);
  });
});

describe("markers and layers", () => {
  const off = gateMap(snap, false);
  const markers = buildMarkers(off, lookup);
  it("builds one mark per thing, with counts per layer", () => {
    const c = layerCounts(markers, off);
    expect(c.bases).toBe(snap.bases.length);
    expect(c.portals).toBe(7);
    expect(c.graves).toBe(3);
    expect(c.beds).toBe(4);
    expect(c.vehicles).toBe(3);
    expect(c.pins).toBe(10);
    expect(c.locations).toBe(off.locations.length);
    expect(c.terrain).toBe(snap.terrainEdits.length);
  });
  it("shows no unfound place without spoilers", () => {
    const locs = markers.filter((m) => m.data.type === "location");
    expect(locs.length).toBeGreaterThan(0);
    expect(locs.every((m) => m.data.type === "location" && m.data.explored)).toBe(true);
    expect(buildMarkers(gateMap(snap, true), lookup).filter((m) => m.layer === "locations").length).toBe(snap.locations.length);
  });
  it("names places and pairs portals", () => {
    const eik = markers.find((m) => m.data.type === "location" && m.data.name === "Eikthyrnir");
    expect(eik?.label).toBe("Eikthyr's altar");
    const crypt = buildMarkers(gateMap(snap, true), lookup).find((m) => m.data.type === "location" && m.data.name === "Crypt3");
    expect(crypt?.label).toBe("Burial chambers");
    const home = markers.find((m) => m.data.type === "portal" && m.data.tag === "home" && m.x > 0);
    expect(home?.data.type === "portal" && home.data.partnerTag).toBe("home");
    expect(portalLinks(off)).toHaveLength(3);
  });
  it("searches labels and kinds", () => {
    const r = searchMarkers(markers, "hald", () => "");
    expect(r[0]?.label).toBe("Haldor");
    expect(searchMarkers(markers, "", () => "")).toEqual([]);
    expect(searchMarkers(markers, "grave", (m) => (m.layer === "graves" ? "Grave" : "")).every((m) => m.layer === "graves")).toBe(true);
  });
});

describe("picking and labels", () => {
  const m = (id: string, priority: number) => ({ id, priority }) as never;
  it("picks the nearest mark in reach", () => {
    const items = [
      { m: m("a", 1), sx: 100, sy: 100 },
      { m: m("b", 2), sx: 110, sy: 100 },
    ];
    expect((pick(items, 104, 100) as unknown as { id: string }).id).toBe("a");
    expect(pick(items, 300, 300)).toBeNull();
  });
  it("places labels without overlaps, best first", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ sx: 100 + (i % 6) * 30, sy: 100 + Math.floor(i / 6) * 12, text: `Label ${i}`, priority: i }));
    const icons: Box[] = items.map((i) => ({ x: i.sx - 8, y: i.sy - 8, w: 16, h: 16 }));
    const placed = placeLabels(items, icons, (t) => t.length * 6);
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.length).toBeLessThan(items.length);
    expect(placed[0]!.text).toBe("Label 59");
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!;
        const b = placed[j]!;
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
    }
  });
});

describe("motion", () => {
  it("lets a fling come to rest", () => {
    let v = 2000;
    let d = 0;
    for (let i = 0; i < 300; i++) {
      const s = inertiaStep(v, 16);
      d += s.d;
      v = s.v;
    }
    expect(Math.abs(v)).toBeLessThan(1);
    // Projection of 2000 px/s at 0.998: about 2 * 0.998 / 0.002 ~ 1000 px.
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(1100);
  });
  it("settles a spring without overshoot", () => {
    let x = 0;
    let v = 0;
    let max = 0;
    for (let i = 0; i < 120; i++) {
      ({ x, v } = springStep(x, v, 100, 1 / 60));
      max = Math.max(max, x);
    }
    expect(x).toBeCloseTo(100, 1);
    expect(max).toBeLessThanOrEqual(100.0001);
  });
  it("measures release velocity over the last 100 ms", () => {
    expect(releaseVelocity([])).toEqual([0, 0]);
    const [vx] = releaseVelocity([
      { x: 0, y: 0, t: 0 },
      { x: 500, y: 0, t: 200 },
      { x: 600, y: 0, t: 250 },
      { x: 700, y: 0, t: 300 },
    ]);
    expect(vx).toBeCloseTo(2000);
  });
});

describe("valheim-map.world links", () => {
  it("centres on a world point (offset = x,z under the centre, smaller zoom is closer)", () => {
    // Loaded in Chromium: the site's own readout under the centre showed (1000, -503).
    expect(mapUrlAt("ZbzIWkK5KK", 1000, -500)).toBe("https://valheim-map.world/?seed=ZbzIWkK5KK&offset=1000,-500&zoom=0.100&ver=1.0.7");
    expect(mapUrlAt("a b", 12.4, -0.6, 0.6)).toBe("https://valheim-map.world/?seed=a%20b&offset=12,-1&zoom=0.600&ver=1.0.7");
    expect(terrainUrl("ZbzIWkK5KK")).toBe("https://valheim-map.world/?seed=ZbzIWkK5KK&ver=1.0.7");
  });
});
