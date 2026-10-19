import { describe, expect, it } from "bun:test";
import type { AgentSource } from "../src/agent";
import { createApp } from "../src/app";
import { createSession, RateLimiter, SESSION_COOKIE } from "../src/auth";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { liveSocket, type LiveSocket } from "../src/live";
import { silentLog } from "../src/log";
import { worldId } from "../src/catchup";
import { canMove, PinStore, type PinEvent } from "../src/pins";
import { emptyAgentState } from "../src/types";
import { cutText, sameName, tidyText, type WebPin } from "../src/pintypes";

const T0 = Date.parse("2026-10-19T18:00:00Z");

function store(max?: number) {
  let now = T0;
  const s = new PinStore(":memory:", () => now, max);
  s.setWorld("world-a");
  const sent: PinEvent[] = [];
  s.subscribe((m) => sent.push(m));
  return { s, sent, tick: (ms = 1000) => (now += ms) };
}

function made(s: PinStore, over: Record<string, unknown> = {}): WebPin {
  const r = s.create({ x: 120.44, z: -340, icon: "dungeon", note: "Crypt by the river", by: "Ragnar", ...over });
  if (!r.ok) throw new Error(r.message);
  return r.pin;
}

describe("PinStore", () => {
  it("creates a new pin and tells the listeners", () => {
    const { s, sent } = store();
    const pin = made(s);
    expect(pin).toMatchObject({ version: 1, x: 120.4, z: -340, icon: "dungeon", note: "Crypt by the river", author: "Ragnar", state: "new", claimedBy: null, stateBy: "Ragnar", archived: false, createdAt: T0 });
    expect(s.list()).toEqual([pin]);
    expect(sent).toEqual([{ kind: "put", pin }]);
  });

  it("records its schema version", () => {
    expect(store().s.schemaVersion()).toBe(1);
  });

  it("refuses bad input", () => {
    const { s, sent } = store();
    expect(s.create({ x: "1", z: 0, by: "Freya" })).toMatchObject({ ok: false, error: "outside" });
    expect(s.create({ x: 0, z: 20_000, by: "Freya" })).toMatchObject({ ok: false, error: "outside" });
    expect(s.create({ x: 0, z: Number.NaN, by: "Freya" })).toMatchObject({ ok: false, error: "outside" });
    expect(s.create({ x: 0, z: 0, icon: "skull", by: "Freya" })).toMatchObject({ ok: false, message: "unknown icon" });
    expect(s.create({ x: 0, z: 0, note: "x".repeat(141), by: "Freya" })).toMatchObject({ ok: false, error: "bad_request" });
    expect(s.create({ x: 0, z: 0, by: "   " })).toMatchObject({ ok: false, message: "name missing" });
    expect(s.create({ x: 0, z: 0, by: "B".repeat(25) })).toMatchObject({ ok: false, error: "bad_request" });
    // Counted by code point, as the page cuts them: 24 emoji are a name.
    expect(s.create({ x: 0, z: 0, by: "\u{1F525}".repeat(24) }).ok).toBe(true);
    expect(s.create({ x: 0, z: 0 } as never)).toMatchObject({ ok: false, error: "bad_request" });
    expect(sent).toHaveLength(1);
  });

  it("keeps one line and drops control, bidi and zero-width characters", () => {
    const { s } = store();
    const pin = made(s, { note: "  two\nlines\u0007 here\u202E ", by: " Bj\u200Born\uFEFF\t" });
    expect(pin.note).toBe("two lines here");
    expect(pin.author).toBe("Bjorn");
    expect(made(s, { icon: undefined, note: undefined }).icon).toBe("point");
    expect(tidyText("a\u2066b\u2069\u200D c")).toBe("ab c");
    // Soft hyphens, word joiners and fillers draw nothing either; emoji presentation stays.
    expect(tidyText("Bob\u00AD\u2060\u3164")).toBe("Bob");
    expect(tidyText("\u2764\uFE0F")).toBe("\u2764\uFE0F");
    expect(cutText("\u{1F525}\u{1F525}x", 2)).toBe("\u{1F525}\u{1F525}");
  });

  it("compares names without case but with accents", () => {
    expect(sameName("Ragnar", "rAGNAR")).toBe(true);
    expect(sameName("Bjorn", "Björn")).toBe(false);
    expect(sameName(null, "Ragnar")).toBe(false);
  });

  it("claims, finishes and reopens a pin, keeping who did what", () => {
    const { s, tick } = store();
    const pin = made(s);
    tick();
    const claimed = s.update(pin.id, { by: "Freya", state: "claimed", expect: { state: "new" } });
    expect(claimed).toMatchObject({ ok: true, pin: { version: 2, state: "claimed", claimedBy: "Freya", stateBy: "Freya", stateAt: T0 + 1000 } });
    // Someone else cannot take a claim over; the answer carries the pin as it is.
    expect(s.update(pin.id, { by: "Bjorn", state: "claimed", expect: { state: "new" } })).toMatchObject({ ok: false, error: "stale", pin: { claimedBy: "Freya" } });
    // The claimer claiming again (in another case) changes nothing.
    expect(s.update(pin.id, { by: "freya", state: "claimed" })).toMatchObject({ ok: true, pin: { version: 2, stateAt: T0 + 1000 } });
    tick();
    const done = s.update(pin.id, { by: "Freya", state: "cleared", expect: { state: "claimed", claimedBy: "FREYA" } });
    expect(done).toMatchObject({ ok: true, pin: { state: "cleared", claimedBy: "Freya", stateBy: "Freya" } });
    // A finished pin is not claimed again without reopening it first.
    expect(s.update(pin.id, { by: "Bjorn", state: "claimed" })).toMatchObject({ ok: false, error: "bad_move" });
    expect(s.update(pin.id, { by: "Bjorn", state: "depleted", expect: { state: "cleared" } })).toMatchObject({ ok: true, pin: { state: "depleted", stateBy: "Bjorn" } });
    expect(s.update(pin.id, { by: "Bjorn", state: "new" })).toMatchObject({ ok: true, pin: { state: "new", claimedBy: null, stateBy: "Bjorn" } });
    // With no accounts, anyone may drop a claim.
    s.update(pin.id, { by: "Astrid", state: "claimed" });
    expect(s.update(pin.id, { by: "Bjorn", state: "new", expect: { state: "claimed", claimedBy: "Astrid" } })).toMatchObject({ ok: true, pin: { state: "new", claimedBy: null } });
    expect(s.update(pin.id, { by: "Bjorn", state: "burnt" })).toMatchObject({ ok: false, error: "bad_request" });
    expect(s.update("nope", { by: "Bjorn", state: "new" })).toMatchObject({ ok: false, error: "not_found" });
    expect(s.update(pin.id, { state: "new" } as never)).toMatchObject({ ok: false, error: "bad_request" });
    expect(s.update(pin.id, { by: "Bjorn", state: "new", expect: { state: "gone" } })).toMatchObject({ ok: false, error: "bad_request" });
  });

  it("refuses a move made on what the page saw before someone else moved the pin", () => {
    const { s } = store();
    const pin = made(s);
    s.update(pin.id, { by: "Freya", state: "claimed", expect: { state: "new" } });
    // Bjorn saw it new and marks it cleared: Freya's claim came first.
    const late = s.update(pin.id, { by: "Bjorn", state: "cleared", expect: { state: "new", claimedBy: null } });
    expect(late).toMatchObject({ ok: false, error: "stale", pin: { state: "claimed", claimedBy: "Freya", version: 2 } });
    // Saw it claimed by someone else than it is.
    expect(s.update(pin.id, { by: "Bjorn", state: "depleted", expect: { state: "claimed", claimedBy: "Astrid" } })).toMatchObject({ ok: false, error: "stale" });
    // Reopening a pin finished meanwhile is stale too.
    s.update(pin.id, { by: "Freya", state: "cleared", expect: { state: "claimed" } });
    expect(s.update(pin.id, { by: "Bjorn", state: "new", expect: { state: "claimed" } })).toMatchObject({ ok: false, error: "stale" });
    // The same move twice is no clash.
    expect(s.update(pin.id, { by: "Bjorn", state: "cleared", expect: { state: "claimed" } })).toMatchObject({ ok: true, pin: { state: "cleared", stateBy: "Freya" } });
    // A note or mark changed by someone else is not overwritten.
    s.update(pin.id, { by: "Freya", note: "Two rooms left", expect: { note: pin.note } });
    expect(s.update(pin.id, { by: "Bjorn", note: "Empty", expect: { note: pin.note } })).toMatchObject({ ok: false, error: "stale", pin: { note: "Two rooms left" } });
    s.update(pin.id, { by: "Freya", icon: "cave", expect: { icon: "dungeon" } });
    expect(s.update(pin.id, { by: "Bjorn", icon: "boss", expect: { icon: "dungeon" } })).toMatchObject({ ok: false, error: "stale" });
    expect(s.update(pin.id, { by: "Bjorn", icon: "boss", expect: { icon: "cave" } })).toMatchObject({ ok: true, pin: { icon: "boss" } });
  });

  it("knows every allowed move", () => {
    expect(canMove("new", "claimed")).toBe(true);
    expect(canMove("new", "depleted")).toBe(true);
    expect(canMove("claimed", "new")).toBe(true);
    expect(canMove("claimed", "cleared")).toBe(true);
    expect(canMove("cleared", "depleted")).toBe(true);
    expect(canMove("cleared", "new")).toBe(true);
    expect(canMove("cleared", "claimed")).toBe(false);
    expect(canMove("depleted", "claimed")).toBe(false);
  });

  it("archives and restores instead of deleting, and edits the note and icon", () => {
    const { s, sent } = store();
    const pin = made(s);
    expect(s.update(pin.id, { by: "Freya", archived: true })).toMatchObject({ ok: true, pin: { archived: true } });
    expect(s.list()).toHaveLength(1);
    expect(s.update(pin.id, { by: "Freya", archived: "yes" })).toMatchObject({ ok: false, error: "bad_request" });
    expect(s.update(pin.id, { by: "Freya", archived: false, note: "Emptied the first room", icon: "cave" })).toMatchObject({ ok: true, pin: { archived: false, note: "Emptied the first room", icon: "cave" } });
    expect(s.update(pin.id, { by: "Freya", icon: "skull" })).toMatchObject({ ok: false, message: "unknown icon" });
    // An update that changes nothing is not sent again.
    const before = sent.length;
    expect(s.update(pin.id, { by: "Freya", note: "Emptied the first room" }).ok).toBe(true);
    expect(sent.length).toBe(before);
  });

  it("deletes only archived pins for good", () => {
    const { s, sent } = store();
    const pin = made(s);
    expect(s.delete(pin.id)).toMatchObject({ ok: false, error: "not_archived" });
    s.update(pin.id, { by: "Freya", archived: true });
    expect(s.delete(pin.id)).toEqual({ ok: true });
    expect(s.delete(pin.id)).toMatchObject({ ok: false, error: "not_found" });
    expect(s.list()).toEqual([]);
    expect(sent.at(-1)).toEqual({ kind: "gone", id: pin.id });
  });

  it("makes room by dropping the oldest archived pin in one step, else refuses", () => {
    const { s, sent, tick } = store(2);
    const a = made(s);
    tick();
    const b = made(s);
    expect(s.create({ x: 0, z: 0, by: "Astrid" })).toMatchObject({ ok: false, error: "full" });
    s.update(b.id, { by: "Astrid", archived: true });
    tick();
    s.update(a.id, { by: "Astrid", archived: true });
    sent.length = 0;
    const c = made(s);
    expect(s.list().map((p) => p.id)).toEqual([a.id, c.id]);
    expect(sent).toEqual([{ kind: "gone", id: b.id }, { kind: "put", pin: c }]);
  });

  it("counts the limit per world: another world's pins never fill this one", () => {
    const { s } = store(1);
    made(s);
    expect(s.create({ x: 0, z: 0, by: "Astrid" })).toMatchObject({ ok: false, error: "full" });
    s.setWorld("world-b");
    expect(s.create({ x: 0, z: 0, by: "Astrid" }).ok).toBe(true);
  });

  it("keeps pins per world and lists only the current one", () => {
    const { s, sent } = store();
    const a = made(s);
    sent.length = 0;
    s.setWorld("world-b");
    expect(sent).toEqual([{ kind: "list" }]);
    expect(s.list()).toEqual([]);
    expect(s.get(a.id)).toBeNull();
    expect(s.update(a.id, { by: "Freya", state: "claimed" })).toMatchObject({ ok: false, error: "not_found" });
    const b = made(s);
    // The same world again: no new list.
    s.setWorld("world-b");
    expect(sent.filter((e) => e.kind === "list")).toHaveLength(1);
    s.setWorld("world-a");
    expect(s.list().map((p) => p.id)).toEqual([a.id]);
    expect(s.count()).toBe(1);
    expect(b.id).not.toBe(a.id);
  });

  it("keeps pins in the shared history file", () => {
    const history = new HistoryStore(":memory:");
    const one = new PinStore(history.connection);
    one.setWorld("w1");
    const pin = made(one);
    const two = new PinStore(history.connection);
    two.setWorld("w1");
    expect(two.get(pin.id)).toEqual(pin);
  });
});

describe("pins follow the world on the map", () => {
  it("takes the world from the agent's state, keyed, and keeps it while the state has none", () => {
    const pins = new PinStore(":memory:");
    const sent: PinEvent[] = [];
    pins.subscribe((e) => sent.push(e));
    expect(pins.world).toBe("");
    // No world yet: nothing can be pinned into nowhere.
    expect(pins.create({ x: 0, z: 0, by: "Ragnar" })).toMatchObject({ ok: false, error: "no_world" });
    pins.followWorld({ seedName: "TestSeed", seed: 42 }, "k");
    expect(pins.world).toBe(worldId("k", "TestSeed", 42));
    expect(sent).toEqual([{ kind: "list" }]);
    pins.followWorld(null, "k");
    pins.followWorld({ seedName: "TestSeed", seed: 42 }, "k");
    expect(pins.world).toBe(worldId("k", "TestSeed", 42));
    expect(sent).toHaveLength(1);
    pins.followWorld({ seedName: "Other", seed: 7 }, "k");
    expect(sent).toHaveLength(2);
  });

  it("follows the hub's states on a live server", () => {
    const hub = new Hub({} as AgentSource, new HistoryStore(":memory:"));
    const pins = new PinStore(":memory:");
    hub.subscribe((m) => {
      if (m.type === "state") pins.followWorld(m.state.world.meta, "k");
    });
    const state = emptyAgentState();
    state.world.meta = { name: "w", seedName: "TestSeed", seed: 42, worldGenVersion: 2, netTime: 0, day: 0, savedAt: new Date(T0).toISOString() } as never;
    (hub as unknown as { emit(m: unknown): void }).emit({ type: "state", state, online: true });
    expect(pins.world).toBe(worldId("k", "TestSeed", 42));
  });
});

describe("/api/pins", () => {
  const agent = {} as AgentSource;
  function app(o: { limiter?: RateLimiter; withPins?: boolean } = {}) {
    const pins = new PinStore(":memory:");
    pins.setWorld("w1");
    const a = createApp({
      sessionSecret: "secret",
      passwordHash: "x",
      secureCookie: true,
      agent,
      hub: new Hub(agent, new HistoryStore(":memory:")),
      metrics: async () => null,
      pins: o.withPins === false ? undefined : { store: pins, limiter: o.limiter },
      log: silentLog,
    });
    const cookie = `${SESSION_COOKIE}=${createSession("secret")}`;
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { Cookie: cookie }) =>
      a.request(path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { call, pins };
  }

  it("needs a session", async () => {
    const { call } = app();
    expect((await call("GET", "/api/pins", undefined, {})).status).toBe(401);
    expect((await call("POST", "/api/pins", { x: 0, z: 0, by: "Ragnar" }, {})).status).toBe(401);
  });

  it("is off without a store", async () => {
    expect((await app({ withPins: false }).call("GET", "/api/pins")).status).toBe(404);
  });

  it("adds in the world on the map, lists, changes and deletes", async () => {
    const { call } = app();
    const created = await call("POST", "/api/pins", { x: 10, z: 20, icon: "ore", note: "Copper", by: "Ragnar" });
    expect(created.status).toBe(200);
    const { pin } = (await created.json()) as { pin: WebPin };
    expect(pin).toMatchObject({ icon: "ore", author: "Ragnar", state: "new" });

    const list = await call("GET", "/api/pins");
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    expect(((await list.json()) as { pins: WebPin[] }).pins.map((p) => p.id)).toEqual([pin.id]);

    const claim = await call("PATCH", `/api/pins/${pin.id}`, { by: "Freya", state: "claimed", expect: { state: "new" } });
    expect(((await claim.json()) as { pin: WebPin }).pin.claimedBy).toBe("Freya");
    const late = await call("PATCH", `/api/pins/${pin.id}`, { by: "Bjorn", state: "cleared", expect: { state: "new" } });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ ok: false, error: "stale", pin: { state: "claimed", claimedBy: "Freya" } });
    expect((await call("PATCH", `/api/pins/${pin.id}`, { by: "Bjorn", state: "gone" })).status).toBe(400);
    expect((await call("PATCH", "/api/pins/missing", { by: "Bjorn", state: "new" })).status).toBe(404);

    expect((await call("DELETE", `/api/pins/${pin.id}`)).status).toBe(409);
    await call("PATCH", `/api/pins/${pin.id}`, { by: "Freya", archived: true });
    expect((await call("DELETE", `/api/pins/${pin.id}`)).status).toBe(200);
    expect((await call("DELETE", `/api/pins/${pin.id}`)).status).toBe(404);
  });

  it("refuses broken, non-JSON and oversized bodies", async () => {
    const { call } = app();
    expect((await call("POST", "/api/pins", "not json")).status).toBe(400);
    expect((await call("POST", "/api/pins", [1, 2])).status).toBe(400);
    expect((await call("POST", "/api/pins", "x=1", { Cookie: `${SESSION_COOKIE}=${createSession("secret")}`, "Content-Type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await call("POST", "/api/pins", { x: 0, z: 0, by: "Ragnar", note: "x".repeat(5000) })).status).toBe(413);
  });

  it("limits changes per client, counting only requests that parse", async () => {
    const { call } = app({ limiter: new RateLimiter(2, 60_000, 60_000) });
    expect((await call("POST", "/api/pins", "garbage")).status).toBe(400);
    expect((await call("POST", "/api/pins", { x: 0, z: 0, by: "Ragnar" })).status).toBe(200);
    expect((await call("POST", "/api/pins", { x: 1, z: 1, by: "Ragnar" })).status).toBe(200);
    const third = await call("POST", "/api/pins", { x: 2, z: 2, by: "Ragnar" });
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBeTruthy();
    // Reading is never limited.
    expect((await call("GET", "/api/pins")).status).toBe(200);
  });
});

describe("/live pin frames", () => {
  function sockets(n: number) {
    const frames: string[][] = Array.from({ length: n }, () => []);
    const socks: LiveSocket[] = frames.map((f) => ({ data: { positions: false, logs: false, history: false }, send: (s: string) => f.push(s) }));
    return { frames, socks };
  }

  it("sends the world's list on open, then one frame per change, and stops on close", () => {
    const pins = new PinStore(":memory:");
    pins.setWorld("w1");
    const early = made(pins);
    const hub = new Hub({} as AgentSource, new HistoryStore(":memory:"));
    const live = liveSocket(hub, { pins });
    const { frames, socks } = sockets(2);
    for (const ws of socks) live.open(ws);
    for (const f of frames) expect(f.map((s) => JSON.parse(s)).find((m) => m.type === "pins")).toEqual({ type: "pins", pins: [early] });
    const pin = made(pins);
    for (const f of frames) expect(JSON.parse(f.at(-1)!)).toEqual({ type: "pin", pin });
    // One string for every socket: serialised once.
    expect(frames[0]!.at(-1)).toBe(frames[1]!.at(-1));
    live.close(socks[1]!);
    pins.update(pin.id, { by: "Freya", archived: true });
    pins.delete(pin.id);
    expect(JSON.parse(frames[0]!.at(-1)!)).toEqual({ type: "pin_gone", id: pin.id });
    expect(JSON.parse(frames[1]!.at(-1)!)).toEqual({ type: "pin", pin });
  });

  it("sends a new list when the world changes", () => {
    const pins = new PinStore(":memory:");
    pins.setWorld("w1");
    made(pins);
    const live = liveSocket(new Hub({} as AgentSource, new HistoryStore(":memory:")), { pins });
    const { frames, socks } = sockets(1);
    live.open(socks[0]!);
    pins.setWorld("w2");
    expect(JSON.parse(frames[0]!.at(-1)!)).toEqual({ type: "pins", pins: [] });
    // A socket opening now gets the new world's list too.
    const later = sockets(1);
    live.open(later.socks[0]!);
    expect(later.frames[0]!.map((s) => JSON.parse(s)).find((m) => m.type === "pins")).toEqual({ type: "pins", pins: [] });
  });
});
