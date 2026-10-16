import { describe, expect, it } from "vitest";
import { PLAN_FULL_SCALE, PLAN_MIN_SCALE, planAlpha, ROOF_FULL_SCALE, ROOF_GONE_SCALE, roofAlpha } from "./planrender";

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
