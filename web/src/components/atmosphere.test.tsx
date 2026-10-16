import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Embers } from "./Atmosphere";

// A canvas that counts frames (one clearRect per drawn frame) and a hand-cranked requestAnimationFrame.
let clears = 0;
let pending: FrameRequestCallback[] = [];
let clock = 0;
const realGetContext = HTMLCanvasElement.prototype.getContext;

/** Runs `n` display refreshes `ms` apart. */
function refresh(n: number, ms: number) {
  for (let i = 0; i < n; i++) {
    clock += ms;
    const run = pending;
    pending = [];
    for (const cb of run) cb(clock);
  }
}

beforeEach(() => {
  clears = 0;
  pending = [];
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => pending.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {
    pending = [];
  });
  const fake = new Proxy({}, { get: (_t, k) => (k === "clearRect" ? () => (clears += 1) : k === "createRadialGradient" ? () => ({ addColorStop() {} }) : () => undefined), set: () => true });
  HTMLCanvasElement.prototype.getContext = (() => fake) as unknown as HTMLCanvasElement["getContext"];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

describe("Embers", () => {
  it("draws at 30 fps on a 60 Hz and a 120 Hz screen", () => {
    render(<Embers />);
    refresh(60, 1000 / 60);
    expect(clears).toBe(30);
    clears = 0;
    refresh(120, 1000 / 120);
    expect(clears).toBe(30);
  });

  it("does not animate while paused, and starts again when unpaused", () => {
    const { rerender } = render(<Embers paused />);
    refresh(60, 1000 / 60);
    expect(pending).toHaveLength(0);
    expect(clears).toBe(0);
    rerender(<Embers paused={false} />);
    refresh(60, 1000 / 60);
    expect(clears).toBe(30);
    rerender(<Embers paused />);
    expect(pending).toHaveLength(0);
  });
});
