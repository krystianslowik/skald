import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminProvider } from "../components/admin/AdminContext";
import { emptyAgentState, type ApiState } from "../types";
import { useValheim } from "./useValheim";

let hidden = false;
let stateCalls = 0;
let statusCalls = 0;

const setHidden = (h: boolean) => {
  hidden = h;
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  stateCalls = 0;
  statusCalls = 0;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/state") {
        stateCalls += 1;
        return Response.json({ ...emptyAgentState(), online: true, metricsConfigured: false, metrics: null, history: { players: [], events: [], online7d: [] } });
      }
      if (url === "/api/admin/status") {
        statusCalls += 1;
        return Response.json({ required: false, admin: true });
      }
      return Response.json({ lines: [] });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as unknown as { hidden?: boolean }).hidden;
});

describe("useValheim polling", () => {
  it("polls /api/state every minute while shown, not while hidden, and catches up once on return", async () => {
    renderHook(() => useValheim(() => undefined));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stateCalls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(stateCalls).toBe(2);

    setHidden(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(stateCalls).toBe(2);

    await act(async () => {
      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stateCalls).toBe(3);
    // Nothing was missed since: switching back and forth costs nothing.
    await act(async () => {
      setHidden(true);
      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stateCalls).toBe(3);
  });
});

describe("admin status polling", () => {
  it("asks every 20 s while shown, skips while hidden, and asks again on return", async () => {
    const state = { ...emptyAgentState(), online: true, metricsConfigured: false, metrics: null, history: { players: [], events: [], online7d: [] } } as ApiState;
    render(
      <AdminProvider state={state} online onUnauthorized={() => {}} onShowMap={() => {}}>
        {null}
      </AdminProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(statusCalls).toBe(2);
    setHidden(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(statusCalls).toBe(2);
    await act(async () => {
      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusCalls).toBe(3);
  });
});
