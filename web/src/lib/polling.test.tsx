import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminProvider } from "../components/admin/AdminContext";
import { emptyAgentState, type ApiState } from "../types";
import { useValheim } from "./useValheim";

let hidden = false;
let stateCalls = 0;
let statusCalls = 0;
let logCalls = 0;

const setHidden = (h: boolean) => {
  hidden = h;
  document.dispatchEvent(new Event("visibilitychange"));
};

/** A /live socket the test opens, drops and sends through by hand. */
class MockSocket {
  static all: MockSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    MockSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  close() {
    this.readyState = 3;
  }
  logLine(line: string) {
    this.onmessage?.({ data: JSON.stringify({ type: "event", event: { seq: 0, ts: "2026-10-09T20:00:01Z", type: "log", data: { line } } }) });
  }
}
const last = () => MockSocket.all[MockSocket.all.length - 1]!;
const tick = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  stateCalls = 0;
  statusCalls = 0;
  logCalls = 0;
  MockSocket.all = [];
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.stubGlobal("WebSocket", MockSocket);
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
      logCalls += 1;
      return Response.json({ lines: [{ ts: "2026-10-09T20:00:00Z", line: `tail ${logCalls}` }] });
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
    await tick();
    act(() => last().open());
    expect(stateCalls).toBe(1);
    await tick(60_000);
    expect(stateCalls).toBe(2);

    act(() => setHidden(true));
    await tick(5 * 60_000);
    expect(stateCalls).toBe(2);

    act(() => setHidden(false));
    // A long sleep may have cost the socket without a close: a fresh one catches up.
    act(() => last().open());
    await tick();
    expect(stateCalls).toBe(3);
    // Nothing was missed since: switching back and forth costs nothing.
    act(() => {
      setHidden(true);
      setHidden(false);
    });
    await tick();
    expect(stateCalls).toBe(3);
  });
});

describe("useValheim waking up (phone unlocked)", () => {
  it("drops the grown backoff, reconnects at once and reads state and the log tail again", async () => {
    const { result } = renderHook(() => useValheim(() => undefined));
    await tick();
    act(() => last().open());
    expect(stateCalls).toBe(1);
    expect(logCalls).toBe(1);

    // Locked: the socket dies and every retry fails, so the backoff climbs to 30 s.
    act(() => setHidden(true));
    act(() => last().drop());
    for (let i = 0; i < 8; i++) {
      await tick(30_000);
      act(() => last().drop());
    }
    await tick();
    const before = MockSocket.all.length;
    const calls = { state: stateCalls, logs: logCalls };

    // Unlocked: a new socket right away, not up to 30 s later.
    act(() => setHidden(false));
    expect(MockSocket.all.length).toBe(before + 1);
    act(() => last().open());
    await tick();
    expect(stateCalls).toBe(calls.state + 1);
    expect(logCalls).toBe(calls.logs + 1);
    // The tail is replaced by the server's, not appended to.
    expect(result.current.logs.getSnapshot().map((l) => l.line)).toEqual([`tail ${logCalls}`]);
    expect(result.current.online).toBe(true);
  });

  it("replaces a socket that still looks open after a long sleep, coming back online or out of the page cache", async () => {
    renderHook(() => useValheim(() => undefined));
    await tick();
    act(() => last().open());
    await tick();

    let calls = { state: stateCalls, logs: logCalls, sockets: MockSocket.all.length };
    act(() => setHidden(true));
    await tick(10 * 60_000);
    act(() => setHidden(false));
    expect(MockSocket.all.length).toBe(calls.sockets + 1);
    expect(MockSocket.all[calls.sockets - 1]!.readyState).toBe(3);
    act(() => last().open());
    await tick();
    expect(stateCalls).toBe(calls.state + 1);
    expect(logCalls).toBe(calls.logs + 1);

    for (const ev of [new Event("online"), Object.assign(new Event("pageshow"), { persisted: true })]) {
      calls = { state: stateCalls, logs: logCalls, sockets: MockSocket.all.length };
      act(() => {
        window.dispatchEvent(ev);
      });
      expect(MockSocket.all.length).toBe(calls.sockets + 1);
      act(() => last().open());
      await tick();
      expect(logCalls).toBe(calls.logs + 1);
    }
  });

  it("does nothing extra for a quick look away or a fresh page load", async () => {
    renderHook(() => useValheim(() => undefined));
    await tick();
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    act(() => last().open());
    await tick();
    const calls = { state: stateCalls, logs: logCalls, sockets: MockSocket.all.length };
    expect(calls).toEqual({ state: 1, logs: 1, sockets: 1 });
    act(() => setHidden(true));
    await tick(5_000);
    act(() => setHidden(false));
    await tick();
    expect({ state: stateCalls, logs: logCalls, sockets: MockSocket.all.length }).toEqual(calls);
  });

  it("keeps log lines that arrived while the tail was being read again", async () => {
    let release: () => void = () => undefined;
    const { result } = renderHook(() => useValheim(() => undefined));
    await tick();
    act(() => last().open());
    await tick();
    const fetchMock = vi.mocked(fetch);
    const plain = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url) => {
      if (String(url).startsWith("/api/logs")) {
        await new Promise<void>((r) => (release = r));
        return Response.json({ lines: [{ ts: "2026-10-09T20:00:00Z", line: "server tail" }] });
      }
      return plain(url);
    });
    act(() => last().drop());
    act(() => setHidden(false));
    await tick(1000);
    act(() => last().open());
    act(() => last().logLine("Ragnar arrived"));
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.logs.getSnapshot().map((l) => l.line)).toEqual(["server tail", "Ragnar arrived"]);
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
