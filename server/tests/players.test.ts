import { describe, expect, it } from "bun:test";
import { applyEvent } from "../src/apply";
import { deriveHistory } from "../src/history";
import { deriveProfiles } from "../src/profiles";
import { emptyAgentState, type AgentEvent, type AgentEventType } from "../src/types";

const T0 = Date.parse("2026-10-09T18:00:00Z");
let seq = 0;
const ev = (min: number, type: AgentEventType, data: Record<string, unknown> = {}): AgentEvent => ({
  seq: ++seq,
  ts: new Date(T0 + min * 60_000).toISOString(),
  type,
  data,
});

// Two players whose characters are both called Ragnar (#23): the agent tells
// them apart by id.
const twoRagnars = [
  ev(0, "player_join", { name: "Ragnar", id: "Ragnar", platform: "xbox" }),
  ev(10, "player_join", { name: "Ragnar", id: "Ragnar#2", platform: "steam" }),
  ev(20, "player_leave", { name: "Ragnar", id: "Ragnar#2" }),
];

describe("players sharing a name", () => {
  it("are two entries in the live state, and each leaves on its own", () => {
    let s = emptyAgentState();
    for (const e of twoRagnars.slice(0, 2)) s = applyEvent(s, e);
    expect(s.players.map((p) => `${p.id}/${p.platform}`)).toEqual(["Ragnar/xbox", "Ragnar#2/steam"]);
    s = applyEvent(s, twoRagnars[2]!);
    expect(s.players.map((p) => p.id)).toEqual(["Ragnar"]);
  });

  it("keep the first visit open in the history when the second leaves", () => {
    const h = deriveHistory(twoRagnars, T0 + 30 * 60_000);
    const r = h.players.find((p) => p.name === "Ragnar")!;
    expect(r.online).toBe(true);
    expect(r.sessions).toBe(2);
    // 30 min for the first, still on, plus 10 for the second.
    expect(r.playtimeMs).toBe(40 * 60_000);
  });

  it("keep the profile online when the second leaves", () => {
    const p = deriveProfiles(twoRagnars, T0 + 30 * 60_000, "UTC").find((x) => x.name === "Ragnar")!;
    expect(p.online).toBe(true);
  });

  it("still match by name for agents that send no id", () => {
    let s = emptyAgentState();
    s = applyEvent(s, ev(0, "player_join", { name: "Freya" }));
    s = applyEvent(s, ev(1, "player_join", { name: "Freya" }));
    expect(s.players).toHaveLength(1);
    s = applyEvent(s, ev(2, "player_leave", { name: "Freya" }));
    expect(s.players).toHaveLength(0);
  });
});

describe("player_platform", () => {
  it("corrects the platform of the live player and the profile (#19)", () => {
    const events = [
      ev(0, "player_join", { name: "Bjorn", id: "Bjorn", platform: "steam" }),
      ev(1, "player_platform", { name: "Bjorn", id: "Bjorn", platform: "xbox" }),
    ];
    let s = emptyAgentState();
    for (const e of events) s = applyEvent(s, e);
    expect(s.players.map((p) => p.platform)).toEqual(["xbox"]);
    expect(deriveProfiles(events, T0 + 5 * 60_000, "UTC").find((p) => p.name === "Bjorn")!.platform).toBe("xbox");
    // Not a saga line.
    expect(deriveHistory(events, T0 + 5 * 60_000).events.map((e) => e.type)).toEqual(["player_join"]);
  });

  it("ignores a player who is not online or an unknown platform", () => {
    let s = emptyAgentState();
    s = applyEvent(s, ev(0, "player_join", { name: "Astrid", id: "Astrid", platform: "steam" }));
    expect(applyEvent(s, ev(1, "player_platform", { name: "Freya", id: "Freya", platform: "xbox" }))).toBe(s);
    expect(applyEvent(s, ev(1, "player_platform", { name: "Astrid", id: "Astrid", platform: "gameboy" }))).toBe(s);
  });

  it("takes a join's platform only when it is one of the platforms", () => {
    const s = applyEvent(emptyAgentState(), ev(0, "player_join", { name: "Astrid", id: "Astrid", platform: "gameboy" }));
    expect(s.players).toEqual([{ id: "Astrid", name: "Astrid", since: new Date(T0).toISOString() }]);
  });
});
