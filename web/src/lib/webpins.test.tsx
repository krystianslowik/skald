import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPin } from "@server/pintypes";
import { emptyAgentState } from "../types";
import { useValheim } from "./useValheim";
import { createPin, deletePin, dropPin, filterPins, isMine, pinName, putPin, resetPins, setPinName, setPins, storedPinFilter, storePinFilter, updatePin, usePins, type PinFilter } from "./webpins";

const pin = (over: Partial<WebPin> = {}): WebPin => ({
  id: "a",
  x: 10,
  z: 20,
  icon: "dungeon",
  note: "Crypt",
  author: "Ragnar",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  state: "new",
  claimedBy: null,
  stateBy: "Ragnar",
  stateAt: 1,
  archived: false,
  ...over,
});

const PINS = [
  pin({ id: "1", author: "Ragnar" }),
  pin({ id: "2", author: "Freya", state: "claimed", claimedBy: "ragnar" }),
  pin({ id: "3", author: "Freya", state: "cleared", claimedBy: "Freya", stateBy: "Freya" }),
  pin({ id: "4", author: "Ragnar", state: "depleted" }),
  pin({ id: "5", author: "Bjorn", archived: true }),
  pin({ id: "6", author: "Bjorn", state: "claimed", claimedBy: "Bjorn" }),
];

const ids = (f: PinFilter, me: string) => filterPins(PINS, f, me).map((p) => p.id);

describe("filterPins", () => {
  it("splits open from completed and the group from mine, never showing archived pins", () => {
    expect(ids({ show: true, who: "group", status: "open" }, "Ragnar")).toEqual(["1", "2", "6"]);
    expect(ids({ show: true, who: "group", status: "completed" }, "Ragnar")).toEqual(["3", "4"]);
    // Mine: placed or claimed under my name, in any case.
    expect(ids({ show: true, who: "mine", status: "open" }, "Ragnar")).toEqual(["1", "2"]);
    expect(ids({ show: true, who: "mine", status: "completed" }, "ragnar")).toEqual(["4"]);
    // Without a name nothing is mine.
    expect(ids({ show: true, who: "mine", status: "open" }, "")).toEqual([]);
    expect(ids({ show: false, who: "group", status: "open" }, "Ragnar")).toEqual([]);
  });

  it("knows mine", () => {
    expect(isMine(PINS[1]!, "RAGNAR")).toBe(true);
    expect(isMine(PINS[2]!, "Ragnar")).toBe(false);
  });
});

describe("pin filter and name storage", () => {
  afterEach(() => localStorage.clear());

  it("remembers the filter and falls back on garbage", () => {
    storePinFilter({ show: false, who: "mine", status: "completed" });
    expect(storedPinFilter()).toEqual({ show: false, who: "mine", status: "completed" });
    localStorage.setItem("skald.map.pins", JSON.stringify({ who: "them", status: 3 }));
    expect(storedPinFilter()).toEqual({ show: true, who: "group", status: "open" });
    localStorage.setItem("skald.map.pins", "{");
    expect(storedPinFilter()).toEqual({ show: true, who: "group", status: "open" });
  });

  it("keeps the device's name tidy", () => {
    expect(pinName()).toBe("");
    setPinName("  Astrid   the  Bold ");
    expect(pinName()).toBe("Astrid the Bold");
    // Cut by code point like the server counts, invisible characters out.
    setPinName("\u{1F525}".repeat(30) + "\u202E");
    expect([...pinName()]).toHaveLength(24);
  });
});

describe("pins store", () => {
  let answer: () => Promise<Response>;
  const calls: { url: string; init?: RequestInit }[] = [];
  beforeEach(() => {
    resetPins();
    calls.length = 0;
    answer = async () => Response.json({ ok: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return answer();
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const body = () => JSON.parse(String(calls.at(-1)!.init!.body)) as Record<string, unknown>;

  it("takes the list and live changes, never an older or a deleted copy", () => {
    const h = renderHook(() => usePins());
    expect(h.result.current.load).toBe("idle");
    act(() => setPins([pin({ id: "b", createdAt: 2 }), pin({ id: "a" })]));
    expect(h.result.current.load).toBe("ready");
    expect(h.result.current.pins.map((p) => p.id)).toEqual(["a", "b"]);
    act(() => putPin(pin({ id: "a", state: "claimed", claimedBy: "Freya", version: 3 })));
    expect(h.result.current.pins[0]!.state).toBe("claimed");
    act(() => putPin(pin({ id: "a", version: 2 })));
    expect(h.result.current.pins[0]!.state).toBe("claimed");
    act(() => dropPin("b"));
    expect(h.result.current.pins.map((p) => p.id)).toEqual(["a"]);
    // A late answer about a deleted pin does not bring it back.
    act(() => putPin(pin({ id: "b", version: 9 })));
    expect(h.result.current.pins.map((p) => p.id)).toEqual(["a"]);
    // Nor does an icon this build does not know.
    act(() => putPin(pin({ id: "c", icon: "constructor" as never })));
    expect(h.result.current.pins.map((p) => p.id)).toEqual(["a"]);
    // A new list (another world) replaces the pins, but keeps a copy newer than it.
    act(() => setPins([pin({ id: "a", version: 1 }), pin({ id: "z" })]));
    expect(h.result.current.pins.map((p) => [p.id, p.version])).toEqual([["a", 3], ["z", 1]]);
    act(() => setPins([]));
    expect(h.result.current.pins).toEqual([]);
    h.unmount();
  });

  it("sends only what changes, with what the page saw", async () => {
    const seen = pin({ id: "p1", state: "new", note: "Crypt", icon: "dungeon" });
    answer = async () => Response.json({ ok: true, pin: { ...seen, state: "claimed", claimedBy: "Freya", version: 2 } });
    expect(await updatePin(seen, "Freya", { state: "claimed", note: "Crypt" })).toMatchObject({ ok: true });
    expect(calls.at(-1)).toMatchObject({ url: "/api/pins/p1", init: { method: "PATCH" } });
    expect(body()).toEqual({ by: "Freya", state: "claimed", expect: { state: "new", claimedBy: null } });
    await updatePin(seen, "Freya", { note: "Two rooms", icon: "cave", archived: true });
    expect(body()).toEqual({ by: "Freya", note: "Two rooms", icon: "cave", archived: true, expect: { note: "Crypt", icon: "dungeon" } });
    // Nothing to change: no request at all.
    const n = calls.length;
    expect(await updatePin(seen, "Freya", { state: "new" })).toEqual({ ok: true, pin: seen });
    expect(calls.length).toBe(n);
  });

  it("moves onto the newer copy when the change is stale", async () => {
    const h = renderHook(() => usePins());
    const seen = pin({ id: "p1" });
    act(() => setPins([seen]));
    const now = pin({ id: "p1", state: "claimed", claimedBy: "Bjorn", version: 2 });
    answer = async () => Response.json({ ok: false, error: "stale", pin: now }, { status: 409 });
    expect(await updatePin(seen, "Freya", { state: "cleared" })).toEqual({ ok: false, error: "stale", pin: now });
    expect(h.result.current.pins[0]).toEqual(now);
    h.unmount();
  });

  it("shows its own change at once and reports refusals", async () => {
    answer = async () => Response.json({ ok: true, pin: pin({ id: "new1" }) });
    expect(await createPin({ x: 1, z: 2, icon: "point", note: "", by: "Ragnar" })).toMatchObject({ ok: true });
    expect(calls.at(-1)).toMatchObject({ url: "/api/pins", init: { method: "POST" } });
    const h = renderHook(() => usePins());
    expect(h.result.current.pins.map((p) => p.id)).toContain("new1");

    answer = async () => Response.json({ ok: true });
    expect(await deletePin("new1")).toEqual({ ok: true, pin: undefined });
    expect(h.result.current.pins.map((p) => p.id)).not.toContain("new1");

    answer = async () => Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    expect(await createPin({ x: 1, z: 2, icon: "point", note: "", by: "Ragnar" })).toEqual({ ok: false, error: "signed_out" });
    answer = async () => Response.json({ ok: false, error: "not_archived", message: "archive first" }, { status: 409 });
    expect(await deletePin("x")).toEqual({ ok: false, error: "not_archived", message: "archive first" });
    answer = async () => {
      throw new TypeError("offline");
    };
    expect(await createPin({ x: 1, z: 2, icon: "point", note: "", by: "Ragnar" })).toEqual({ ok: false, error: "network" });
    h.unmount();
  });
});

describe("pins on /live", () => {
  class Sock {
    static all: Sock[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((m: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public url: string) {
      Sock.all.push(this);
    }
    send() {}
    close() {}
  }
  beforeEach(() => {
    resetPins();
    Sock.all = [];
    vi.stubGlobal("WebSocket", Sock);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/state") return Response.json({ ...emptyAgentState(), online: true, metricsConfigured: false, metrics: null, history: { players: [], events: [], online7d: [] } });
        return Response.json({ lines: [] });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("applies the list, changes and deletions the socket sends", () => {
    const page = renderHook(() => useValheim(() => undefined));
    const map = renderHook(() => usePins());
    const sock = Sock.all.at(-1)!;
    const push = (m: unknown) => act(() => sock.onmessage?.({ data: JSON.stringify(m) }));
    act(() => {
      sock.readyState = 1;
      sock.onopen?.();
    });
    push({ type: "pins", pins: [pin({ id: "listed" })] });
    expect(map.result.current.load).toBe("ready");
    push({ type: "pin", pin: pin({ id: "fromlive", createdAt: 5 }) });
    expect(map.result.current.pins.map((p) => p.id)).toEqual(["listed", "fromlive"]);
    push({ type: "pin_gone", id: "listed" });
    expect(map.result.current.pins.map((p) => p.id)).toEqual(["fromlive"]);
    // No pin reads of its own: the socket brings the list.
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith("/api/pins"))).toBe(false);
    map.unmount();
    page.unmount();
  });
});
