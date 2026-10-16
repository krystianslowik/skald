import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminProvider } from "../components/admin/AdminContext";
import { emptyAgentState, type ApiState, type LiveMessage } from "../types";
import { addEvent, useValheim } from "./useValheim";

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

describe("useValheim live deltas", () => {
  class Sock {
    static all: Sock[] = [];
    url: string;
    onopen: (() => void) | null = null;
    onmessage: ((m: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(url: string) {
      this.url = url;
      Sock.all.push(this);
    }
    close() {}
    send(m: LiveMessage) {
      act(() => this.onmessage?.({ data: JSON.stringify(m) }));
    }
  }
  const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();

  beforeEach(() => {
    Sock.all = [];
    vi.stubGlobal("WebSocket", Sock);
  });

  it("applies events and history deltas from the socket without refetching /api/state", async () => {
    const { result } = renderHook(() => useValheim(() => undefined));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stateCalls).toBe(1);
    const sock = Sock.all[0]!;
    expect(sock.url).toMatch(/\/live\?history=1$/);
    act(() => sock.onopen?.());

    sock.send({ type: "event", event: { seq: 1, ts: at(1), type: "player_join", data: { name: "Ragnar" } }, stored: true });
    sock.send({ type: "event", event: { seq: 2, ts: at(2), type: "join_code", data: { code: "111111" } }, stored: true });
    // The agent repeats an unchanged value; the server did not store it, so the saga does not grow.
    sock.send({ type: "event", event: { seq: 3, ts: at(3), type: "join_code", data: { code: "111111" } } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(stateCalls).toBe(1);
    expect(result.current.state!.history.events.map((e) => e.type)).toEqual(["join_code", "player_join"]);
    expect(result.current.state!.players.map((p) => p.name)).toEqual(["Ragnar"]);

    const players = [{ name: "Ragnar", sessions: 1, playtimeMs: 0, deaths: 0, lastSeen: at(1), online: true }];
    sock.send({ type: "history", players, online7d: [[Date.now(), 1]] });
    expect(result.current.state!.history.players).toEqual(players);
    expect(result.current.state!.history.online7d).toEqual([[Date.now(), 1]]);
    expect(result.current.state!.history.events).toHaveLength(2);
    expect(result.current.online).toBe(true);
    expect(stateCalls).toBe(1);

    // A message type this page does not know is ignored, not read as a state update.
    act(() => sock.onmessage?.({ data: JSON.stringify({ type: "something_new", x: 1 }) }));
    expect(result.current.online).toBe(true);
    expect(result.current.state!.history.players).toEqual(players);
  });

  it("reads /api/state once more when a delta lands while a read is in flight", async () => {
    let release: (() => void) | null = null;
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/state" && stateCalls === 1) await new Promise<void>((r) => (release = r));
        return inner(url);
      }),
    );
    renderHook(() => useValheim(() => undefined));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stateCalls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000); // the poll's read hangs
    });
    expect(stateCalls).toBe(1);
    Sock.all[0]!.send({ type: "history", players: [], online7d: [] });
    await act(async () => {
      release!();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stateCalls).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(stateCalls).toBe(3);
  });

  it("catches up with one /api/state read when the socket comes back", async () => {
    renderHook(() => useValheim(() => undefined));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => Sock.all[0]!.onopen?.());
    expect(stateCalls).toBe(1);
    await act(async () => {
      Sock.all[0]!.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(stateCalls).toBe(2); // the session check on close
    await act(async () => {
      Sock.all[1]!.onopen?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stateCalls).toBe(3);
  });
});

describe("addEvent", () => {
  const e = (seq: number, ts: string) => ({ seq, ts, type: "death" as const, data: { name: "Bjorn" } });
  it("keeps the saga newest first when an event arrives late", () => {
    const list = [e(3, "2026-10-09T18:00:30Z"), e(1, "2026-10-09T18:00:10Z")];
    expect(addEvent(list, e(4, "2026-10-09T18:00:40Z")).map((x) => x.seq)).toEqual([4, 3, 1]);
    expect(addEvent(list, e(2, "2026-10-09T18:00:20Z")).map((x) => x.seq)).toEqual([3, 2, 1]);
    expect(addEvent(list, e(0, "2026-10-09T18:00:00Z")).map((x) => x.seq)).toEqual([3, 1, 0]);
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
