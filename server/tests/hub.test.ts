import { describe, expect, it } from "bun:test";
import type { AgentSource } from "../src/agent";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { emptyAgentState, type AgentEvent, type LiveMessage } from "../src/types";

const ev = (seq: number, type: AgentEvent["type"], data: Record<string, unknown>): AgentEvent => ({
  seq,
  ts: new Date(Date.parse("2026-10-09T18:00:00Z") + seq * 1000).toISOString(),
  type,
  data,
});

const BUFFER: AgentEvent[] = [
  ev(1, "log", { line: "x" }),
  ev(2, "join_code", { code: "482915" }),
  ev(3, "player_count", { count: 0 }),
  ev(4, "player_count", { count: 0 }), // repeated value: not stored
  ev(5, "player_join", { name: "Ragnar" }),
  ev(6, "death", { name: "Ragnar" }),
  ev(7, "join_code", { code: "482915" }), // repeated: not stored
];

function fakeAgent(startedAt: string, sinces: number[]): AgentSource {
  return {
    async getState() {
      const s = emptyAgentState();
      s.agent.startedAt = startedAt;
      return s;
    },
    async getLogs() {
      return [];
    },
    async action() {
      return { status: 200, body: { ok: true, message: "" } };
    },
    async backup() {
      return new Response(null, { status: 404 });
    },
    async bridge() {
      return { status: 404, body: { ok: false, message: "not found" } };
    },
    async tools() {
      return { status: 404, body: { ok: false, message: "not found" } };
    },
    async settings() {
      return { status: 404, body: {} };
    },
    async map() {
      return { status: 404, etag: null, body: null };
    },
    async pieces() {
      return new Response(null, { status: 404 });
    },
    async nature() {
      return new Response(null, { status: 404 });
    },
    async asset() {
      return new Response(null, { status: 404 });
    },
    async stream(since, onEvent, signal) {
      sinces.push(since);
      for (const e of BUFFER) if (e.seq > since) onEvent(e);
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("Hub", () => {
  it("stores notable events once, resumes with since, and never duplicates on replay", async () => {
    const store = new HistoryStore(":memory:");
    const sinces: number[] = [];
    const hub = new Hub(fakeAgent("A", sinces), store, { statePollMs: 60_000 });
    const seen: string[] = [];
    hub.subscribe((m) => m.type === "event" && seen.push(m.event.type));
    hub.start();
    await settle();
    expect(hub.online).toBe(true);
    expect(seen).toHaveLength(7); // everything is broadcast, logs included
    expect(store.count()).toBe(4); // join_code, player_count, player_join, death
    hub.stop();

    // A second process on the same DB and same agent epoch resumes after lastSeq.
    const hub2 = new Hub(fakeAgent("A", sinces), store, { statePollMs: 60_000 });
    hub2.start();
    await settle();
    hub2.stop();
    expect(sinces).toEqual([0, 6]);

    // A forced replay from 0 (same epoch) is idempotent.
    const hub3 = new Hub(fakeAgent("A", sinces), store);
    for (const e of BUFFER) hub3.ingest("A", e);
    expect(store.count()).toBe(4);

    // A restarted agent (new epoch) starts from 0.
    const hub4 = new Hub(fakeAgent("B", sinces), store, { statePollMs: 60_000 });
    hub4.start();
    await settle();
    hub4.stop();
    expect(sinces.at(-1)).toBe(0);
    const h = hub4.history();
    expect(h.players[0]!.name).toBe("Ragnar");
  });
});

describe("Hub state", () => {
  it("applies live events newer than the last /state fetch, ignores replayed ones", () => {
    const store = new HistoryStore(":memory:");
    const hub = new Hub(fakeAgent("A", []), store);
    const s = emptyAgentState(new Date("2026-10-09T18:00:03Z"));
    (hub as unknown as { state: typeof s }).state = s;
    hub.ingest("A", ev(2, "join_code", { code: "111111" })); // 18:00:02, older than state
    expect(hub.getState().server.joinCode).toBe("");
    hub.ingest("A", ev(5, "player_join", { name: "Freya" })); // 18:00:05
    expect(hub.getState().players.map((p) => p.name)).toEqual(["Freya"]);
  });
});

describe("Hub high-frequency events", () => {
  it("stores raids, never net_stats, and applies net_stats to state", () => {
    const store = new HistoryStore(":memory:");
    const hub = new Hub(fakeAgent("A", []), store);
    (hub as unknown as { state: ReturnType<typeof emptyAgentState> }).state = emptyAgentState(new Date("2026-10-09T17:00:00Z"));
    hub.ingest("A", ev(1, "net_stats", { connections: 1, zdos: 500, sent: 1, recv: 2 }));
    hub.ingest("A", ev(2, "net_stats", { connections: 1, zdos: 512, sent: 1, recv: 2 }));
    hub.ingest("A", ev(3, "raid", { name: "army_eikthyr" }));
    hub.ingest("A", ev(4, "raid", { name: "army_eikthyr" })); // a second raid is a new event
    expect(store.count()).toBe(2);
    expect(store.all().every((e) => e.type === "raid")).toBe(true);
    expect(hub.getState().server.netStats).toEqual({ connections: 1, zdos: 512, sent: 1, recv: 2 });
    expect(hub.history().events.map((e) => e.type)).toEqual(["raid", "raid"]);
  });
});

describe("Hub settings events", () => {
  it("stores settings events in history and keeps the header summary current", () => {
    const store = new HistoryStore(":memory:");
    const hub = new Hub(fakeAgent("A", []), store);
    const s = emptyAgentState(new Date("2026-10-09T17:00:00Z"));
    s.settings = { enabled: true, pending: false, armed: false, passwordSet: true };
    (hub as unknown as { state: typeof s }).state = s;
    hub.ingest("A", ev(1, "settings_changed", { changedKeys: ["name", "password"] }));
    expect(hub.getState().settings).toEqual({ enabled: true, pending: true, armed: false, passwordSet: true });
    hub.ingest("A", ev(2, "settings_apply", { state: "armed", mode: "when_empty" }));
    expect(hub.getState().settings?.armed).toBe(true);
    hub.ingest("A", ev(3, "settings_apply", { state: "applying", mode: "when_empty" }));
    hub.ingest("A", ev(4, "settings_apply", { state: "applied", mode: "when_empty" }));
    expect(hub.getState().settings).toEqual({ enabled: true, pending: false, armed: false, passwordSet: true });
    expect(store.all().map((e) => e.type)).toEqual(["settings_changed", "settings_apply", "settings_apply", "settings_apply"]);
    expect(hub.history().events).toHaveLength(4);
  });

  it("ignores settings events while the feature is off", () => {
    const hub = new Hub(fakeAgent("A", []), new HistoryStore(":memory:"));
    (hub as unknown as { state: ReturnType<typeof emptyAgentState> }).state = emptyAgentState(new Date("2026-10-09T17:00:00Z"));
    hub.ingest("A", ev(1, "settings_changed", { changedKeys: ["name"] }));
    expect(hub.getState().settings).toBeNull();
  });
});

describe("Hub bridge reads", () => {
  it("never stores, shows or emits a bridge read that reached the audit trail", () => {
    const store = new HistoryStore(":memory:");
    const hub = new Hub(fakeAgent("A", []), store);
    const seen: string[] = [];
    hub.subscribe((m) => m.type === "event" && seen.push(m.event.type));
    hub.ingest("A", ev(1, "admin", { actor: "dashboard-abc", command: "GET /v1/terrain/tile", result: "error", error: "too many terrain requests" }));
    hub.ingest("A", ev(2, "admin", { actor: "jarl", command: "broadcast", result: "ok", text: "hi" }));
    expect(store.all().map((e) => e.data.command)).toEqual(["broadcast"]);
    expect(seen).toEqual(["admin"]);
    // Rows stored by an older panel are hidden too.
    store.insert("A", ev(3, "admin", { actor: "dashboard-abc", command: "GET /v1/terrain/info", result: "error", error: "x" }));
    expect(hub.history().events.map((e) => e.data.command)).toEqual(["broadcast"]);
  });
});

describe("Hub history storage", () => {
  const DAY = 24 * 3_600_000;
  const at = (t: number, type: AgentEvent["type"], data: Record<string, unknown> = {}, seq = t): AgentEvent => ({
    seq,
    ts: new Date(t).toISOString(),
    type,
    data,
  });

  it("loads and parses the stored events once per window for the ranking and the profiles", () => {
    const store = new HistoryStore(":memory:");
    const now = Date.parse("2026-10-09T18:00:00Z");
    store.insert("A", at(now - 3_600_000, "player_join", { name: "Ragnar" }));
    let loads = 0;
    const all = store.all.bind(store);
    store.all = () => {
      loads += 1;
      return all();
    };
    let clock = now;
    const hub = new Hub(fakeAgent("A", []), store, { clock: () => clock });
    hub.history();
    hub.profiles();
    hub.history();
    hub.profiles();
    expect(loads).toBe(1);
    // A new stored event invalidates the shared load once, for both.
    (hub as unknown as { state: ReturnType<typeof emptyAgentState> }).state = emptyAgentState(new Date(now - DAY));
    hub.ingest("A", at(now, "death", { name: "Ragnar" }, 99));
    expect(hub.profiles()[0]!.deaths).toBe(1);
    expect(hub.history().players[0]!.deaths).toBe(1);
    expect(loads).toBe(2);
    clock += 5_000;
    hub.history();
    hub.profiles();
    expect(loads).toBe(3);
  });

  it("prunes week-old saves at startup and on a timer, never the play history", async () => {
    const store = new HistoryStore(":memory:");
    const now = Date.parse("2026-10-09T18:00:00Z");
    store.insert("A", at(now - 8 * DAY, "player_join", { name: "Freya" }));
    store.insert("A", at(now - 8 * DAY + 1, "world_saved", { ms: 1 }));
    store.insert("A", at(now - 7 * DAY + 30 * 60_000, "world_saved", { ms: 2 }));
    store.insert("A", at(now - DAY, "admin", { actor: "dashboard-abc", command: "GET /v1/terrain/info", result: "error" }));
    let clock = now;
    const hub = new Hub(fakeAgent("A", []), store, { clock: () => clock, pruneEveryMs: 10, statePollMs: 60_000 });
    expect(store.all().map((e) => e.type)).toEqual(["player_join", "world_saved"]);
    clock = now + 3_600_000;
    hub.start();
    await settle();
    hub.stop();
    // The fake agent's buffer was stored meanwhile; the second save is gone.
    expect(store.all().filter((e) => e.type === "world_saved")).toEqual([]);
    expect(store.all()[0]!.data).toEqual({ name: "Freya" });
    expect(hub.profiles().map((p) => p.name)).toContain("Freya");
  });

  it("starts even when the startup prune fails", () => {
    const store = new HistoryStore(":memory:");
    store.prune = () => {
      throw new Error("database or disk is full");
    };
    const warned: string[] = [];
    const log = { info: () => {}, warn: (msg: string) => void warned.push(msg), error: () => {} };
    expect(() => new Hub(fakeAgent("A", []), store, { log })).not.toThrow();
    expect(warned).toEqual(["history prune at startup failed"]);
  });
});

describe("Hub history deltas", () => {
  it("flags stored events and sends one rankings delta per burst, none for repeats or logs", async () => {
    const store = new HistoryStore(":memory:");
    const hub = new Hub(fakeAgent("A", []), store, { historyDeltaMs: 10 });
    (hub as unknown as { state: ReturnType<typeof emptyAgentState> }).state = emptyAgentState(new Date("2026-10-09T17:00:00Z"));
    const msgs: LiveMessage[] = [];
    const plain: LiveMessage[] = []; // the notifier, or a page from before deltas
    hub.subscribe((m) => msgs.push(m), { history: true });
    hub.subscribe((m) => plain.push(m));
    hub.ingest("A", ev(1, "join_code", { code: "111111" }));
    hub.ingest("A", ev(2, "player_join", { name: "Ragnar" }));
    hub.ingest("A", ev(3, "death", { name: "Ragnar" }));
    hub.ingest("A", ev(4, "join_code", { code: "111111" })); // unchanged: broadcast, not stored
    hub.ingest("A", ev(5, "log", { line: "x" }));
    const flags = msgs.flatMap((m) => (m.type === "event" ? [`${m.event.type}:${m.stored === true}`] : []));
    expect(flags).toEqual(["join_code:true", "player_join:true", "death:true", "join_code:false", "log:false"]);
    expect(msgs.some((m) => m.type === "history")).toBe(false);
    await settle();
    const deltas = msgs.filter((m) => m.type === "history");
    expect(deltas).toHaveLength(1);
    const d = deltas[0] as Extract<LiveMessage, { type: "history" }>;
    expect(d.players.map((p) => [p.name, p.deaths, p.online])).toEqual([["Ragnar", 1, true]]);
    expect(d).not.toHaveProperty("events");
    expect(plain.some((m) => m.type === "history")).toBe(false);
    expect(plain.filter((m) => m.type === "event")).toHaveLength(5);

    // Only repeats, logs and saga-only events since (a save changes no ranking): no new delta.
    hub.ingest("A", ev(6, "join_code", { code: "111111" }));
    hub.ingest("A", ev(7, "log", { line: "y" }));
    hub.ingest("A", ev(8, "world_saved", { ms: 120 }));
    hub.ingest("A", ev(9, "join_code", { code: "222222" }));
    await settle();
    expect(msgs.filter((m) => m.type === "history")).toHaveLength(1);
    hub.stop();
  });

  it("derives nothing when no page asked for deltas", async () => {
    const hub = new Hub(fakeAgent("A", []), new HistoryStore(":memory:"), { historyDeltaMs: 10 });
    (hub as unknown as { state: ReturnType<typeof emptyAgentState> }).state = emptyAgentState(new Date("2026-10-09T17:00:00Z"));
    let derives = 0;
    const history = hub.history.bind(hub);
    hub.history = () => (derives++, history());
    hub.subscribe(() => undefined);
    hub.ingest("A", ev(1, "player_join", { name: "Freya" }));
    await settle();
    expect(derives).toBe(0);
    hub.stop();
  });

  it("sends no delta after stop", async () => {
    const hub = new Hub(fakeAgent("A", []), new HistoryStore(":memory:"), { historyDeltaMs: 10 });
    (hub as unknown as { state: ReturnType<typeof emptyAgentState> }).state = emptyAgentState(new Date("2026-10-09T17:00:00Z"));
    const msgs: LiveMessage[] = [];
    hub.subscribe((m) => msgs.push(m), { history: true });
    hub.ingest("A", ev(1, "player_join", { name: "Freya" }));
    hub.stop();
    await settle();
    expect(msgs.filter((m) => m.type === "history")).toHaveLength(0);
  });
});
