import { describe, expect, it, jest } from "bun:test";
import { deriveHistory } from "../src/history";
import { MockAgent, mockMetrics } from "../src/mock";
import type { AgentEvent, SettingsView } from "../src/types";

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

describe("MockAgent settings", () => {
  it("saves, waits for the fire to empty, then applies", async () => {
    jest.useFakeTimers();
    let now = Date.parse("2026-10-10T20:00:00Z");
    const m = new MockAgent(() => now);
    const tick = (ms: number) => {
      for (let i = 0; i < ms / 250; i++) {
        now += 250;
        jest.advanceTimersByTime(250);
      }
    };
    const seen: AgentEvent[] = [];
    const ac = new AbortController();
    void m.stream(1 << 30, (e) => seen.push(e), ac.signal);
    m.start();
    try {
      const view = (await m.settings({ op: "get" })).body as SettingsView;
      expect(view.current.modifiers).toEqual({ raids: "less", deathpenalty: "casual" });
      expect(view.current.unmanaged).toEqual(["-crossplay"]);
      expect(((await m.settings({ op: "password" })).body as { password: string }).password).toBe("hearth-77");

      // Invalid input: 400 with field errors, nothing changes.
      const bad = await m.settings({ op: "put", body: { ...view.current, name: "x" } });
      expect(bad.status).toBe(400);
      expect((bad.body as { errors: Record<string, string> }).errors).toEqual({ name: "length" });
      expect((await m.settings({ op: "apply", mode: "when_empty" })).status).toBe(409);

      const put = await m.settings({ op: "put", body: { ...view.current, name: "Hall of Ash", preset: "hard", modifiers: {} } });
      expect(put.status).toBe(200);
      expect((put.body as SettingsView).pending).toBe(true);
      expect(seen.find((e) => e.type === "settings_changed")?.data.changedKeys).toEqual(["name", "preset", "modifier.deathpenalty", "modifier.raids"]);

      const armed = await m.settings({ op: "apply", mode: "when_empty" });
      expect((armed.body as SettingsView).apply.armed).toBe(true);
      tick(1000);
      expect((await m.getState()).players.length).toBeGreaterThan(0);
      // Everyone leaves within a few seconds; the mock waits 6 s of empty, then restarts.
      const applied = () => seen.some((e) => e.type === "settings_apply" && e.data.state === "applied");
      let waited = 0;
      for (; waited < 40_000 && !applied(); waited += 1000) {
        if (seen.some((e) => e.type === "settings_apply" && e.data.state === "applying")) {
          // Once it fires the server was empty.
          expect(seen.filter((e) => e.type === "player_join")).toHaveLength(0);
        }
        tick(1000);
      }
      expect(applied()).toBe(true);
      expect(waited).toBeGreaterThan(10_000);
      const st = await m.getState();
      expect(st.server.name).toBe("Hall of Ash");
      expect(st.server.args).toBe("-preset hard -crossplay");
      expect(st.settings).toEqual({ enabled: true, pending: false, armed: false, passwordSet: true });
      const states = seen.filter((e) => e.type === "settings_apply").map((e) => e.data.state);
      expect(states).toEqual(["armed", "applying", "applied"]);
      // The password never rides on an event.
      expect(JSON.stringify(seen)).not.toContain("hearth-77");
    } finally {
      ac.abort();
      m.stop();
      jest.useRealTimers();
    }
  });

  it("cancels an armed apply", async () => {
    const m = new MockAgent();
    const view = (await m.settings({ op: "get" })).body as SettingsView;
    await m.settings({ op: "put", body: { ...view.current, public: false } });
    await m.settings({ op: "apply", mode: "when_empty" });
    const res = await m.settings({ op: "cancel" });
    expect((res.body as SettingsView).apply.armed).toBe(false);
    expect((await m.getState()).settings?.armed).toBe(false);
    m.stop();
  });
});

describe("MockAgent 1.0 crossplay", () => {
  it("joins with a platform, logs redacted 1.0 lines and knows the boss path", async () => {
    jest.useFakeTimers();
    let now = Date.parse("2026-10-10T20:00:00Z");
    const m = new MockAgent(() => now);
    const seen: AgentEvent[] = [];
    const ac = new AbortController();
    void m.stream(1 << 30, (e) => seen.push(e), ac.signal);
    m.start();
    try {
      for (let i = 0; i < 40; i++) {
        now += 250;
        jest.advanceTimersByTime(250);
      }
      const st = await m.getState();
      expect(st.players.map((p) => [p.name, p.platform])).toContainEqual(["Ragnar", "xbox"]);
      expect(st.world.meta?.bosses?.filter((b) => b.defeated).map((b) => b.key)).toEqual(["defeated_eikthyr", "defeated_gdking", "defeated_bonemass"]);
      expect(st.world.meta?.modifiers).toMatchObject({ resources: "muchmore", portals: "casual" });
      const join = seen.find((e) => e.type === "player_join");
      expect(join?.data).toEqual({ name: "Bjorn", id: "Bjorn", platform: "playstation" });
      const lines = seen.filter((e) => e.type === "log").map((e) => String(e.data.line));
      expect(lines.some((l) => /Player joined server ".*" that has join code \d+, now \d+ player\(s\)/.test(l))).toBe(true);
      expect(lines.some((l) => l.endsWith("received local Platform ID PlayStation_***"))).toBe(true);
      expect(lines.some((l) => /_\d{6,}|playfab\/[0-9A-F]{6,}/.test(l))).toBe(false);
    } finally {
      ac.abort();
      m.stop();
      jest.useRealTimers();
    }
  });
});
