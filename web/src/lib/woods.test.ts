import { afterEach, describe, expect, it, vi } from "vitest";
import { natureTint, treeStyle } from "./nature";
import { NatureLayer, paintWoods, type WoodGroup } from "./naturerender";
import { packNature, unpackNature, type NatureItem } from "./nature";

/** A 2D context that only writes down what is drawn, with the line width and colour at the time. */
function recorder() {
  const ops: string[] = [];
  const ctx = {
    fillStyle: "" as string | CanvasGradient | CanvasPattern,
    strokeStyle: "" as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: "source-over" as GlobalCompositeOperation,
    fill(p: unknown) {
      ops.push(`fill ${String(p)} ${String(this.fillStyle)}`);
    },
    stroke(p: unknown) {
      ops.push(`stroke ${String(p)} w${this.lineWidth}`);
    },
  };
  return { ctx, ops };
}

const path = (name: string) => name as unknown as Path2D;
const groups: WoodGroup[] = [
  { tint: "#7c9440", paths: [path("a1"), path("a2"), path("a3")] },
  { tint: "#5c5a3b", paths: [path("b1"), path("b2")] },
];

describe("paintWoods", () => {
  it("strokes every crown of a group before filling any, so overlapping crowns keep only the wood's outer edge", () => {
    const { ctx, ops } = recorder();
    const places: boolean[] = [];
    paintWoods(ctx as never, groups, { width: 0.25, alpha: 0.6 }, (shadow) => {
      places.push(shadow);
      ops.push(shadow ? "shadow" : "plain");
    });
    expect(places).toEqual([true, false, true, false]);
    // Per group: shadow fills, then all strokes at twice the rim, then all fills in the tint.
    // The shadow in a darker ink of the tint, whatever its exact value.
    expect(ops.map((o) => o.replace(/rgb\(\d+, \d+, \d+\)/, "ink"))).toEqual([
      "shadow",
      "fill a1 ink",
      "fill a2 ink",
      "fill a3 ink",
      "plain",
      "stroke a1 w0.5",
      "stroke a2 w0.5",
      "stroke a3 w0.5",
      "fill a1 #7c9440",
      "fill a2 #7c9440",
      "fill a3 #7c9440",
      "shadow",
      "fill b1 ink",
      "fill b2 ink",
      "plain",
      "stroke b1 w0.5",
      "stroke b2 w0.5",
      "fill b1 #5c5a3b",
      "fill b2 #5c5a3b",
    ]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("as a canopy, lays a soft shadow in three steps, darkens the crowns and lights one dome per real tree over what is drawn", () => {
    const { ctx, ops } = recorder();
    const domes: string[] = [];
    const lit: WoodGroup[] = [{ tint: "#7c9440", paths: [path("a1")], domes: [Float32Array.of(10, 20, 3, 12, 22, 2)] }];
    const shadows: number[] = [];
    paintWoods(
      ctx as never,
      lit,
      null,
      (shadow, k = 1) => {
        if (shadow) shadows.push(k);
      },
      {
        amount: 1,
        dome: (x, z, r) => domes.push(`${x},${z},${r} ${ctx.globalCompositeOperation} ${ctx.globalAlpha}`),
      },
    );
    // Three shadow steps, a third as strong each, out to the full distance.
    expect(shadows).toEqual([1 / 3, 2 / 3, 1]);
    // Three shadow fills, then the crown.
    expect(ops.filter((o) => o.startsWith("fill a1 rgb"))).toHaveLength(4);
    // The crown darker than the wash's tint, and one dome per real tree, painted only over what is drawn.
    const crown = ops.at(-1)!;
    expect(crown).toMatch(/^fill a1 rgb\(/);
    expect(crown).not.toContain("#7c9440");
    expect(domes).toEqual(["10,20,3 source-atop 1", "12,22,2 source-atop 1"]);
    expect(ctx.globalCompositeOperation).toBe("source-over");
    expect(ctx.globalAlpha).toBe(1);
  });

  it("paints no domes without a canopy", () => {
    const { ctx, ops } = recorder();
    paintWoods(ctx as never, [{ ...groups[0]!, domes: [Float32Array.of(1, 2, 3)] }], null, () => {});
    expect(ops.at(-1)).toBe("fill a3 #7c9440");
  });

  it("draws no outline at all from mid zoom out", () => {
    const { ctx, ops } = recorder();
    paintWoods(ctx as never, groups, null, () => {});
    expect(ops.some((o) => o.startsWith("stroke"))).toBe(false);
    expect(ops.filter((o) => o.startsWith("fill"))).toHaveLength(10);
  });
});

describe("tree styles", () => {
  const luma = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  };

  it("draws the swamp's trees dark, sparse and gnarled, not as meadow blobs", () => {
    const swamp = treeStyle("swamp");
    const beech = treeStyle("beech");
    expect(swamp.crown).toBeLessThan(0.8);
    expect(swamp.lobes).toBeLessThan(beech.lobes);
    expect(swamp.rough).toBeGreaterThan(beech.rough * 2);
    expect(luma(natureTint("tree", "swamp"))).toBeLessThan(luma(natureTint("tree", "beech")) - 25);
  });

  it("tells conifers, birch and oak apart, and gives every species the agent sends a style", () => {
    for (const s of ["pine", "fir", "snowpine", "snowfir"]) expect(treeStyle(s).spiky).toBe(true);
    for (const s of ["beech", "oak", "birch", "swamp", "yggashoot"]) expect(treeStyle(s).spiky).toBe(false);
    expect(treeStyle("birch").crown).toBeLessThan(treeStyle("beech").crown);
    expect(treeStyle("oak").lobes).toBeGreaterThan(treeStyle("beech").lobes);
    // Unknown species: an ordinary broadleaf.
    expect(treeStyle("palm")).toEqual(treeStyle("beech"));
    for (const s of ["beech", "oak", "birch", "pine", "fir", "swamp", "yggashoot", "ashwood", "snowpine", "snowfir"]) {
      const st = treeStyle(s);
      expect(st.lobes).toBeGreaterThanOrEqual(5);
      expect(st.crown).toBeGreaterThan(0.6);
      expect(st.crown).toBeLessThanOrEqual(1.05);
    }
  });
});

describe("NatureLayer.genFor", () => {
  const tree = (x: number, z: number): NatureItem => ({ category: "tree", species: "beech", x, z, yaw: 30, size: 8 });
  // A nature chunk is 256 m: "0,0" covers 0..256, "4,4" covers 1024..1280.
  const here: [number, number, number, number] = [100, 100, 150, 150];
  const there: [number, number, number, number] = [1100, 1100, 1150, 1150];

  it("changes only where a chunk arrives, changes or leaves", () => {
    const n = new NatureLayer();
    const a = [tree(120, 120)];
    const b = [tree(1120, 1120)];
    n.set(new Map([["0,0", a]]));
    const g0 = [n.genFor(here), n.genFor(there)];
    n.set(new Map([["0,0", a], ["4,4", b]]));
    expect(n.genFor(here)).toBe(g0[0]);
    expect(n.genFor(there)).not.toBe(g0[1]);
    const g1 = n.genFor(there);
    // The same items again: nothing to redraw anywhere.
    n.set(new Map([["0,0", a], ["4,4", b]]));
    expect([n.genFor(here), n.genFor(there)]).toEqual([g0[0], g1]);
    // A chunk leaving redraws the ground it covered.
    n.set(new Map([["4,4", b]]));
    expect(n.genFor(here)).not.toBe(g0[0]);
    expect(n.genFor(there)).toBe(g1);
  });

  it("reaches as far as a chunk's marks spill over its edge", () => {
    const n = new NatureLayer();
    const before = n.genFor([257, 100, 300, 150]);
    n.set(new Map([["0,0", [tree(250, 120)]]]));
    expect(n.genFor([257, 100, 300, 150])).not.toBe(before);
    expect(n.genFor([400, 100, 450, 150])).toBe(before);
  });
});

describe("packNature", () => {
  it("round-trips a chunk's items", () => {
    const items: NatureItem[] = [
      { category: "tree", species: "beech", x: 1.5, z: -2.25, yaw: 30, size: 8 },
      { category: "pickable", species: "raspberry", x: 10, z: 20, yaw: 0, size: 0.5 },
      { category: "tree", species: "beech", x: -3, z: 4, yaw: 359, size: 4 },
    ];
    const p = packNature(items);
    expect(p.species).toEqual(["beech", "raspberry"]);
    expect(unpackNature(p)).toEqual(items);
  });
});

describe("NatureLayer, a chunk left out of a draw", () => {
  afterEach(() => vi.restoreAllMocks());
  it("stamps its ground when a later draw builds it, so what was drawn without it is redrawn", () => {
    // Path2D stands in: only the bookkeeping is under test.
    vi.stubGlobal("Path2D", class { moveTo() {} lineTo() {} quadraticCurveTo() {} arc() {} });
    const n = new NatureLayer(5);
    n.set(new Map([["0,0", [{ category: "tree", species: "beech", x: 100, z: 100, yaw: 0, size: 8 } as NatureItem]]]));
    const box: [number, number, number, number] = [90, 90, 110, 110];
    const visible = (n as unknown as { visible(b: typeof box): unknown[] }).visible.bind(n);
    // Over budget at once: the chunk is left out.
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (t += 100));
    expect(visible(box)).toHaveLength(0);
    const before = n.genFor(box);
    vi.restoreAllMocks();
    // The next draw has time and builds it itself, before the deferred build runs.
    expect(visible(box)).toHaveLength(1);
    expect(n.genFor(box)).not.toBe(before);
    vi.unstubAllGlobals();
  });
});

describe("nature's zoom tiers", () => {
  it("bring the canopy in with the terrain's detail, in steps, without moving the hard switches", async () => {
    const { tierZoom } = await import("./gltiles");
    const { NATURE_BANDS } = await import("./naturerender");
    const { detailAt } = await import("./terraindetail");
    const { PICKABLE_SCALE, TREE_DETAIL_SCALE } = await import("./nature");
    const at = (z: number) => tierZoom(z, NATURE_BANDS);
    // Tree detail and pickables switch exactly where they did.
    expect(at(TREE_DETAIL_SCALE - 0.01)).toBeLessThan(TREE_DETAIL_SCALE);
    expect(at(TREE_DETAIL_SCALE)).toBeGreaterThanOrEqual(TREE_DETAIL_SCALE);
    expect(at(PICKABLE_SCALE - 0.01)).toBeLessThan(PICKABLE_SCALE);
    expect(at(PICKABLE_SCALE)).toBeGreaterThanOrEqual(PICKABLE_SCALE);
    // The canopy: none at mid zoom, in quarter-octave steps between, full close up.
    expect(detailAt(at(2.5))).toBe(0);
    const steps = new Set([3.2, 4.5, 6, 8.5, 11].map((z) => detailAt(at(z))));
    expect(steps.size).toBe(5);
    expect(detailAt(at(13))).toBe(1);
    expect(detailAt(at(24))).toBe(1);
  });
});
