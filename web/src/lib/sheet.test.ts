import { describe, expect, it } from "vitest";
import { dragOffset, FLICK_VELOCITY, pickDetent, project, rubberband, shouldDismiss, travelFor, velocityFrom } from "./sheet";

describe("sheet drag math", () => {
  it("projects momentum with exponential decay (d = 0.998)", () => {
    expect(project(0)).toBe(0);
    // 1000 px/s * 0.998 / 0.002 = 499 px
    expect(project(1000)).toBeCloseTo(499, 6);
    expect(project(-1000)).toBeCloseTo(-499, 6);
    // a snappier rate travels much less
    expect(project(1000, 0.99)).toBeCloseTo(99, 6);
  });

  it("rubber-bands progressively and never exceeds the asymptote", () => {
    expect(rubberband(0, 400)).toBe(0);
    const small = rubberband(10, 400);
    const big = rubberband(1000, 400);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(10);
    expect(big).toBeLessThan(400);
    // follows less per pixel the further past the edge
    expect(rubberband(200, 400) - rubberband(100, 400)).toBeLessThan(rubberband(100, 400));
    expect(rubberband(-50, 400)).toBeCloseTo(-rubberband(50, 400), 9);
    expect(rubberband(50, 0)).toBe(0);
  });

  it("tracks 1:1 toward dismiss and resists past the open edge", () => {
    expect(dragOffset(0, 400)).toBe(0);
    expect(dragOffset(120, 400)).toBe(120);
    const past = dragOffset(-120, 400);
    expect(past).toBeLessThan(0);
    expect(past).toBeGreaterThan(-120);
    expect(past).toBeCloseTo(-rubberband(120, 400), 9);
  });

  it("maps a grabbed offset back to pointer travel, so a re-grab does not jump", () => {
    for (const travel of [0, 35, 260, -15, -140]) expect(dragOffset(travelFor(dragOffset(travel, 400), 400), 400)).toBeCloseTo(dragOffset(travel, 400), 6);
    expect(travelFor(-rubberband(80, 400), 400)).toBeCloseTo(-80, 6);
  });

  it("measures release velocity over the last 100 ms only", () => {
    expect(velocityFrom([])).toBe(0);
    expect(velocityFrom([{ p: 5, t: 0 }])).toBe(0);
    // an old slow segment is ignored, the recent fast one counts: 60 px in 50 ms = 1200 px/s
    const v = velocityFrom([
      { p: 0, t: 0 },
      { p: 2, t: 150 },
      { p: 10, t: 250 },
      { p: 40, t: 275 },
      { p: 70, t: 300 },
    ]);
    expect(v).toBeCloseTo(1200, 6);
    expect(velocityFrom([{ p: 100, t: 0 }, { p: 80, t: 40 }])).toBeCloseTo(-500, 6);
  });

  it("commits or reverses by the sign of a flick, regardless of position", () => {
    const size = 400;
    // barely dragged, flicked toward dismiss: closes
    expect(shouldDismiss(10, FLICK_VELOCITY + 1, size)).toBe(true);
    // dragged almost all the way, flicked back: reopens
    expect(shouldDismiss(380, -(FLICK_VELOCITY + 1), size)).toBe(false);
    // past the open edge with a dismiss flick still closes
    expect(shouldDismiss(-20, 900, size)).toBe(true);
  });

  it("decides a slow release by its projected resting point", () => {
    const size = 400;
    expect(shouldDismiss(150, 0, size)).toBe(false);
    expect(shouldDismiss(250, 0, size)).toBe(true);
    // 150 + project(200) = 150 + 99.8 > 200
    expect(shouldDismiss(150, 200, size)).toBe(true);
    // 250 + project(-200) = 250 - 99.8 < 200
    expect(shouldDismiss(250, -200, size)).toBe(false);
  });

  it("rests a peeking sheet on the nearest detent, or the next one when flicked", () => {
    const detents = [0, 500, 800];
    // Slow releases: wherever the projection lands nearest.
    expect(pickDetent(480, 0, detents)).toBe(500);
    expect(pickDetent(180, 0, detents)).toBe(0);
    expect(pickDetent(700, 0, detents)).toBe(800);
    // A flick up from the peek expands, a flick down from it dismisses, wherever it starts.
    expect(pickDetent(490, -FLICK_VELOCITY, detents)).toBe(0);
    expect(pickDetent(510, FLICK_VELOCITY, detents)).toBe(800);
    // A flick down from fully open lands on the peek first.
    expect(pickDetent(20, FLICK_VELOCITY * 2, detents)).toBe(500);
  });
});
