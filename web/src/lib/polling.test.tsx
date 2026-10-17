import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminProvider } from "../components/admin/AdminContext";
import { emptyAgentState, type ApiState, type LiveMessage } from "../types";
import { addEvent, useValheim } from "./useValheim";

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
  /** What the page sent: subscribes and unsubscribes. */
  told: string[] = [];
  constructor(public url = "") {
    MockSocket.all.push(this);
  }
  send(m: string) {
    const { type, topic } = JSON.parse(m) as { type: string; topic: string };
    this.told.push(`${type} ${topic}`);
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
/** A page with the Chronicle shown: it asks for log lines. */
const renderWatching = () => {
  const page = renderHook(() => useValheim(() => undefined));
  act(() => void page.result.current.logs.watch!());
  return page;
};
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
    const { result } = renderWatching();
    await tick();
    act(() => last().open());
    expect(stateCalls).toBe(1);
    // Asked before the socket opened: the tail at once and again on open.
    expect(logCalls).toBe(2);

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
    renderWatching();
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
    renderWatching();
    await tick();
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    act(() => last().open());
    await tick();
    const calls = { state: stateCalls, logs: logCalls, sockets: MockSocket.all.length };
    // The Chronicle asked before the socket opened: the tail once now, once on open.
    expect(calls).toEqual({ state: 1, logs: 2, sockets: 1 });
    act(() => setHidden(true));
    await tick(5_000);
    act(() => setHidden(false));
    await tick();
    expect({ state: stateCalls, logs: logCalls, sockets: MockSocket.all.length }).toEqual(calls);
  });

  it("keeps log lines that arrived while the tail was being read again", async () => {
    let release: () => void = () => undefined;
    const { result } = renderWatching();
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
    expect(new URL(sock.url, "http://x").pathname).toBe("/live");
    expect(new URL(sock.url, "http://x").searchParams.get("history")).toBe("1");
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

describe("useValheim log lines as a topic", () => {
  it("asks for lines and reads the tail only while the Chronicle is shown", async () => {
    const { result } = renderHook(() => useValheim(() => undefined));
    await tick();
    act(() => last().open());
    await tick();
    const sock = last();
    expect(new URL(sock.url, "http://x").searchParams.get("logtopic")).toBe("1");
    // The Fire tab: no tail read, no lines asked for.
    expect(logCalls).toBe(0);
    expect(sock.told).toEqual([]);

    let stop: () => void = () => undefined;
    act(() => void (stop = result.current.logs.watch!()));
    await tick();
    expect(sock.told).toEqual(["subscribe logs"]);
    expect(logCalls).toBe(1);
    // A second view of the same lines asks nothing more.
    let stop2: () => void = () => undefined;
    act(() => void (stop2 = result.current.logs.watch!()));
    act(() => stop());
    await tick();
    expect(sock.told).toEqual(["subscribe logs"]);
    act(() => stop2());
    expect(sock.told).toEqual(["subscribe logs", "unsubscribe logs"]);

    // A long sleep while nothing shows the lines: state only.
    const calls = { state: stateCalls, logs: logCalls };
    act(() => setHidden(true));
    await tick(10 * 60_000);
    act(() => setHidden(false));
    act(() => last().open());
    await tick();
    expect({ state: stateCalls, logs: logCalls }).toEqual({ state: calls.state + 1, logs: calls.logs });
    expect(last().told).toEqual([]);
  });

  it("subscribes a socket that opens after the Chronicle asked, and reads the tail again then", async () => {
    const { result } = renderHook(() => useValheim(() => undefined));
    await tick();
    act(() => void result.current.logs.watch!());
    await tick();
    // Read at once (a socket that never opens still shows the tail) ...
    expect(logCalls).toBe(1);
    act(() => last().open());
    await tick();
    expect(last().told).toEqual(["subscribe logs"]);
    // ... and once more for the lines before the subscribe.
    expect(logCalls).toBe(2);
  });
});

describe("useValheim partial state", () => {
  it("merges a partial state over the slices it does not carry", async () => {
    const { result } = renderHook(() => useValheim(() => undefined));
    await tick();
    act(() => last().open());
    await tick();
    const before = result.current.state!;
    const clock = { netTime: 900, day: 0, dayFraction: 0.5, daylight: true, advancing: true, rate: 1 };
    act(() => last().onmessage?.({ data: JSON.stringify({ type: "state", state: { world: { ...before.world, clock } }, online: true, partial: true }) }));
    const after = result.current.state!;
    expect(after.world.clock).toEqual(clock);
    // Untouched slices keep their objects, so their planks do not re-render.
    expect(after.server).toBe(before.server);
    expect(after.history).toBe(before.history);
    act(() => last().onmessage?.({ data: JSON.stringify({ type: "state", state: {}, online: false, partial: true }) }));
    expect(result.current.online).toBe(false);
    expect(result.current.state!.world.clock).toEqual(clock);
  });

  it("reads /api/state again when a partial state lands while a read is in flight", async () => {
    let release: () => void = () => undefined;
    const fetchMock = vi.mocked(fetch);
    const plain = fetchMock.getMockImplementation()!;
    const { result } = renderHook(() => useValheim(() => undefined));
    await tick();
    act(() => last().open());
    await tick();
    const before = stateCalls;
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/state" && stateCalls === before) {
        stateCalls += 1;
        await new Promise<void>((r) => (release = r));
        return Response.json({ ...emptyAgentState(), online: true, metricsConfigured: false, metrics: null, history: { players: [], events: [], online7d: [] } });
      }
      return plain(url);
    });
    act(() => result.current.retry!());
    act(() => last().open());
    const clock = { netTime: 900, day: 0, dayFraction: 0.5, daylight: true, advancing: true, rate: 1 };
    act(() => last().onmessage?.({ data: JSON.stringify({ type: "state", state: { world: { ...result.current.state!.world, clock } }, online: true, partial: true }) }));
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stateCalls).toBe(before + 2);
  });
});
