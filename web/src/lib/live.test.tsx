import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAgentState } from "../types";
import { getLivePositions, useLivePositions } from "./live";
import { useValheim } from "./useValheim";

/** Records what the page sends over /live. */
class RecordingSocket {
  static all: RecordingSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    RecordingSocket.all.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const SUB = { type: "subscribe", topic: "positions" };
const UNSUB = { type: "unsubscribe", topic: "positions" };
const sample = (x: number) => ({ type: "positions", t: x, players: [{ name: "Ragnar", platform: "xbox", x, z: 0, health: 1, maxHealth: 1 }] });

beforeEach(() => {
  RecordingSocket.all = [];
  vi.stubGlobal("WebSocket", RecordingSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/state") return Response.json({ ...emptyAgentState(), online: true, metricsConfigured: false, metrics: null, history: { players: [], events: [], online7d: [] } });
      return Response.json({ lines: [] });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const connect = () => {
  const page = renderHook(() => useValheim(() => undefined));
  const sock = RecordingSocket.all.at(-1)!;
  act(() => sock.open());
  return { page, sock };
};

describe("live positions subscription", () => {
  it("asks for no positions until something shows them", () => {
    const { page, sock } = connect();
    // A new client says it picks its topics, so the server sends it no positions.
    expect(new URL(sock.url, "http://x").searchParams.get("topics")).toBe("");
    expect(sock.sent).toEqual([]);
    page.unmount();
  });

  it("subscribes while the map or a player list is mounted, once, and unsubscribes after the last", () => {
    const { page, sock } = connect();
    const a = renderHook(() => useLivePositions());
    const b = renderHook(() => useLivePositions());
    expect(sock.sent).toEqual([SUB]);
    act(() => sock.push(sample(5)));
    expect(a.result.current.players[0]!.x).toBe(5);
    a.unmount();
    expect(sock.sent).toEqual([SUB]);
    b.unmount();
    expect(sock.sent).toEqual([SUB, UNSUB]);
    // The markers do not linger for the next time the map opens.
    expect(getLivePositions().players).toEqual([]);
    page.unmount();
  });

  it("ignores a sample still on its way after the last watcher left", () => {
    const { page, sock } = connect();
    const map = renderHook(() => useLivePositions());
    act(() => sock.push(sample(5)));
    map.unmount();
    act(() => sock.push(sample(6)));
    expect(getLivePositions().players).toEqual([]);
    page.unmount();
  });

  it("subscribes again on a new socket after a reconnect", () => {
    vi.useFakeTimers();
    try {
      const { page, sock } = connect();
      const map = renderHook(() => useLivePositions());
      act(() => sock.onclose?.());
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      const next = RecordingSocket.all.at(-1)!;
      expect(next).not.toBe(sock);
      act(() => next.open());
      expect(next.sent).toEqual([SUB]);
      map.unmount();
      page.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribes on the socket that replaces one after waking, and the old one sends nothing", () => {
    const { page, sock } = connect();
    const map = renderHook(() => useLivePositions());
    expect(sock.sent).toEqual([SUB]);
    // Back online: a socket that still looks open is not trusted.
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    const next = RecordingSocket.all.at(-1)!;
    expect(next).not.toBe(sock);
    expect(new URL(next.url, "http://x").searchParams.get("history")).toBe("1");
    act(() => next.open());
    expect(next.sent).toEqual([SUB]);
    map.unmount();
    expect(next.sent).toEqual([SUB, UNSUB]);
    expect(sock.sent).toEqual([SUB]);
    page.unmount();
  });
});
