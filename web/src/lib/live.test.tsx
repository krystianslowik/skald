import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAgentState } from "../types";
import { getLivePositions, PLATE_TOP, stackPlates, useLivePositions, type PlateBox } from "./live";
import { resetTasks, useTasks } from "./tasks";
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

  it("takes only the leaving player's marker when another shares the name (#23)", () => {
    const { page, sock } = connect();
    const map = renderHook(() => useLivePositions());
    const two = { type: "positions", t: 1, players: [
      { id: "Ragnar", name: "Ragnar", platform: "xbox", x: 1, z: 0, health: 1, maxHealth: 1 },
      { id: "Ragnar#2", name: "Ragnar", platform: "steam", x: 2, z: 0, health: 1, maxHealth: 1 },
    ] };
    act(() => sock.push(two));
    act(() => sock.push({ type: "event", event: { seq: 1, ts: "2026-10-09T20:00:00Z", type: "player_leave", data: { name: "Ragnar", id: "Ragnar#2" } } }));
    expect(map.result.current.players.map((p) => p.id)).toEqual(["Ragnar"]);
    map.unmount();
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

describe("name plates of players standing together", () => {
  let n = 0;
  const plate = (x: number, y: number, w = 80, h = 18, id = `p${n++}`): PlateBox => ({ id, x, y, w, h });
  /** The plates' screen rectangles after stacking. */
  const rects = (boxes: PlateBox[], prev?: string[]) => {
    const { shift } = stackPlates(boxes, prev);
    return boxes.map((b, i) => ({ l: b.x - b.w / 2, r: b.x + b.w / 2, t: b.y + PLATE_TOP + shift[i]!, b: b.y + PLATE_TOP + shift[i]! + b.h }));
  };
  const overlap = (a: { l: number; r: number; t: number; b: number }, b: typeof a) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  const noOverlaps = (r: ReturnType<typeof rects>) => {
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) expect(overlap(r[i]!, r[j]!)).toBe(false);
  };

  it("leaves a lone player's plate, and players far apart, where they are", () => {
    expect(stackPlates([plate(100, 100)]).shift).toEqual([0]);
    expect(stackPlates([plate(100, 100), plate(400, 100), plate(100, 300)]).shift).toEqual([0, 0, 0]);
  });

  it("stacks the plates of players on the same spot, none covering another", () => {
    const boxes = [plate(200, 200), plate(200, 200, 60), plate(201, 199, 100), plate(199, 202)];
    noOverlaps(rects(boxes));
    // A column right under the dots, not scattered over the map.
    expect(Math.max(...stackPlates(boxes).shift)).toBeLessThan(4 * 22);
  });

  it("keeps the dots' order: the player higher up gets the upper plate", () => {
    const [lower, upper] = rects([plate(300, 314), plate(305, 300)]);
    expect(upper!.b).toBeLessThanOrEqual(lower!.t);
  });

  it("does not swap two plates back and forth while their players walk side by side", () => {
    const ragnar = (y: number) => plate(300, y, 80, 18, "Ragnar");
    const freya = (y: number) => plate(302, y, 80, 18, "Freya");
    let { order } = stackPlates([ragnar(300), freya(301)]);
    expect(order).toEqual(["Ragnar", "Freya"]);
    // A pixel either way on the next frames: the stack stays put.
    for (const [a, b] of [[302, 300], [300, 301], [303, 299]] as const) {
      order = stackPlates([ragnar(a), freya(b)], order).order;
      expect(order).toEqual(["Ragnar", "Freya"]);
    }
    // Freya clearly above now: her plate goes up.
    expect(stackPlates([ragnar(320), freya(300)], order).order).toEqual(["Freya", "Ragnar"]);
  });

  it("does not cover another player's dot with a plate", () => {
    // Bjorn stands just below Freya, where her plate would go.
    const [freya] = rects([plate(100, 100), plate(100, 125)]);
    expect(freya!.t).toBeGreaterThanOrEqual(125 + 9);
  });

  it("copes with a full server in one spot", () => {
    noOverlaps(rects(Array.from({ length: 64 }, (_, i) => plate(500 + (i % 3), 500 + (i % 5)))));
  });
});

describe("shared tasks over the socket", () => {
  it("hands every task list the server sends to the task board", () => {
    resetTasks();
    const { page, sock } = connect();
    const board = renderHook(() => useTasks());
    const forge = { id: 1, title: "Forge", owner: "Astrid", status: "todo", note: "", target: null, materials: [], createdAt: "2026-10-19T10:00:00Z", updatedAt: "2026-10-19T10:00:00Z", doneAt: null };
    act(() => sock.push({ type: "tasks", tasks: [forge] }));
    expect(board.result.current?.map((t) => t.title)).toEqual(["Forge"]);
    act(() => sock.push({ type: "tasks", tasks: [] }));
    expect(board.result.current).toEqual([]);
    board.unmount();
    page.unmount();
  });
});
