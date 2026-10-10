import { describe, expect, it } from "bun:test";
import type { AgentSource } from "../src/agent";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { emptyAgentState, type AgentEvent } from "../src/types";

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
    async settings() {
      return { status: 404, body: {} };
    },
    async map() {
      return { status: 404, etag: null, body: null };
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
