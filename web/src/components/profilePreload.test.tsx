import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogStore } from "../lib/useValheim";
import { emptyAgentState, type ApiState } from "../types";
import { Dashboard } from "./Dashboard";

const warm = vi.hoisted(() => vi.fn());
vi.mock("./PlayerName", async (importOriginal) => ({ ...(await importOriginal<typeof import("./PlayerName")>()), preloadProfileSheet: warm }));

function fixture(): ApiState {
  const s = emptyAgentState(new Date());
  s.players = [{ name: "Ragnar", since: new Date().toISOString() }];
  return { ...s, online: true, metricsConfigured: false, metrics: null, history: { players: [], events: [], online7d: [] } };
}

const mount = () => render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={async () => "ok" as const} />);

beforeEach(() => {
  warm.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
});
afterEach(() => {
  // Unmount while the stubs are still in place: the effect's cleanup cancels through them.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

// A tab left open across a deploy asked for the profile sheet's old chunk on the
// first tap, found it gone and reloaded the page; only the second tap opened it.
describe("the profile sheet's code (#188)", () => {
  it("is loaded once the page is idle, before any name is touched", () => {
    let idle: (() => void) | undefined;
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => ((idle = cb), 1));
    vi.stubGlobal("cancelIdleCallback", () => undefined);
    mount();
    expect(warm).not.toHaveBeenCalled();
    act(() => idle?.());
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("is loaded shortly after the first paint where the browser has no idle callback (Safari)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestIdleCallback", undefined);
    mount();
    expect(warm).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2000));
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("is not loaded when the dashboard is gone before the page went idle (logged out)", () => {
    let idle: (() => void) | undefined;
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => ((idle = cb), 7));
    vi.stubGlobal("cancelIdleCallback", (id: number) => id === 7 && (idle = undefined));
    mount().unmount();
    act(() => idle?.());
    expect(warm).not.toHaveBeenCalled();
  });

  it("is not loaded when the dashboard is gone before the timer fired (Safari, logged out)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestIdleCallback", undefined);
    mount().unmount();
    act(() => vi.advanceTimersByTime(5000));
    expect(warm).not.toHaveBeenCalled();
  });
});
