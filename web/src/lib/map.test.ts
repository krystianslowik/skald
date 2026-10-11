import { describe, expect, it } from "vitest";
import { gateMap } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { makeI18n } from "../i18n";
import {
  buildMarkers,
  clampView,
  clusterMarkers,
  decodeRLE,
  exploredBounds,
  fitBounds,
  fieldLoops,
  fitView,
  gridOutline,
  interestBounds,
  mainBase,
  type Marker,
  isExplored,
  isoPolygons,
  isoSegments,
  isWater,
  layerCounts,
  loopArea,
  pick,
  pickItem,
  placeLabels,
  portalLinks,
  screenToWorld,
  searchMarkers,
  simplifyLoop,
  smoothLoop,
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

describe("outlines", () => {
  const grid = (w: number, h: number, on: (i: number, j: number) => boolean) => {
    const f = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) f[j * w + i] = on(i, j) ? 1 : 0;
    return f;
  };

  it("finds nothing in an empty field", () => {
    expect(fieldLoops(new Float32Array(16), 4, 4)).toEqual([]);
  });

  it("closes a block on the grid's edge into one counter-clockwise loop", () => {
    // Filled to the border: beyond the grid counts as low, so it still closes.
    const loops = fieldLoops(grid(3, 3, () => true), 3, 3);
    expect(loops).toHaveLength(1);
    const loop = loops[0]!;
    // Crossings halfway between the nodes: a 3 x 3 square around nodes 0..2,
    // centred on 1, its corners cut by a quarter cell each.
    expect(loopArea(loop) / 2).toBeCloseTo(8.5, 5);
    for (let i = 0; i < loop.length; i += 2) {
      expect(Math.max(Math.abs(loop[i]! - 1), Math.abs(loop[i + 1]! - 1))).toBeCloseTo(1.5, 5);
    }
  });

  it("gives a ring an outer loop and a hole that winds the other way", () => {
    const loops = fieldLoops(
      grid(7, 7, (i, j) => Math.max(Math.abs(i - 3), Math.abs(j - 3)) <= 2 && !(i === 3 && j === 3)),
      7,
      7,
    );
    expect(loops).toHaveLength(2);
    const areas = loops.map(loopArea).sort((a, b) => a - b);
    expect(areas[0]).toBeLessThan(0);
    expect(areas[1]).toBeGreaterThan(0);
  });

  it("keeps diagonal neighbours together, as isoSegments does", () => {
    const loops = fieldLoops(grid(2, 2, (i, j) => i === j), 2, 2);
    expect(loops).toHaveLength(1);
  });

  it("thins straight runs and rounds the corners, staying closed", () => {
    const square = Float32Array.from([0, 0, 1, 0, 2, 0, 3, 0, 3, 1, 3, 2, 3, 3, 2, 3, 1, 3, 0, 3, 0, 2, 0, 1]);
    const thin = simplifyLoop(square, 0.1);
    expect(thin.length / 2).toBe(4);
    expect(Math.abs(loopArea(thin))).toBeCloseTo(18, 5);
    const round = smoothLoop(thin, 2);
    expect(round.length / 2).toBe(16);
    // Chaikin cuts the corners: a little smaller, never larger.
    const a = Math.abs(loopArea(round)) / 2;
    expect(a).toBeLessThan(9);
    expect(a).toBeGreaterThan(7);
  });

  it("outlines the mock's explored mask as round loops, dropping specks", () => {
    const disc = grid(40, 40, (i, j) => (i - 20) ** 2 + (j - 20) ** 2 <= 100);
    disc[0] = 1; // a single-cell speck
    const loops = gridOutline(disc, 40, 40);
    expect(loops).toHaveLength(1);
    const loop = loops[0]!;
    for (let i = 0; i < loop.length; i += 2) {
      const r = Math.hypot(loop[i]! - 20, loop[i + 1]! - 20);
      expect(r).toBeGreaterThan(9);
      expect(r).toBeLessThan(11);
    }
  });
});

describe("terrain water", () => {
  // The agent's palette (agent/internal/terrain): biome colours at seven
  // light levels, then eight water depths from shallow to deep. The Ocean
  // biome above water is left out: reading it as sea is right.
  const biomes = [
    [128, 116, 92],
    [156, 172, 92],
    [118, 102, 72],
    [226, 226, 230],
    [78, 102, 64],
    [208, 188, 116],
    [150, 66, 48],
    [206, 220, 232],
    [112, 98, 124],
  ];
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

  it("tells every water depth from every lit biome", () => {
    for (let d = 0; d < 8; d++) {
      const k = d / 7;
      expect(isWater(clamp(116 + (38 - 116) * k), clamp(156 + (66 - 156) * k), clamp(164 + (92 - 164) * k), 255)).toBe(true);
    }
    for (const c of biomes) {
      for (let s = 0; s < 7; s++) {
        const f = 0.62 + s * (0.68 / 6);
        expect(isWater(clamp(c[0]! * f), clamp(c[1]! * f), clamp(c[2]! * f), 255)).toBe(false);
      }
    }
  });

  it("counts beyond the world's edge as sea, so the rim draws no coast", () => {
    expect(isWater(0, 0, 0, 0)).toBe(true);
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
    expect(crypt?.label).toBe("Burial Chambers");
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

describe("first view", () => {
  it("fits the explored area, clear of the controls", () => {
    const mask = decodeRLE(snap.explored.rle, snap.explored.size);
    const b = exploredBounds(mask, snap.explored.size, snap.explored.metersPerPixel)!;
    expect(b[0]).toBeLessThan(b[2]);
    expect(b[1]).toBeLessThan(b[3]);
    // Every explored location sits inside the bounds.
    for (const l of snap.locations.filter((x) => x.explored && x.placed)) {
      expect(l.x).toBeGreaterThanOrEqual(b[0] - 12);
      expect(l.x).toBeLessThanOrEqual(b[2] + 12);
      expect(l.z).toBeGreaterThanOrEqual(b[1] - 12);
      expect(l.z).toBeLessThanOrEqual(b[3] + 12);
    }
    // A phone: the box fills the width and stays above the bottom controls.
    const v = fitBounds(390, 700, b, { top: 12, right: 12, bottom: 72, left: 12 });
    const [ax, ay] = worldToScreen(v, b[0], b[3]);
    const [bx, by] = worldToScreen(v, b[2], b[1]);
    expect(ax).toBeGreaterThanOrEqual(11.9);
    expect(bx).toBeLessThanOrEqual(378.1);
    expect(ay).toBeGreaterThanOrEqual(11.9);
    expect(by).toBeLessThanOrEqual(628.1);
    expect(Math.max(bx - ax, by - ay)).toBeGreaterThan(300);
    expect(exploredBounds(new Uint8Array(16), 4, 12)).toBeNull();
  });

  it("falls back to bases, portals and graves, not far-flung pins", () => {
    const map = { ...gateMap(snap, false), bases: [{ ...snap.bases[0]!, x: 100, z: 100 }], portals: [], tombstones: [], pins: [{ ...snap.pins[0]!, x: 9000, z: -9000 }] };
    expect(interestBounds(map)).toEqual([100, 100, 100, 100]);
    expect(interestBounds({ ...map, bases: [] })).toEqual([9000, -9000, 9000, -9000]);
  });
});

describe("clusters", () => {
  const all = buildMarkers(gateMap(snap, false), lookup);
  const mk = (id: string, layer: Marker["layer"], tier: number, priority: number, x: number, z: number) => ({ id, layer, tier, priority, x, z }) as Marker;

  it("lets bases, portals and graves lead piles of pins and places", () => {
    const pin = mk("pin", "pins", 0, 99, 0, 0);
    const base = mk("base", "bases", 2, 50, 5, 0);
    const far = mk("far", "pins", 0, 10, 500, 0);
    const c = clusterMarkers([pin, base, far], 20);
    expect(c).toHaveLength(2);
    expect(c[0]!.lead.id).toBe("base");
    expect(c[0]!.members.map((m) => m.id)).toEqual(["base", "pin"]);
    expect(c[1]!.members).toHaveLength(1);
  });

  it("clusters the same layer wider than marks of another", () => {
    const a = mk("a", "portals", 2, 70, 0, 0);
    const b = mk("b", "portals", 2, 70, 18, 0);
    const g = mk("g", "graves", 2, 60, 18, 0);
    const c = clusterMarkers([a, b, g], 20);
    expect(c.find((x) => x.lead.id === "a")!.members.map((m) => m.id)).toEqual(["a", "b"]);
    expect(c.some((x) => x.lead.id === "g")).toBe(true);
  });

  it("splits apart as the radius shrinks, and keeps every mark exactly once", () => {
    const wide = clusterMarkers(all, 800);
    const near = clusterMarkers(all, 5);
    expect(wide.length).toBeLessThan(near.length);
    for (const list of [wide, near]) expect(list.reduce((n, c) => n + c.members.length, 0)).toBe(all.length);
    expect(clusterMarkers(all, 0)).toHaveLength(all.length);
  });

  it("picks a cluster with its members", () => {
    const members = [mk("a", "pins", 0, 1, 0, 0), mk("b", "pins", 0, 1, 1, 1)];
    const hit = pickItem([{ m: members[0]!, sx: 50, sy: 50, members }], 60, 55, 28);
    expect(hit?.members).toHaveLength(2);
  });
});

describe("names", () => {
  const markers = buildMarkers(gateMap(snap, false), lookup);
  it("names a base after the home pin next to it and finds the main base", () => {
    const home = mainBase(markers)!;
    expect(home.data.type === "base" && home.data.name).toBe("Hearthstead");
    expect(home.label).toBe("Hearthstead");
    // The pin lends its name rather than repeating it on the map.
    const pin = markers.find((m) => m.data.type === "pin" && m.data.name === "Hearthstead")!;
    expect(pin.label).toBe("");
    // Portal tags read from the first view on a phone, before pins do.
    const portal = markers.find((m) => m.layer === "portals")!;
    const anyPin = markers.find((m) => m.layer === "pins" && m.label)!;
    expect(portal.labelScale).toBeLessThan(0.05);
    expect(portal.rank).toBeGreaterThan(anyPin.rank);
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

describe("contents strip", () => {
  it("picks the kinds held most of, by total count", async () => {
    const { topItems } = await import("./maprender");
    const items = [
      { name: "Wood", stack: 50, x: 0, y: 0 },
      { name: "Stone", stack: 30, x: 1, y: 0 },
      { name: "Wood", stack: 20, x: 2, y: 0 },
      { name: "Resin", stack: 40, x: 3, y: 0 },
      { name: "Coins", stack: 5, x: 4, y: 0 },
      { name: "Amber", stack: 5, x: 0, y: 1 },
    ];
    expect(topItems(items)).toEqual(["Wood", "Resin", "Stone", "Amber"]);
    expect(topItems(items, 2)).toEqual(["Wood", "Resin"]);
    expect(topItems([])).toEqual([]);
  });
});
