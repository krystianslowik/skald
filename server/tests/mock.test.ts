import { describe, expect, it } from "bun:test";
import { deriveHistory } from "../src/history";
import { MockAgent, mockMetrics } from "../src/mock";
import type { AgentEvent } from "../src/types";

describe("MockAgent", () => {
  it("seeds a consistent week of history", async () => {
    const m = new MockAgent();
    const events: AgentEvent[] = [];
    const ac = new AbortController();
    const done = m.stream(0, (e) => events.push(e), ac.signal);
    ac.abort();
    await done;
    expect(events.length).toBeGreaterThan(20);
    const h = deriveHistory(events);
    expect(h.players.length).toBeGreaterThan(1);
    expect(h.players.filter((p) => p.online).map((p) => p.name).sort()).toEqual(["Freya", "Ragnar"]);
    expect(h.events.some((e) => e.type === "raid")).toBe(true);
    const st = await m.getState();
    expect(st.world.meta?.seedName).toBe("ZbzIWkK5KK");
    expect(st.server.netStats).toBeNull();
    expect(mockMetrics().cpu).toHaveLength(360);
    const r = await m.action("update");
    expect(r.status).toBe(200);
    expect((await m.action("backup")).status).toBe(409);
    m.stop();
  });
});
