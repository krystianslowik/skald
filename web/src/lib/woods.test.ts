import { describe, expect, it } from "vitest";
import { natureTint, treeStyle } from "./nature";
import { paintWoods, type WoodGroup } from "./naturerender";

/** A 2D context that only writes down what is drawn, with the line width and colour at the time. */
function recorder() {
  const ops: string[] = [];
  const ctx = {
    fillStyle: "" as string | CanvasGradient | CanvasPattern,
    strokeStyle: "" as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    globalAlpha: 1,
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
