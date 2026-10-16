import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Embers } from "./Atmosphere";
import { Preferences } from "./Preferences";

// The system's reduced-motion setting, as motion reports it.
let reducedMotion = false;
vi.mock("motion/react", async (importOriginal) => ({ ...(await importOriginal<typeof import("motion/react")>()), useReducedMotion: () => reducedMotion }));

let store = new Map<string, string>();

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
  reducedMotion = false;
  store = new Map();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
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

describe("Embers switch", () => {
  const canvas = () => document.querySelector("canvas");
  const prefs = () => (
    <>
      <Embers />
      <Preferences onLogout={() => {}} />
    </>
  );

  it("is on by default and off by default under reduced motion", () => {
    const view = render(prefs());
    expect(screen.getByRole("switch", { name: "Embers" })).toHaveAttribute("aria-checked", "true");
    expect(canvas()).not.toBeNull();
    view.unmount();
    reducedMotion = true;
    render(prefs());
    expect(screen.getByRole("switch", { name: "Embers" })).toHaveAttribute("aria-checked", "false");
    expect(canvas()).toBeNull();
    expect(pending).toHaveLength(0);
  });

  it("turns them off, stops drawing, and remembers it", () => {
    const view = render(prefs());
    refresh(10, 1000 / 60);
    act(() => screen.getByRole("switch", { name: "Embers" }).click());
    expect(screen.getByRole("switch", { name: "Embers" })).toHaveAttribute("aria-checked", "false");
    expect(canvas()).toBeNull();
    expect(pending).toHaveLength(0);
    expect(store.get("skald_embers")).toBe("0");
    view.unmount();
    render(prefs());
    expect(screen.getByRole("switch", { name: "Embers" })).toHaveAttribute("aria-checked", "false");
    expect(canvas()).toBeNull();
  });

  it("lets an explicit choice win over reduced motion", () => {
    reducedMotion = true;
    store.set("skald_embers", "1");
    render(prefs());
    expect(screen.getByRole("switch", { name: "Embers" })).toHaveAttribute("aria-checked", "true");
    clears = 0;
    refresh(60, 1000 / 60);
    expect(clears).toBe(30);
  });

  it("still switches when the browser blocks storage", () => {
    const refuse = () => {
      throw new Error("storage refused");
    };
    vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse });
    render(prefs());
    const sw = screen.getByRole("switch", { name: "Embers" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    act(() => sw.click());
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(canvas()).toBeNull();
    // Storage that reads but will not write (full): the old stored value must not win.
    store.set("skald_embers", "0");
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: refuse });
    act(() => sw.click());
    expect(sw).toHaveAttribute("aria-checked", "true");
    // Storage back: the choice is written and read from it again.
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    act(() => sw.click());
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(store.get("skald_embers")).toBe("0");
  });

  it("follows a change made in another tab", () => {
    render(prefs());
    expect(canvas()).not.toBeNull();
    store.set("skald_embers", "0");
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key: "skald_embers", newValue: "0" })));
    expect(screen.getByRole("switch", { name: "Embers" })).toHaveAttribute("aria-checked", "false");
    expect(canvas()).toBeNull();
  });
});
