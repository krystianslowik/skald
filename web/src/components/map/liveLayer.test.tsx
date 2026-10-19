import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { en } from "../../i18n/en";
import { setLivePositions } from "../../lib/live";
import { LiveLayer } from "./LiveLayer";
import type { MapCanvasHandle } from "./MapCanvas";

/** A canvas at one metre per pixel, origin at (500, 500). */
const canvas = { current: { project: (x: number, z: number) => [500 + x, 500 - z] } as unknown as MapCanvasHandle };

const player = (name: string, x: number, z: number) => ({ name, platform: "steam" as const, x, z, health: 80, maxHealth: 100 });

/** The plate's vertical offset from its place under the dot (px). */
const shift = (name: string) => {
  const plate = screen.getAllByRole("button").find((b) => b.tabIndex === -1 && b.textContent?.includes(name))!;
  return Number(/translateY\((-?\d+)px\)/.exec(plate.style.transform)?.[1] ?? 0);
};

let frames: FrameRequestCallback[] = [];
const nextFrame = () => act(() => frames.splice(0).forEach((cb) => cb(16)));

describe("players on the map", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(90);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(18);
    // A new player snaps to its first sample, so one frame places everyone.
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });
  afterEach(() => {
    act(() => setLivePositions({ t: 0, players: [] }));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const show = (players: ReturnType<typeof player>[]) => {
    const ref = createRef<{ place(): void }>();
    render(
      <I18nProvider locale="en">
        <LiveLayer ref={ref} canvas={canvas} />
      </I18nProvider>,
    );
    act(() => setLivePositions({ t: 1, players }));
    nextFrame();
    return ref;
  };

  it("stacks the name plates of players standing together, so each one can be read", () => {
    show([player("Ragnar", 10, 10), player("Freya", 11, 10), player("Bjorn", 10, 11)]);
    const shifts = ["Ragnar", "Freya", "Bjorn"].map(shift).sort((a, b) => a - b);
    // One under the other: at least a plate's height apart.
    expect(shifts[1]! - shifts[0]!).toBeGreaterThanOrEqual(18);
    expect(shifts[2]! - shifts[1]!).toBeGreaterThanOrEqual(18);
  });

  it("leaves the plates of players apart under their own dots", () => {
    show([player("Ragnar", -200, 0), player("Astrid", 200, 0)]);
    expect(screen.getByRole("button", { name: en["map.live.player"].replace("{name}", "Astrid") }).parentElement!.style.transform).toBe("translate3d(700px, 500px, 0)");
    expect(shift("Ragnar")).toBe(0);
    expect(shift("Astrid")).toBe(0);
  });
});
