import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentEventType } from "../types";
import { sagaRows } from "./saga";

const T0 = Date.parse("2026-10-09T10:00:00Z");
let seq = 0;
const ev = (min: number, type: AgentEventType, data: Record<string, unknown> = {}): AgentEvent => ({
  seq: ++seq,
  ts: new Date(T0 + min * 60_000).toISOString(),
  type,
  data,
});
/** Newest first, as the history sends them. */
const feed = (...events: AgentEvent[]) => [...events].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
const sameDay = () => "d";

describe("sagaRows", () => {
  it("folds a run of saves and backups between two real events into one row", () => {
    const rows = sagaRows(
      feed(ev(0, "death", { name: "Freya" }), ev(30, "world_saved", { ms: 90 }), ev(60, "world_saved", { ms: 80 }), ev(61, "world_backup"), ev(90, "world_saved", { ms: 70 }), ev(100, "raid", { name: "wolves" }), ev(120, "world_saved", { ms: 60 }), ev(150, "world_saved", { ms: 60 }), ev(180, "world_saved", { ms: 60 })),
      undefined,
      sameDay,
    );
    expect(rows.map((r) => r.kind)).toEqual(["fold", "event", "fold", "event"]);
    const middle = rows[2]!;
    expect(middle.kind === "fold" && [middle.saves, middle.backups, middle.events.length]).toEqual([3, 1, 4]);
    expect(middle.e.ts).toBe(new Date(T0 + 90 * 60_000).toISOString());
  });

  it("leaves a save and its backup unfolded", () => {
    const rows = sagaRows(feed(ev(0, "world_backup"), ev(0, "world_saved", { ms: 90 }), ev(30, "death", { name: "Freya" })), undefined, sameDay);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  it("keeps a lone save and a slow save as their own lines", () => {
    const rows = sagaRows(feed(ev(0, "world_saved", { ms: 90 }), ev(30, "world_saved", { ms: 2400 }), ev(60, "world_saved", { ms: 80 })), undefined, sameDay);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
    expect(rows.map((r) => r.kind === "event" && Boolean(r.slow))).toEqual([false, true, false]);
  });

  it("splits a fold at the day boundary", () => {
    const saves = [0, 30, 60, 90, 120, 150].map((m) => ev(m, "world_saved"));
    const rows = sagaRows(feed(...saves), undefined, (ts) => (Date.parse(ts) < T0 + 75 * 60_000 ? "a" : "b"));
    expect(rows.map((r) => r.kind === "fold" && r.events.length)).toEqual([3, 3]);
  });

  it("keeps the fold key while new saves land on top", () => {
    const base = [ev(0, "world_saved"), ev(30, "world_saved"), ev(45, "world_backup")];
    const before = sagaRows(feed(...base), undefined, sameDay)[0]!;
    const after = sagaRows(feed(...base, ev(60, "world_saved")), undefined, sameDay)[0]!;
    expect(after.key).toBe(before.key);
  });

  it("pairs a join and its leave into one visit where it ended, deaths stay their own", () => {
    const join = ev(0, "player_join", { name: "Ragnar" });
    const leave = ev(64, "player_leave", { name: "Ragnar" });
    const rows = sagaRows(feed(join, ev(20, "death", { name: "Ragnar" }), ev(30, "world_saved"), ev(31, "world_backup"), ev(60, "world_saved"), leave), undefined, sameDay);
    expect(rows.map((r) => r.kind)).toEqual(["visit", "fold", "event"]);
    const visit = rows[0]!;
    expect(visit.kind === "visit" && [visit.name, visit.join, visit.leave]).toEqual(["Ragnar", join, leave]);
  });

  it("shows a visit still on at its join, and only for someone online", () => {
    const join = ev(0, "player_join", { name: "Freya" });
    const on = sagaRows(feed(join), new Set(["Freya"]), sameDay)[0]!;
    expect(on.kind === "visit" && on.leave).toBeUndefined();
    expect(on.kind).toBe("visit");
    expect(sagaRows(feed(join), new Set(), sameDay)[0]!.kind).toBe("event");
  });

  it("falls back to plain lines for a leave without a join and a join cut by a stop", () => {
    const rows = sagaRows(
      feed(ev(0, "player_leave", { name: "Bjorn" }), ev(10, "player_join", { name: "Freya" }), ev(20, "server_state", { status: "stopping" }), ev(30, "player_leave", { name: "Freya" })),
      undefined,
      sameDay,
    );
    expect(rows.map((r) => `${r.kind}:${r.e.type}`)).toEqual(["event:player_leave", "event:server_state", "event:player_join", "event:player_leave"]);
  });

  it("hides a repeated join while the visit is on", () => {
    const rows = sagaRows(feed(ev(0, "player_join", { name: "Freya" }), ev(5, "player_join", { name: "Freya" }), ev(40, "player_leave", { name: "Freya" })), undefined, sameDay);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === "visit" && rows[0]!.join.ts).toBe(new Date(T0).toISOString());
  });

  it("marks a version that replaced a different one as an update", () => {
    const rows = sagaRows(feed(ev(0, "version", { version: "l-1.0.19" }), ev(60, "version", { version: "l-1.0.19" }), ev(120, "version", { version: "l-1.0.20" })), undefined, sameDay);
    expect(rows.map((r) => r.kind === "event" && Boolean(r.updated))).toEqual([true, false, false]);
  });
});
