import { afterEach, describe, expect, it, vi } from "vitest";
import type { Piece } from "./pieces";
import { FloorPlan, PLAN_FULL_SCALE, PLAN_MIN_SCALE, planAlpha, ROOF_FULL_SCALE, ROOF_GONE_SCALE, roofAlpha } from "./planrender";

describe("floor plan fading", () => {
  it("brings plans in between the minimum and the full scale", () => {
    expect(planAlpha(PLAN_MIN_SCALE - 0.1)).toBe(0);
    expect(planAlpha(PLAN_FULL_SCALE)).toBe(1);
    expect(planAlpha(20)).toBe(1);
  });

  it("lays roofs over the plans when zoomed out and lifts them as you zoom in", () => {
    expect(roofAlpha(PLAN_MIN_SCALE)).toBe(1);
    expect(roofAlpha(ROOF_FULL_SCALE)).toBe(1);
    expect(roofAlpha(ROOF_GONE_SCALE)).toBe(0);
    // A tap on a base flies to scale 8: a clean floor plan there.
    expect(roofAlpha(8)).toBe(0);
    let last = 1;
    for (let s = ROOF_FULL_SCALE; s <= ROOF_GONE_SCALE; s += 0.25) {
      const a = roofAlpha(s);
      expect(a).toBeLessThanOrEqual(last);
      last = a;
    }
    // The roofs never fully cover a plan that is itself fading in.
    expect(ROOF_FULL_SCALE).toBeGreaterThan(PLAN_FULL_SCALE);
  });
});

describe("FloorPlan.changes", () => {
  afterEach(() => vi.unstubAllGlobals());
  const floor = (x: number, z: number): Piece => ({ name: "wood_floor", kind: "floor", x, z, y: 30, yaw: 0, w: 2, d: 2, slope: 0, known: true, tilted: false });
  const hut = (x0: number) => [floor(x0, 0), floor(x0 + 2, 0), floor(x0, 2), floor(x0 + 2, 2)];

  it("names only the bases whose pieces changed", () => {
    vi.stubGlobal("Path2D", class {});
    const a = hut(0);
    const b = hut(500);
    const one = new FloorPlan([...a, ...b]);
    // The same pieces in a new plan (another chunk arrived elsewhere): nothing changed.
    expect(FloorPlan.changes(one, new FloorPlan([...a, ...b]))).toEqual([]);
    // One base grew: its old and new boxes, not the other base's.
    const grown = new FloorPlan([...a, floor(4, 0), ...b]);
    const boxes = FloorPlan.changes(one, grown);
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box[2]).toBeLessThan(100);
    // A base gone, or the first plan: its box.
    expect(FloorPlan.changes(one, new FloorPlan(a)).every((box) => box[0] > 400)).toBe(true);
    expect(FloorPlan.changes(null, one)).toHaveLength(2);
  });
});
