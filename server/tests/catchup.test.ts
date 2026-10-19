import { describe, expect, it } from "bun:test";
import type { MapSourceResult } from "../src/agent";
import { createApp } from "../src/app";
import { CATCHUP_MAX_MS, catchupSince, summarize, worldFacts, worldId } from "../src/catchup";
import { HistoryStore } from "../src/db";
import { WEEK_MS } from "../src/history";
import { Hub } from "../src/hub";
import { MapCache } from "../src/map";
import { gateMap } from "../src/mapgate";
import { mockMap } from "../src/mapmock";
import { MockAgent } from "../src/mock";
import { emptyAgentState, type AgentEvent, type AgentEventType, type ApiCatchup, type MapSnapshot } from "../src/types";

const HASH = await Bun.password.hash("ognisko");
const T0 = Date.parse("2026-10-09T18:00:00Z");
const MIN = 60_000;
let seq = 0;
const ev = (min: number, type: AgentEventType, data: Record<string, unknown> = {}): AgentEvent => ({
  seq: ++seq,
  ts: new Date(T0 + min * MIN).toISOString(),
  type,
  data,
});

describe("catchupSince", () => {
  const now = T0;
  it("takes the last visit", () => {
    expect(catchupSince(new Date(now - 3 * 3_600_000).toISOString(), now)).toEqual({ since: now - 3 * 3_600_000, clamped: false });
  });
  it("falls back to the last week on a first visit, a bad value or a long absence", () => {
    for (const raw of [undefined, "", "yesterday", new Date(now - CATCHUP_MAX_MS - 1).toISOString()]) {
      expect(catchupSince(raw, now)).toEqual({ since: now - WEEK_MS, clamped: true });
    }
  });
  it("never starts in the future", () => {
    expect(catchupSince(new Date(now + 3_600_000).toISOString(), now).since).toBe(now);
  });
});

describe("summarize", () => {
  it("counts only the part of a session inside the window", () => {
    const events = [
      ev(0, "player_join", { name: "Ragnar" }),
      ev(0, "player_count", { count: 1 }),
      ev(30, "death", { name: "Ragnar" }),
      // the window opens at 60
      ev(90, "death", { name: "Ragnar" }),
      ev(120, "player_leave", { name: "Ragnar" }),
      ev(120, "player_count", { count: 0 }),
      ev(150, "player_join", { name: "Freya" }),
      ev(150, "player_count", { count: 1 }),
    ];
    const s = summarize(events, T0 + 60 * MIN, T0 + 200 * MIN);
    expect(s.players).toEqual([
      { name: "Ragnar", playtimeMs: 60 * MIN, sessions: 0, deaths: 1, online: false },
      { name: "Freya", playtimeMs: 50 * MIN, sessions: 1, deaths: 0, online: true },
    ]);
  });

  it("runs to the clock once the agent stream has settled", () => {
    const events = [ev(0, "player_join", { name: "Freya" }), ev(0, "player_count", { count: 1 })];
    const s = summarize(events, T0 + 50 * MIN, T0 + 200 * MIN, true);
    expect(s.until).toBe(new Date(T0 + 200 * MIN).toISOString());
    expect(s.players).toEqual([{ name: "Freya", playtimeMs: 150 * MIN, sessions: 0, deaths: 0, online: true }]);
  });

  it("stops short of the newest stored event while the stream is down or catching up", () => {
    const events = [ev(0, "player_join", { name: "Freya" }), ev(0, "player_count", { count: 1 }), ev(90, "death", { name: "Freya" }), ev(100, "raid", { name: "army_eikthyr" })];
    const s = summarize(events, T0 + 50 * MIN, T0 + 200 * MIN, false);
    // A backlog replayed later, or a twin of the newest event stored a moment later, still falls in the next window.
    const until = T0 + 100 * MIN - 1;
    expect(s.until).toBe(new Date(until).toISOString());
    expect(s.raids).toBe(0);
    expect(s.players).toEqual([{ name: "Freya", playtimeMs: until - (T0 + 50 * MIN), sessions: 0, deaths: 1, online: true }]);
    // A death at the newest stored time belongs to the next window only, not to both.
    const tail = [...events, ev(110, "death", { name: "Freya" })];
    const cutShort = summarize(tail, T0 + 50 * MIN, T0 + 200 * MIN, false);
    expect(cutShort.players[0]!.deaths).toBe(1);
    expect(summarize(tail, Date.parse(cutShort.until), T0 + 200 * MIN, true).players[0]!.deaths).toBe(1);
    // The next read, once the stream is live again, has it.
    expect(summarize(events, until, T0 + 200 * MIN, true).raids).toBe(1);
    // Never before the start.
    expect(summarize(events, T0 + 150 * MIN, T0 + 200 * MIN, false).until).toBe(new Date(T0 + 150 * MIN).toISOString());
  });

  it("leaves out players who only played before the window", () => {
    const events = [ev(0, "player_join", { name: "Bjorn" }), ev(10, "player_leave", { name: "Bjorn" }), ev(10, "player_count", { count: 0 })];
    const s = summarize(events, T0 + 60 * MIN, T0 + 120 * MIN);
    expect(s.players).toEqual([]);
  });

  it("counts raids, asked-for backups, restores, restarts, updates and settings", () => {
    const events = [
      ev(0, "server_state", { status: "running" }),
      ev(0, "version", { version: "l-1.0.16", networkVersion: 39 }),
      ev(10, "server_state", { status: "stopped" }),
      ev(12, "server_state", { status: "running" }), // before the window
      ev(60.5, "raid", { name: "army_eikthyr" }),
      ev(61, "raid", { name: "foresttrolls" }),
      ev(62, "world_backup", {}),
      ev(63, "world_saved", { ms: 90 }),
      ev(64, "action", { name: "backup", ok: true, message: "sent HUP" }),
      ev(65, "action", { name: "backup", ok: false, message: "no" }),
      // An update restarts the server: the update is the news.
      ev(70, "server_state", { status: "stopping" }),
      ev(71, "version", { version: "l-1.0.17", networkVersion: 40 }),
      ev(72, "server_state", { status: "running" }),
      // So does a restore.
      ev(80, "admin", { actor: "dashboard-1", command: "restore", step: "begin", result: "ok" }),
      ev(81, "server_state", { status: "stopped" }),
      ev(82, "server_state", { status: "running" }),
      ev(83, "admin", { actor: "dashboard-1", command: "restore", step: "done", result: "ok" }),
      // And applying settings.
      ev(90, "settings_changed", { changedKeys: ["name", "modifier.raids"] }),
      ev(91, "settings_changed", { changedKeys: [] }),
      ev(92, "settings_apply", { state: "applying" }),
      ev(93, "server_state", { status: "stopping" }),
      ev(94, "server_state", { status: "running" }),
      ev(95, "join_code", { code: "123456" }),
      // A plain restart, well apart from those: news.
      ev(110, "server_state", { status: "stopping" }),
      ev(111, "server_state", { status: "running" }),
    ];
    const s = summarize(events, T0 + 60 * MIN, T0 + 120 * MIN);
    expect(s).toMatchObject({ raids: 2, backups: 1, restores: 1, restarts: 1, updates: ["l-1.0.17"], settings: 1 });
    // A join code is never part of it.
    expect(JSON.stringify(s)).not.toContain("123456");
  });

  it("leaves out an event at exactly the start: it was in the window read before", () => {
    const events = [ev(0, "player_join", { name: "Freya" }), ev(30, "death", { name: "Freya" }), ev(30, "raid", { name: "army_eikthyr" }), ev(30, "player_leave", { name: "Freya" })];
    const s = summarize(events, T0 + 30 * MIN, T0 + 60 * MIN);
    expect(s.raids).toBe(0);
    expect(s.players).toEqual([]);
  });

  it("is empty when nothing happened", () => {
    const s = summarize([ev(0, "world_saved", { ms: 80 }), ev(5, "world_backup")], T0 - MIN, T0 + 10 * MIN);
    expect(s).toMatchObject({ players: [], raids: 0, backups: 0, restores: 0, restarts: 0, updates: [], settings: 0 });
  });
});

describe("worldFacts", () => {
  it("keeps only found places and counts ships and carts apart", () => {
    const snap = mockMap({ now: T0 });
    // Spoilers on keep places nobody found; the facts still leave them out.
    const f = worldFacts(gateMap(snap, true));
    expect(f.places.length).toBe(snap.locations.filter((l) => l.kind !== "start" && l.placed && l.explored).length);
    expect(f.places.length).toBeLessThan(snap.locations.length);
    expect(f.ships).toBe(snap.vehicles.filter((v) => v.kind !== "Cart").length);
    expect(f.carts).toBe(snap.vehicles.filter((v) => v.kind === "Cart").length);
    expect(f.portals.map((p) => p.id)).toEqual(snap.portals.map((p) => p.id));
    expect(f.bases).toHaveLength(snap.bases.length);
    expect(f.exploredM2).toBe(Math.round(snap.explored.pixels * snap.explored.metersPerPixel ** 2));
    expect(f.netTime).toBe(snap.meta.netTime);
    // The world's name and seed stay out of it.
    const j = JSON.stringify(f);
    expect(j).not.toContain(snap.meta.seedName);
    expect(j).not.toContain(String(snap.meta.seed));
  });
});

describe("worldId", () => {
  it("is one keyed identity per world, the same across saves and game updates", () => {
    const id = worldId("secret", "Midgard", 123);
    expect(id).toBe(worldId("secret", "Midgard", 123));
    expect(id).not.toBe(worldId("secret", "Midgard", 124));
    expect(id).not.toBe(worldId("secret", "Asgard", 123));
    // Keyed by the panel's secret: a viewer cannot test seed names against it.
    expect(id).not.toBe(worldId("other", "Midgard", 123));
    expect(id).not.toContain("123");
    expect(id).not.toContain("Midgard");
  });
});

describe("GET /api/catchup", () => {
  async function setup(opts: { map?: MapSnapshot | null; events?: AgentEvent[]; now?: number; online?: boolean; streamingSince?: number } = {}) {
    const store = new HistoryStore(":memory:");
    for (const e of opts.events ?? []) store.insert("e1", e);
    const agent = new MockAgent();
    const hub = new Hub(agent, store, { clock: () => opts.now ?? T0 + 200 * MIN });
    const state = emptyAgentState();
    state.world.meta = { ...mockMeta(), bosses: [{ key: "defeated_eikthyr", defeated: true }, { key: "defeated_gdking", defeated: false }] };
    hub.getState = () => state;
    Object.defineProperty(hub, "online", { get: () => opts.online ?? true });
    hub.liveSince = () => ((opts.online ?? true) ? (opts.streamingSince ?? 0) : null);
    const fetchMap = async (): Promise<MapSourceResult> => (opts.map ? { status: 200, etag: '"x"', body: opts.map } : { status: 404, etag: null, body: null });
    const app = createApp({
      sessionSecret: "secret",
      passwordHash: HASH,
      secureCookie: false,
      agent,
      hub,
      metrics: async () => null,
      clock: () => opts.now ?? T0 + 200 * MIN,
      ...(opts.map === undefined ? {} : { map: new MapCache(fetchMap, false, Date.now, "secret") }),
    });
    const res = await app.request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "ognisko" }) });
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    return { app, cookie };
  }

  it("needs a session", async () => {
    const { app } = await setup();
    expect((await app.request("/api/catchup")).status).toBe(401);
  });

  it("sums up the window with the bosses and the world as they are now", async () => {
    const events = [ev(0, "player_join", { name: "Astrid" }), ev(100, "player_leave", { name: "Astrid" }), ev(100, "player_count", { count: 0 })];
    const { app, cookie } = await setup({ events, map: mockMap({ now: T0 }) });
    const since = new Date(T0 + 40 * MIN).toISOString();
    const res = await app.request(`/api/catchup?since=${encodeURIComponent(since)}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as ApiCatchup;
    expect(body.since).toBe(since);
    expect(body.clamped).toBe(false);
    expect(body.players).toEqual([{ name: "Astrid", playtimeMs: 60 * MIN, sessions: 0, deaths: 0, online: false }]);
    expect(body.bosses).toEqual(["defeated_eikthyr"]);
    expect(body.world?.portals.length).toBeGreaterThan(0);
    expect(body.world?.id).toBe(worldId("secret", mockMap({ now: T0 }).meta.seedName, mockMap({ now: T0 }).meta.seed));
    expect(body.world?.places.every((p) => p.kind !== "start")).toBe(true);
  });

  it("covers the last week on a first visit and has no world with the map off", async () => {
    const now = T0 + 200 * MIN;
    const { app, cookie } = await setup({ now });
    const body = (await (await app.request("/api/catchup", { headers: { cookie } })).json()) as ApiCatchup;
    expect(body.clamped).toBe(true);
    expect(body.since).toBe(new Date(now - WEEK_MS).toISOString());
    expect(body.world).toBeNull();
  });

  it("stops short of the newest stored event while the agent link is down", async () => {
    const events = [ev(0, "player_join", { name: "Astrid" }), ev(30, "death", { name: "Astrid" }), ev(31, "world_saved", { ms: 80 })];
    const { app, cookie } = await setup({ events, online: false });
    const since = new Date(T0 + 10 * MIN).toISOString();
    const body = (await (await app.request(`/api/catchup?since=${encodeURIComponent(since)}`, { headers: { cookie } })).json()) as ApiCatchup;
    expect(body.until).toBe(new Date(T0 + 31 * MIN - 1).toISOString());
    expect(body.partial).toBe(true);
    expect(body.players[0]).toMatchObject({ name: "Astrid", deaths: 1 });
  });

  it("waits for a fresh stream to replay its backlog before running to the clock", async () => {
    const now = T0 + 200 * MIN;
    const events = [ev(0, "player_join", { name: "Astrid" }), ev(30, "death", { name: "Astrid" })];
    const fresh = await setup({ events, now, streamingSince: now - 5_000 });
    const a = (await (await fresh.app.request("/api/catchup", { headers: { cookie: fresh.cookie } })).json()) as ApiCatchup;
    expect(a.until).toBe(new Date(T0 + 30 * MIN - 1).toISOString());
    const settled = await setup({ events, now, streamingSince: now - 60_000 });
    const b = (await (await settled.app.request("/api/catchup", { headers: { cookie: settled.cookie } })).json()) as ApiCatchup;
    expect(b.until).toBe(new Date(now).toISOString());
    expect(b.partial).toBe(false);
  });

  it("counts an event stamped a moment ahead of the clock once, in the next window", async () => {
    const now = T0 + 200 * MIN;
    const events = [ev(0, "player_join", { name: "Astrid" }), ev(200 + 0.01, "death", { name: "Astrid" })];
    const first = await setup({ events, now });
    const a = (await (await first.app.request("/api/catchup", { headers: { cookie: first.cookie } })).json()) as ApiCatchup;
    expect(a.players[0]!.deaths).toBe(0);
    expect(summarize(events, Date.parse(a.until), now + MIN, true).players[0]!.deaths).toBe(1);
  });

  it("has no world facts without a key for the world identity", async () => {
    const cache = new MapCache(async () => ({ status: 200, etag: '"x"', body: mockMap({ now: T0 }) }), false);
    expect(await cache.facts()).toBeNull();
    expect((await new MapCache(async () => ({ status: 200, etag: '"x"', body: mockMap({ now: T0 }) }), false, Date.now, "k").facts())?.id).toBe(worldId("k", mockMap({ now: T0 }).meta.seedName, mockMap({ now: T0 }).meta.seed));
  });

  it("has no world while the map is not available", async () => {
    const { app, cookie } = await setup({ map: null });
    const body = (await (await app.request("/api/catchup", { headers: { cookie } })).json()) as ApiCatchup;
    expect(body.world).toBeNull();
  });
});

function mockMeta() {
  const m = mockMap({ now: T0 }).meta;
  return { name: "Testworld", seedName: m.seedName, seed: m.seed, worldGenVersion: m.worldGenVersion, netTime: m.netTime, day: m.day, savedAt: m.savedAt };
}
