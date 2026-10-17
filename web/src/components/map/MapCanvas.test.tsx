import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateMap } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { I18nProvider } from "../../i18n";
import { DEFAULT_LAYERS, MAX_SCALE, WORLD_RADIUS } from "../../lib/mapgeo";
import { MapCanvas, type MapCanvasHandle } from "./MapCanvas";

const map = gateMap(mockMap({ now: Date.parse("2026-10-10T20:00:00Z") }), false);
const W = 390;
const H = 844;

// jsdom has no layout: give every box a phone's size, and pointers somewhere to be captured.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(W);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(H);
  HTMLElement.prototype.setPointerCapture = () => {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount() {
  const ref = createRef<MapCanvasHandle>();
  const ui = () => (
    <I18nProvider locale="en">
      <MapCanvas ref={ref} map={map} mask={null} markers={[]} layers={DEFAULT_LAYERS} selected={null} onSelect={() => {}} />
    </I18nProvider>
  );
  const view = render(ui());
  /** A re-render with new callbacks: the gesture handlers are set up again. */
  const rerender = () => view.rerender(ui());
  const el = view.getByRole("img");
  let t = 0;
  const fire = (type: string, id: number, x: number, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { pointerId: id, pointerType: "touch", button: 0, clientX: x, clientY: y });
    Object.defineProperty(e, "timeStamp", { value: t });
    act(() => {
      el.dispatchEvent(e);
    });
  };
  /** Frames of 16 ms. */
  const run = (ms: number) => {
    for (let i = 0; i < ms / 16; i++) {
      t += 16;
      act(() => {
        vi.advanceTimersByTime(16);
      });
    }
  };
  const scale = () => ref.current!.project(1, 0)[0] - ref.current!.project(0, 0)[0];
  const pastEdge = () => {
    const [x0, y0] = ref.current!.project(0, 0);
    // Screen distance of the world's centre from the view's, against the world's radius on screen.
    return Math.hypot(x0 - W / 2, y0 - H / 2) - WORLD_RADIUS * scale();
  };
  return { ref, fire, run, scale, pastEdge, view, rerender };
}

describe("MapCanvas spring back", () => {
  it("still springs back to the closest zoom when a tap stops it (#124)", () => {
    const m = mount();
    m.ref.current!.zoomBy(10_000);
    m.run(1500);
    expect(m.scale()).toBeCloseTo(MAX_SCALE, 6);
    // Pinch apart, past the closest zoom, and let go.
    m.fire("pointerdown", 1, 195, 400);
    m.fire("pointerdown", 2, 195, 460);
    for (let i = 1; i <= 10; i++) {
      m.fire("pointermove", 1, 195, 400 - i * 12);
      m.fire("pointermove", 2, 195, 460 + i * 12);
      m.run(16);
    }
    expect(m.scale()).toBeGreaterThan(MAX_SCALE * 1.15);
    m.fire("pointerup", 1, 195, 280);
    m.fire("pointerup", 2, 195, 580);
    m.run(48);
    // A tap while it springs back stops it where it is, past the limit...
    m.fire("pointerdown", 3, 200, 650);
    m.run(32);
    expect(m.scale()).toBeGreaterThan(MAX_SCALE * 1.02);
    // ...and once it lifts the spring back carries on to the limit.
    m.fire("pointerup", 3, 200, 650);
    m.run(1000);
    expect(m.scale()).toBeCloseTo(MAX_SCALE, 6);
    m.view.unmount();
  });

  it("springs back into the world when a tap stops it past the edge", () => {
    const m = mount();
    m.ref.current!.flyTo(WORLD_RADIUS, 0, 0.5, 0.5);
    m.run(1500);
    expect(Math.abs(m.pastEdge())).toBeLessThan(0.5);
    // Pan 300 px on past the east edge, hold still, let go.
    m.fire("pointerdown", 1, 330, 500);
    for (let i = 1; i <= 30; i++) {
      m.fire("pointermove", 1, 330 - i * 10, 500);
      m.run(16);
    }
    m.run(160);
    const held = m.pastEdge();
    expect(held).toBeGreaterThan(40);
    m.fire("pointerup", 1, 30, 500);
    m.run(48);
    // Springing back, not snapped back (#125).
    expect(m.pastEdge()).toBeGreaterThan(held * 0.6);
    m.fire("pointerdown", 2, 200, 650);
    m.run(32);
    expect(m.pastEdge()).toBeGreaterThan(5);
    m.fire("pointerup", 2, 200, 650);
    m.run(1000);
    expect(m.pastEdge()).toBeLessThan(0.5);
    m.view.unmount();
  });

  it("springs back when the map is re-rendered under a finger holding it past the edge", () => {
    const m = mount();
    m.ref.current!.flyTo(WORLD_RADIUS, 0, 0.5, 0.5);
    m.run(1500);
    m.fire("pointerdown", 1, 330, 500);
    for (let i = 1; i <= 30; i++) {
      m.fire("pointermove", 1, 330 - i * 10, 500);
      m.run(16);
    }
    expect(m.pastEdge()).toBeGreaterThan(40);
    // The handlers are replaced mid-gesture: the new ones never see this finger lift.
    act(() => m.rerender());
    m.fire("pointerup", 1, 30, 500);
    m.run(1000);
    expect(m.pastEdge()).toBeLessThan(0.5);
    m.view.unmount();
  });
});
