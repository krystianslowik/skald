import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateMap } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { mockNature, natureIn } from "@server/mocknature";
import { mockPieces, piecesIn } from "@server/mockpieces";
import { I18nProvider } from "../../i18n";
import { DEFAULT_LAYERS, MAX_SCALE, WORLD_RADIUS } from "../../lib/mapgeo";
import { MapRenderer } from "../../lib/maprender";
import { NATURE_MIN_SCALE } from "../../lib/nature";
import type { ApiMap } from "../../types";
import { MapCanvas, type MapCanvasHandle } from "./MapCanvas";

const map = gateMap(mockMap({ now: Date.parse("2026-10-10T20:00:00Z") }), false);
const W = 390;
const H = 844;

const pieces = mockPieces(mockMap().storage!);
const nature = mockNature();
const boxOf = (url: string) => ["x0", "z0", "x1", "z1"].map((k) => Number(new URL(url, "http://x").searchParams.get(k))) as [number, number, number, number];
/** The agent's floor plans and nature, answered at once. */
function agent() {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    return Response.json(u.startsWith("/api/pieces") ? piecesIn(pieces, boxOf(u), 1, 20_000) : natureIn(nature, boxOf(u), 1, false, 30_000));
  });
}

// jsdom has no layout: give every box a phone's size, and pointers somewhere to be captured.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(W);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(H);
  HTMLElement.prototype.setPointerCapture = () => {};
  vi.stubGlobal("fetch", agent());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(world: ApiMap = map) {
  const ref = createRef<MapCanvasHandle>();
  const ui = () => (
    <I18nProvider locale="en">
      <MapCanvas ref={ref} map={world} mask={null} markers={[]} layers={DEFAULT_LAYERS} selected={null} onSelect={() => {}} />
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
  /** Frames, with the requests they started answered in between. */
  const settle = async (ms: number) => {
    for (let i = 0; i < ms / 16; i++) {
      t += 16;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });
    }
  };
  return { ref, fire, run, settle, scale, pastEdge, view, rerender };
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

describe("MapCanvas floor plans and nature (#160)", () => {
  const asked = (f: ReturnType<typeof agent>, path: string) => f.mock.calls.filter(([u]) => String(u).startsWith(path)).length;

  it("asks as the fingers lift, for where the view lands, while the terrain is still fading in", async () => {
    // The terrain never stops fading in: every frame asks for the next.
    vi.spyOn(MapRenderer.prototype, "draw").mockReturnValue(true);
    const f = agent();
    vi.stubGlobal("fetch", f);
    // A save of its own: the loaders outlive a map, and earlier tests may have filled them for the shared one.
    const m = mount({ ...map, meta: { ...map.meta, generation: map.meta.generation + 500 } });
    m.ref.current!.flyTo(220, -340, NATURE_MIN_SCALE * 0.9, NATURE_MIN_SCALE * 0.9);
    m.run(1500);
    expect(f).not.toHaveBeenCalled();
    // Pinch to twice the zoom: nothing is asked while the fingers are down...
    m.fire("pointerdown", 1, 195, 400);
    m.fire("pointerdown", 2, 195, 460);
    for (let i = 1; i <= 10; i++) {
      m.fire("pointermove", 1, 195, 400 - i * 3);
      m.fire("pointermove", 2, 195, 460 + i * 3);
      m.run(16);
    }
    m.run(200);
    expect(m.scale()).toBeGreaterThan(1.2);
    expect(f).not.toHaveBeenCalled();
    // ...and both layers are, a frame after they lift.
    m.fire("pointerup", 1, 195, 370);
    m.fire("pointerup", 2, 195, 490);
    await m.settle(32);
    expect(asked(f, "/api/pieces")).toBeGreaterThan(0);
    expect(asked(f, "/api/nature")).toBeGreaterThan(0);
    m.view.unmount();
  });

  it("keeps what loaded when the map is opened again", async () => {
    const f = agent();
    vi.stubGlobal("fetch", f);
    const world = { ...map, meta: { ...map.meta, generation: map.meta.generation + 1000 } };
    const first = mount(world);
    first.ref.current!.flyTo(220, -340, 3, 3);
    await first.settle(1500);
    const calls = f.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    first.view.unmount();
    const setNature = vi.spyOn(MapRenderer.prototype, "setNature");
    const setPieces = vi.spyOn(MapRenderer.prototype, "setPieces");
    const again = mount(world);
    await again.settle(160);
    expect(setNature.mock.calls.some(([loaded]) => loaded.size > 0)).toBe(true);
    expect(setPieces.mock.calls.some(([p]) => p.length > 0)).toBe(true);
    again.ref.current!.flyTo(220, -340, 3, 3);
    await again.settle(1500);
    expect(f.mock.calls.length).toBe(calls);
    again.view.unmount();
  });
});

describe("MapCanvas page marks and long presses", () => {
  function mountWith(props: { onLongPress?: (p: { x: number; z: number }) => void; pickOverlay?: (x: number, y: number, touch: boolean) => (() => void) | null; onSelect?: () => void }) {
    const ref = createRef<MapCanvasHandle>();
    const view = render(
      <I18nProvider locale="en">
        <MapCanvas ref={ref} map={map} mask={null} markers={[]} layers={DEFAULT_LAYERS} selected={null} onSelect={props.onSelect ?? (() => {})} onLongPress={props.onLongPress} pickOverlay={props.pickOverlay} />
      </I18nProvider>,
    );
    const el = view.getByRole("img");
    let t = 0;
    const fire = (type: string, x: number, y: number, o: { id?: number; pointerType?: string; button?: number } = {}) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(e, { pointerId: o.id ?? 1, pointerType: o.pointerType ?? "touch", button: o.button ?? 0, clientX: x, clientY: y });
      Object.defineProperty(e, "timeStamp", { value: t });
      act(() => {
        el.dispatchEvent(e);
      });
      return e;
    };
    const wait = (ms: number) => {
      t += ms;
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    };
    return { ref, fire, wait };
  }

  it("gives a tap on a page mark to the mark, and a drag from it to the map", () => {
    const open = vi.fn();
    const onSelect = vi.fn();
    const m = mountWith({ onSelect, pickOverlay: (x, y) => (Math.hypot(x - 200, y - 300) < 20 ? open : null) });
    m.fire("pointerdown", 200, 300);
    m.fire("pointerup", 200, 300);
    expect(open).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    // A drag that starts on the mark pans the map and opens nothing.
    m.wait(400);
    const before = m.ref.current!.project(0, 0);
    m.fire("pointerdown", 200, 300);
    m.fire("pointermove", 260, 340);
    m.fire("pointerup", 260, 340);
    expect(open).toHaveBeenCalledTimes(1);
    expect(m.ref.current!.project(0, 0)).not.toEqual(before);
  });

  it("answers a finger's long press once, even with a little wander and the contextmenu after it", () => {
    const onLongPress = vi.fn();
    const m = mountWith({ onLongPress });
    m.fire("pointerdown", 100, 100);
    m.fire("pointermove", 106, 104);
    m.wait(500);
    expect(onLongPress).not.toHaveBeenCalled();
    m.wait(150);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    const menu = m.fire("contextmenu", 106, 104);
    expect((menu as Event).defaultPrevented).toBe(true);
    m.fire("pointerup", 106, 104);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    // Wandering too far is a pan, not a press.
    m.fire("pointerdown", 100, 100);
    m.fire("pointermove", 130, 100);
    m.wait(700);
    m.fire("pointerup", 130, 100);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("takes a right click as a long press, or as opening the page mark under it", () => {
    const onLongPress = vi.fn();
    const open = vi.fn();
    const m = mountWith({ onLongPress, pickOverlay: (x, y) => (Math.hypot(x - 200, y - 300) < 20 ? open : null) });
    m.fire("pointerdown", 50, 50, { pointerType: "mouse", button: 2 });
    expect(m.fire("contextmenu", 50, 50).defaultPrevented).toBe(true);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    m.fire("pointerdown", 200, 300, { pointerType: "mouse", button: 2 });
    expect(m.fire("contextmenu", 200, 300).defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
