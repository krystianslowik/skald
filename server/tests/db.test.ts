import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore } from "../src/db";
import { deriveHistory } from "../src/history";
import { deriveProfiles } from "../src/profiles";
import type { AgentEvent, AgentEventType } from "../src/types";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = Date.parse("2026-10-09T18:00:00Z");
const CUTOFF = NOW - 7 * DAY;

let seq = 0;
const ev = (at: number, type: AgentEventType, data: Record<string, unknown> = {}): AgentEvent => ({
  seq: ++seq,
  ts: new Date(at).toISOString(),
  type,
  data,
});

const fill = (events: AgentEvent[]): HistoryStore => {
  const store = new HistoryStore(":memory:");
  for (const e of events) store.insert("A", e);
  return store;
};
const types = (store: HistoryStore) => store.all().map((e) => `${e.type}:${JSON.stringify(e.data)}`);

describe("HistoryStore.prune", () => {
  it("drops world saves and backups older than the cutoff and keeps newer ones", () => {
    const store = fill([
      ev(NOW - 8 * DAY, "world_saved", { ms: 1 }),
      ev(NOW - 8 * DAY, "world_backup", { file: "old" }),
      ev(NOW - 6 * DAY, "world_saved", { ms: 2 }),
      ev(NOW - 1 * H, "world_backup", { file: "new" }),
    ]);
    expect(store.prune(CUTOFF)).toBe(2);
    expect(types(store)).toEqual(['world_saved:{"ms":2}', 'world_backup:{"file":"new"}']);
  });

  it("keeps every old event the profiles, the ranking or the events list can still use", () => {
    const old = NOW - 90 * DAY;
    const kept = [
      ev(old, "player_join", { name: "Ragnar", platform: "steam" }),
      ev(old + 1, "death", { name: "Ragnar" }),
      ev(old + 2, "raid", { name: "army_eikthyr" }),
      ev(old + 3, "player_leave", { name: "Ragnar" }),
      ev(old + 4, "server_state", { status: "stopped" }),
      ev(old + 5, "join_code", { code: "111111" }),
      ev(old + 6, "version", { version: "0.221.4", networkVersion: 36 }),
      ev(old + 7, "playfab", { state: "connected" }),
      ev(old + 8, "admin", { actor: "jarl", command: "broadcast", result: "ok" }),
      ev(old + 9, "settings_changed", { changedKeys: ["name"] }),
      ev(old + 10, "action", { action: "restart" }),
    ];
    const store = fill(kept);
    expect(store.prune(CUTOFF)).toBe(0);
    expect(store.count()).toBe(kept.length);
  });

  it("keeps old zero player counts and the newest count before the cutoff, drops the rest", () => {
    const old = NOW - 30 * DAY;
    const store = fill([
      ev(old, "player_count", { count: 2 }),
      ev(old + MIN, "player_count", { count: 0 }),
      ev(old + 2 * MIN, "player_count", { count: 3 }),
      ev(old + 3 * MIN, "player_count", { count: "x" }), // unreadable: no fold reads it
      ev(old + 4 * MIN, "player_count", { count: 1 }), // newest readable before the cutoff
      ev(old + 5 * MIN, "player_count", {}), // unreadable
      ev(NOW - DAY, "player_count", { count: 4 }), // inside the week
    ]);
    expect(store.prune(CUTOFF)).toBe(4);
    expect(types(store)).toEqual(['player_count:{"count":0}', 'player_count:{"count":1}', 'player_count:{"count":4}']);
  });

  it("keeps the last stored player count, which the restart dedupe reads", () => {
    const old = NOW - 30 * DAY;
    const store = fill([ev(old, "player_count", { count: 2 }), ev(old + MIN, "player_count", {})]);
    store.prune(CUTOFF);
    expect(store.last("player_count")!.data).toEqual({});
  });

  it("picks the newest count the folds can read, skipping a row with an unreadable time", () => {
    const old = NOW - 30 * DAY;
    const store = fill([ev(old, "player_count", { count: 2 }), ev(old + MIN, "player_count", { count: 3 })]);
    store.insert("A", { seq: ++seq, ts: "2026-09-09T18:30:00Zjunk", type: "player_count", data: { count: 5 } });
    store.insert("A", ev(NOW, "player_count", { count: 1 }));
    expect(store.prune(CUTOFF)).toBe(1);
    expect(types(store)).toEqual(['player_count:{"count":3}', 'player_count:{"count":5}', 'player_count:{"count":1}']);
  });

  it("drops bridge reads an older panel stored, whatever their age", () => {
    const store = fill([
      ev(NOW - H, "admin", { actor: "dashboard-abc", command: "GET /v1/terrain/info", result: "error" }),
      ev(NOW - H, "admin", { actor: "jarl", command: "broadcast", result: "ok" }),
    ]);
    expect(store.pruneBridgeReads()).toBe(1);
    expect(store.all().map((e) => e.data.command)).toEqual(["broadcast"]);
  });
});

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sixty days of a server: saves every 30 min, backups every 2 h, evenings of
 * play with joins, deaths, raids and player counts, sessions closed by a leave,
 * by count 0 alone or by a stop, a quiet stretch, and odd count payloads.
 */
function server(seed: number, end: number): AgentEvent[] {
  const r = rng(seed);
  const names = ["Ragnar", "Freya", "Bjorn", "Astrid"];
  const out: AgentEvent[] = [];
  const start = end - 60 * DAY;
  for (let t = start; t < end; t += 30 * MIN) {
    out.push(ev(t, "world_saved", { ms: 100 }));
    if ((t - start) % (2 * H) === 0) out.push(ev(t + 1000, "world_backup", { file: "b.zip" }));
  }
  for (let day = 0; day < 60; day++) {
    if (day >= 20 && day < 35) continue; // nobody plays for two weeks
    let t = start + day * DAY + 18 * H + Math.floor(r() * H);
    const online = new Set<string>();
    const steps = 4 + Math.floor(r() * 12);
    for (let i = 0; i < steps; i++) {
      t += Math.floor(r() * 50 * MIN);
      const name = names[Math.floor(r() * names.length)]!;
      const roll = r();
      if (roll < 0.4) {
        online.add(name);
        out.push(ev(t, "player_join", { name, platform: r() < 0.5 ? "steam" : "xbox" }));
        out.push(ev(t + 500, "player_count", { count: online.size }));
      } else if (roll < 0.6 && online.has(name)) {
        online.delete(name);
        if (r() < 0.7) out.push(ev(t, "player_leave", { name }));
        out.push(ev(t + 500, "player_count", { count: online.size }));
      } else if (roll < 0.75) {
        out.push(ev(t, "death", { name }));
      } else if (roll < 0.8) {
        out.push(ev(t, "raid", { name: "army_eikthyr" }));
      } else if (roll < 0.85) {
        out.push(ev(t, "player_count", r() < 0.5 ? {} : { count: "n/a" }));
      } else if (roll < 0.9) {
        out.push(ev(t, "join_code", { code: String(100000 + Math.floor(r() * 900000)) }));
      } else {
        out.push(ev(t, "player_count", { count: online.size + 1 })); // a count ahead of the joins
      }
    }
    // The evening ends with count 0 (no leave lines), a stop, or a player still on.
    const end = r();
    if (end < 0.5) out.push(ev(t + H, "player_count", { count: 0 }));
    else if (end < 0.8) out.push(ev(t + H, "server_state", { status: "stopped" }), ev(t + H + MIN, "server_state", { status: "running" }));
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

describe("prune keeps every derived view identical", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}`, () => {
      const end = NOW;
      const events = server(seed, end);
      const full = fill(events);
      const pruned = fill(events);
      const deleted = pruned.prune(end - 7 * DAY);
      expect(deleted).toBeGreaterThan(0);
      expect(pruned.count()).toBe(full.count() - deleted);
      // Derived right away and again later, after the cutoff moved on.
      for (const now of [end, end + 3 * H, end + 26 * H]) {
        expect(deriveHistory(pruned.all(), now)).toEqual(deriveHistory(full.all(), now));
        expect(deriveProfiles(pruned.all(), now, "Europe/Berlin")).toEqual(deriveProfiles(full.all(), now, "Europe/Berlin"));
      }
    });
  }
});

describe("HistoryStore storage", () => {
  it("zeroes deleted content and leaves no old webhook in the journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "skald-db-"));
    const path = join(dir, "skald.db");
    const secret = "fictional-webhook-token-of-Freya-0123456789";
    try {
      const store = new HistoryStore(path);
      expect(store.secureDelete()).toBe(true);
      store.setMeta("discord.url", `https://discord.com/api/webhooks/1/${secret}`);
      store.setMeta("discord.url", "");
      store.checkpoint();
      expect(statSync(`${path}-wal`).size).toBe(0);
      expect(readFileSync(path).includes(secret)).toBe(false);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
