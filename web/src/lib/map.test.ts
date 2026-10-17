import { describe, expect, it } from "vitest";
import { gateMap } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { makeI18n } from "../i18n";
import {
  backInside,
  buildMarkers,
  clampView,
  clipRing,
  closeRing,
  clusterMarkers,
  decodeRLE,
  exploredBounds,
  fitBounds,
  fieldLoops,
  fitView,
  gridOutline,
  interestBounds,
  mainBase,
  MAX_SCALE,
  minScale,
  type Marker,
  isExplored,
  isoPolygons,
  isoSegments,
  isWater,
  layerCounts,
  loopArea,
  mapShapes,
  shapeBuffers,
  pick,
  pickItem,
  placeLabels,
  portalLinks,
  ringBox,
  RingSet,
  screenToWorld,
  searchMarkers,
  simplifyLoop,
  smoothLoop,
  worldToScreen,
  zoomAt,
  WORLD_RADIUS,
  type Box,
} from "./mapgeo";
import { bandCentre, bounceGlide, EDGE_RUBBER, flingOffset, glideStep, inertiaStep, intoBand, REST_SPEED, RUBBER, rubberBand, SampleRing, springStep, unbandCentre, unrubberBand, ZOOM_DECELERATION, ZOOM_REST, zoomFlingOffset } from "./mapmotion";
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

  it("cuts a ring to a box along the box's sides, keeping the area inside", () => {
    const square = Float32Array.from([0, 0, 10, 0, 10, 10, 0, 10]);
    expect(clipRing(square, [-5, -5, 20, 20])).toEqual(square);
    const half = clipRing(square, [5, -5, 20, 20])!;
    expect(ringBox(half)).toEqual([5, 0, 10, 10]);
    expect(Math.abs(loopArea(half)) / 2).toBeCloseTo(50, 5);
    // A ring round the whole box becomes the box.
    expect(Math.abs(loopArea(clipRing(square, [2, 3, 4, 8])!)) / 2).toBeCloseTo(10, 5);
    expect(clipRing(square, [20, 20, 30, 30])).toBeNull();
  });

  it("gives the rings near a box, simplified only as far as the zoom hides", () => {
    // A finely sampled circle of radius 100 m and a small ring far away; 12 m per unit.
    const circle = Float32Array.from({ length: 720 }, (_, i) => (i % 2 ? Math.sin : Math.cos)((Math.floor(i / 2) / 360) * Math.PI * 2) * 100);
    const far = Float32Array.from([5000, 5000, 5010, 5000, 5010, 5010]);
    const set = new RingSet([circle, far], 12);
    expect(set.lodFor(2)).toBe(0);
    expect(set.lodFor(0.01)).toBe(4);
    const close = set.near([-200, -200, 200, 200], 2);
    expect(close).toHaveLength(1);
    expect(close[0]!.length).toBe(circle.length);
    // Zoomed far out: every ring, with far fewer points, still round.
    const out = set.near([-10000, -10000, 10000, 10000], 0.01);
    expect(out).toHaveLength(2);
    expect(out[0]!.length).toBeLessThan(circle.length / 4);
    for (let i = 0; i < out[0]!.length; i += 2) expect(Math.hypot(out[0]![i]!, out[0]![i + 1]!)).toBeCloseTo(100, 0);
    // Half the circle in the box: cut to it.
    const cut = set.near([0, -200, 200, 200], 2);
    expect(ringBox(cut[0]!)[0]).toBeCloseTo(0, 5);
    // A view moved a little reuses the cut; one moved far cuts again.
    expect(set.near([10, -190, 210, 210], 2)).toBe(cut);
    expect(set.near([-150, -200, 50, 200], 2)).not.toBe(cut);
  });

  it("builds the land and fog shapes as transferable arrays in world units", () => {
    const shapes = mapShapes(snap.land, snap.explored);
    expect(shapes.land.length).toBeGreaterThan(0);
    expect(shapes.sea.length).toBeGreaterThan(0);
    expect(shapes.coast.length % 4).toBe(0);
    expect(shapes.density.length).toBe(shapes.size * shapes.size * 4);
    expect(shapes.fog!.length).toBeGreaterThan(0);
    // The fog's outline lies inside the explored box, in metres.
    const box = exploredBounds(decodeRLE(snap.explored.rle, snap.explored.size), snap.explored.size, snap.explored.metersPerPixel)!;
    for (const r of shapes.fog!) {
      const b = ringBox(r);
      expect(b[0]).toBeGreaterThanOrEqual(box[0] - 3 * shapes.fogStep);
      expect(b[3]).toBeLessThanOrEqual(box[3] + 3 * shapes.fogStep);
    }
    // Every buffer once, so a worker can transfer them all.
    const bufs = shapeBuffers(shapes);
    expect(new Set(bufs).size).toBe(bufs.length);
    expect(mapShapes(snap.land, { ...snap.explored, available: false }).fog).toBeNull();
  });

  it("closes a ring by going back to the start and over the first edge, not with closePath", () => {
    const calls: number[][] = [];
    closeRing({ lineTo: (x, y) => calls.push([x, y]) }, 1, 2, 3, 4);
    expect(calls).toEqual([
      [1, 2],
      [3, 4],
    ]);
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
  it("stretches a zoom past its limits less and less, never further than the band", () => {
    expect(rubberBand(1, 0, 2)).toBe(1);
    const a = rubberBand(2.1, 0, 2) - 2;
    const b = rubberBand(2.5, 0, 2) - 2;
    const c = rubberBand(10, 0, 2) - 2;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(0.1);
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeLessThan(0.4);
    expect(c).toBeLessThan(RUBBER);
    expect(rubberBand(-0.5, 0, 2)).toBeCloseTo(-(rubberBand(2.5, 0, 2) - 2), 10);
    // Undone exactly, so a pinch that catches a zoom springing back goes on from where it shows.
    for (const x of [-0.5, 1, 2.1, 2.5, 4]) expect(unrubberBand(rubberBand(x, 0, 2), 0, 2)).toBeCloseTo(x, 9);
  });

  it("lets a pinch's momentum run out sooner than a pan's", () => {
    let v = 3;
    let d = 0;
    for (let i = 0; i < 200 && Math.abs(v) > 0.05; i++) {
      const s = inertiaStep(v, 16, ZOOM_DECELERATION);
      d += s.d;
      v = s.v;
    }
    // A brisk pinch (x20 a second) carries on by well under 2x.
    expect(d).toBeGreaterThan(0.2);
    expect(Math.exp(d)).toBeLessThan(2);
  });

  const ring = (pts: readonly (readonly [number, number])[]) => {
    const r = new SampleRing(8);
    for (const [x, t] of pts) r.push(x, 0, t);
    return r;
  };

  it("measures release velocity over the last 100 ms", () => {
    expect(new SampleRing().velocity()).toEqual([0, 0]);
    const [vx] = ring([
      [0, 0],
      [500, 200],
      [600, 250],
      [700, 300],
    ]).velocity();
    expect(vx).toBeCloseTo(2000);
    // Lifted right after the last move it keeps its speed; after a pause it has none.
    const run = ring([
      [600, 250],
      [700, 300],
    ]);
    expect(run.velocity(308)[0]).toBeCloseTo(2000);
    expect(run.velocity(420)).toEqual([0, 0]);
  });

  it("keeps only the newest samples, without allocating per move", () => {
    const r = new SampleRing(4);
    for (let i = 0; i < 40; i++) r.push(i * 10, -i * 5, i * 8);
    expect(r.size).toBe(4);
    const [vx, vy] = r.velocity(312);
    expect(vx).toBeCloseTo(1250);
    expect(vy).toBeCloseTo(-625);
  });

  it("fits a noisy release better than its last two samples", () => {
    // 1500 px/s with a finger's jitter: the last sample comes in late.
    const pts: [number, number][] = [];
    const jitter = [0.8, -1.1, 0.4, 1.2, -0.6, 0.9, -1.3, 0, 0.7, -2.4];
    for (let i = 0; i < 10; i++) pts.push([i * 12 + jitter[i]!, i * 8]);
    const lsq = ring(pts.slice(-8)).velocity()[0];
    const two = ring(pts.slice(-2)).velocity()[0];
    expect(Math.abs(lsq - 1500)).toBeLessThan(Math.abs(two - 1500));
    expect(Math.abs(lsq - 1500)).toBeLessThan(60);
  });

  it("stretches a pan past the world's edge a little, and undoes the stretch exactly", () => {
    const R = 1000;
    const inside = { cx: 300, cz: -400, scale: 2 };
    expect(bandCentre(inside, R)).toBe(inside);
    expect(unbandCentre(inside, R)).toBe(inside);
    let prev = 0;
    for (const over of [5, 40, 200, 2000, 1e6]) {
      // `over` px past the edge, due east and to the north-west.
      for (const [dx, dz] of [
        [1, 0],
        [-Math.SQRT1_2, Math.SQRT1_2],
      ] as const) {
        const raw = { cx: dx * (R + over / 2), cz: dz * (R + over / 2), scale: 2 };
        const b = bandCentre(raw, R);
        const px = (Math.hypot(b.cx, b.cz) - R) * 2;
        expect(px).toBeGreaterThan(0);
        expect(px).toBeLessThan(Math.min(over, EDGE_RUBBER));
        // The direction is kept.
        expect(b.cx * dz - b.cz * dx).toBeCloseTo(0, 6);
        if (dx === 1) {
          expect(px).toBeGreaterThan(prev);
          prev = px;
        }
        if (over < 2000) {
          const u = unbandCentre(b, R);
          expect(u.cx).toBeCloseTo(raw.cx, 4);
          expect(u.cz).toBeCloseTo(raw.cz, 4);
        }
      }
    }
  });

  describe("spring back from a limit", () => {
    const R = 10500;
    const scale = 0.5;
    /** px past the world's edge, due east. */
    const past = (v: { cx: number; scale: number }) => (v.cx - R) * v.scale;
    /** Runs a glide at 60 fps: the px past the edge every frame, until it settles or `sec` runs out. */
    const run = (cx: number, vx: number, sec = 2) => {
      let v = { cx, cz: 0, scale };
      const gl = { cx: R, cz: 0, ls: Math.log(scale), v: [vx, 0, 0] as [number, number, number], back: true };
      const out: number[] = [];
      for (let i = 0; i < sec * 60; i++) {
        const s = glideStep(v, gl, 1 / 60, R);
        v = s.view;
        out.push(past(v));
        if (s.done) break;
      }
      return out;
    };

    it("carries a fling's speed across the edge into the stretch", () => {
      // Straight out: sped up behind the stretch, so the stretch moves as fast as the map did.
      const [vx] = intoBand({ cx: R, cz: 0, scale: 1 }, 1000, 0, R);
      const shown = bandCentre({ cx: R + vx * 1e-4, cz: 0, scale: 1 }, R);
      expect((shown.cx - R) / 1e-4).toBeCloseTo(1000, -1);
      // Along the edge or back inside: unchanged.
      expect(intoBand({ cx: R, cz: 0, scale: 1 }, 0, 500, R)).toEqual([0, 500]);
      expect(intoBand({ cx: R, cz: 0, scale: 1 }, -300, 0, R)).toEqual([-300, 0]);
      // At an angle only the outward part grows.
      const [x, z] = intoBand({ cx: 0, cz: R, scale: 1 }, 400, 300, R);
      expect(x).toBe(400);
      expect(z).toBeCloseTo(300 / 0.55, 9);
      // Already well into the band (a fast fling, a dropped frame): the shown stretch still keeps the speed.
      const deep = { cx: R + 100, cz: 0, scale: 1 };
      const [dv] = intoBand(deep, 1000, 0, R);
      const before = bandCentre(deep, R).cx;
      const after = bandCentre({ ...deep, cx: deep.cx + dv * 1e-5 }, R).cx;
      expect((after - before) / 1e-5).toBeCloseTo(1000, -1);
    });

    it("springs back from the edge over the spring's response, not in a few frames (#125)", () => {
      // Let go 50 px past the edge (banded, as a pan leaves it), from rest.
      const start = bandCentre({ cx: R + 300 / scale, cz: 0, scale }, R);
      expect(past(start)).toBeCloseTo(50, 0);
      const px = run(start.cx, 0);
      // One frame later it has barely moved (the old glide squeezed it to 20 px), and it does not jump.
      expect(px[0]).toBeGreaterThan(45);
      expect(px[0]).toBeLessThan(50);
      for (let i = 1; i < px.length; i++) expect(px[i]!).toBeLessThanOrEqual(px[i - 1]! + 1e-9);
      const settled = px.findIndex((p) => p < 1) / 60;
      expect(settled).toBeGreaterThan(0.25);
      expect(settled).toBeLessThan(0.4);
      expect(px[px.length - 1]).toBe(0);
    });

    it("lets a fling into the edge give more the faster it was, never past the band (#125)", () => {
      const peak = (speed: number) => {
        const px = run(R, intoBand({ cx: R, cz: 0, scale }, speed / scale, 0, R)[0]);
        // Back at the edge well within a second.
        expect(px.findIndex((p, i) => i > 3 && p < 1) / 60).toBeLessThan(0.6);
        return Math.max(...px);
      };
      const slow = peak(600);
      const brisk = peak(1800);
      const hard = peak(6000);
      expect(slow).toBeGreaterThan(6);
      expect(brisk).toBeGreaterThan(18);
      expect(brisk).toBeGreaterThan(slow * 1.8);
      expect(hard).toBeGreaterThan(brisk);
      expect(hard).toBeLessThan(EDGE_RUBBER);
    });

    it("never leaves a view past a limit when a tap stops its spring back (#124)", () => {
      const w = 390;
      const h = 844;
      // A pinch let go at 30.8 px/m, past the closest zoom: it springs back round the fingers.
      let v = { cx: 100, cz: 50, scale: 30.8, w, h };
      const target = backInside(v, 195, 400)!;
      expect(target.scale).toBe(MAX_SCALE);
      const gl = { cx: target.cx, cz: target.cz, ls: Math.log(target.scale), v: [0, 0, 0] as [number, number, number], back: true };
      for (let i = 0; i < 3; i++) v = glideStep(v, gl, 1 / 60, WORLD_RADIUS).view;
      // A finger lands 50 ms in: the map stops where it is, still past the limit.
      expect(v.scale).toBeGreaterThan(MAX_SCALE + 1);
      // When it lifts (a tap, or after a pan that kept the zoom), it springs back from there.
      for (const caught of [v, { ...v, cx: v.cx + 3, cz: v.cz - 2 }]) {
        const back = backInside(caught, 200, 600)!;
        expect(back).toEqual(clampView(back));
        const g = { cx: back.cx, cz: back.cz, ls: Math.log(back.scale), v: [0, 0, 0] as [number, number, number], back: true };
        let u = caught;
        let done = false;
        for (let i = 0; i < 60 && !done; i++) ({ view: u, done } = glideStep(u, g, 1 / 60, WORLD_RADIUS));
        expect(done).toBe(true);
        expect(u.scale).toBeCloseTo(MAX_SCALE, 9);
      }
      // The same at the farthest zoom and at the world's edge; inside every limit there is nothing to do.
      const far = backInside({ cx: 0, cz: 0, scale: minScale(w, h) * 0.7, w, h }, 195, 400)!;
      expect(far.scale).toBe(minScale(w, h));
      const edge = backInside({ cx: WORLD_RADIUS + 60, cz: 0, scale: 0.5, w, h }, 195, 400)!;
      expect(Math.hypot(edge.cx, edge.cz)).toBeCloseTo(WORLD_RADIUS, 6);
      expect(backInside({ cx: WORLD_RADIUS - 1, cz: 0, scale: 0.5, w, h }, 195, 400)).toBeNull();
    });

    it("lets a fling at an angle into the edge run on along it without sliding back", () => {
      // 1500 px/s along the edge and 1500 px/s out, just past the east edge.
      let v = { cx: R + 1, cz: 0, scale };
      const gl = bounceGlide(v, 1500 / scale, 1500 / scale, R);
      let prev = v.cz;
      let peak = 0;
      for (let i = 0; i < 60; i++) {
        const s = glideStep(v, gl, 1 / 60, R);
        v = s.view;
        expect(v.cz).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v.cz;
        peak = Math.max(peak, past(v));
        if (s.done) break;
      }
      expect(peak).toBeGreaterThan(10);
      expect(Math.hypot(v.cx, v.cz)).toBeCloseTo(R, 3);
    });

    it("springs a zoom back from past its limit in about the same time", () => {
      let v = { cx: 0, cz: 0, scale: 30.8 };
      const gl = { cx: 0, cz: 0, ls: Math.log(24), v: [0, 0, 0] as [number, number, number], back: true };
      let t = 0;
      for (; t < 120; t++) {
        const s = glideStep(v, gl, 1 / 60, R);
        v = s.view;
        if (s.done) break;
      }
      expect(v.scale).toBeCloseTo(24, 9);
      expect(t / 60).toBeGreaterThan(0.25);
      expect(t / 60).toBeLessThan(0.5);
    });
  });

  it("knows where a fling lands the moment it starts", () => {
    for (const [vx, vy] of [
      [2000, 0],
      [-900, 1200],
      [40, -30],
    ] as const) {
      let x = 0;
      let y = 0;
      let wx: number = vx;
      let wy: number = vy;
      for (let i = 0; i < 2000 && Math.hypot(wx, wy) >= REST_SPEED; i++) {
        const sx = inertiaStep(wx, 8);
        const sy = inertiaStep(wy, 8);
        x += sx.d;
        y += sy.d;
        wx = sx.v;
        wy = sy.v;
      }
      const [px, py] = flingOffset(vx, vy);
      // Within the last step's travel, at any frame rate.
      expect(Math.abs(px - x)).toBeLessThan(0.5);
      expect(Math.abs(py - y)).toBeLessThan(0.5);
    }
    expect(flingOffset(5, 5)).toEqual([0, 0]);
    let v = 3;
    let d = 0;
    while (Math.abs(v) >= ZOOM_REST) {
      const s = inertiaStep(v, 16, ZOOM_DECELERATION);
      d += s.d;
      v = s.v;
    }
    expect(zoomFlingOffset(3)).toBeCloseTo(d, 2);
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

describe("base cache size", () => {
  it("keeps phones at 2x and big screens within Safari's canvas limit", async () => {
    const { baseDpr, BASE_PIXELS } = await import("./maprender");
    // A phone's view with the margin, at 3x: drawn at 2x.
    expect(baseDpr(585, 1266, 3)).toBe(2);
    expect(baseDpr(585, 1266, 1)).toBe(1);
    // A 2560 x 1440 retina window with the margin would be 33 million pixels.
    const k = baseDpr(3840, 2160, 2);
    expect(k).toBeLessThan(2);
    expect(Math.round(3840 * k) * Math.round(2160 * k)).toBeLessThanOrEqual(BASE_PIXELS + 4000);
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
