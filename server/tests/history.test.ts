import { describe, expect, it } from "bun:test";
import { deriveHistory } from "../src/history";
import type { AgentEvent, AgentEventType } from "../src/types";

const T0 = Date.parse("2026-10-09T18:00:00Z");
let seq = 0;
const ev = (min: number, type: AgentEventType, data: Record<string, unknown> = {}): AgentEvent => ({
  seq: ++seq,
  ts: new Date(T0 + min * 60_000).toISOString(),
  type,
  data,
});

describe("deriveHistory", () => {
  it("counts sessions, playtime, deaths and closes on count 0 / stop", () => {
    const events = [
      ev(0, "player_join", { name: "Ragnar" }),
      ev(0, "player_count", { count: 1 }),
      ev(10, "player_join", { name: "Freya" }),
      ev(10, "player_join", { name: "Freya" }), // duplicate join is ignored
      ev(20, "death", { name: "Freya" }),
      ev(30, "player_count", { count: 0 }),
      ev(40, "player_join", { name: "Ragnar" }),
      ev(50, "server_state", { status: "stopping" }),
      ev(60, "player_join", { name: "Freya" }),
    ];
    const h = deriveHistory(events, T0 + 70 * 60_000);
    const k = h.players.find((p) => p.name === "Ragnar")!;
    const w = h.players.find((p) => p.name === "Freya")!;
    expect(k.sessions).toBe(2);
    expect(k.playtimeMs).toBe(40 * 60_000);
    expect(k.online).toBe(false);
    expect(w.sessions).toBe(2);
    expect(w.deaths).toBe(1);
    expect(w.playtimeMs).toBe(30 * 60_000);
    expect(w.online).toBe(true);
    expect(h.events[0]!.type).toBe("player_join");
    expect(h.events.some((e) => e.type === "player_count")).toBe(false);
    expect(h.online7d.at(-1)![1]).toBe(1);
  });
});
