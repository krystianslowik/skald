import { describe, expect, it } from "bun:test";
import { deriveHistory } from "../src/history";
import { addDays, calendar, deriveProfiles } from "../src/profiles";
import type { AgentEvent, AgentEventType, PlayerProfile } from "../src/types";

const H = 3_600_000;
let seq = 0;
const ev = (ts: string | number, type: AgentEventType, data: Record<string, unknown> = {}): AgentEvent => ({
  seq: ++seq,
  ts: new Date(ts).toISOString(),
  type,
  data,
});
const session = (name: string, from: string | number, to: string | number): AgentEvent[] => [
  ev(from, "player_join", { name }),
  ev(to, "player_leave", { name }),
];
// Most cases below were written against Europe/Berlin (DST in both directions);
// the zone is passed explicitly, exactly as SKALD_TZ would be.
const BERLIN = "Europe/Berlin";
const one = (events: AgentEvent[], now: string | number, name = "Ragnar", tz = BERLIN): PlayerProfile =>
  deriveProfiles(events, Date.parse(new Date(now).toISOString()), tz).find((p) => p.name === name)!;
const berlin = calendar(BERLIN);
const berlinDay = (t: number) => berlin.day(t);
const berlinTime = (day: string, h?: number, m?: number) => berlin.time(day, h, m);
const badge = (p: PlayerProfile, id: string) => p.badges.find((b) => b.id === id)!.earnedAt;
const dailyOf = (p: PlayerProfile, day: string) => p.daily.find((d) => d.day === day)?.ms;

describe("Berlin calendar helpers", () => {
  it("maps instants to Berlin days across CEST and CET", () => {
    expect(berlinDay(Date.parse("2026-10-08T21:59:59Z"))).toBe("2026-10-08");
    expect(berlinDay(Date.parse("2026-10-08T22:00:00Z"))).toBe("2026-10-09"); // CEST midnight
    expect(berlinDay(Date.parse("2026-01-10T22:59:59Z"))).toBe("2026-01-10");
    expect(berlinDay(Date.parse("2026-01-10T23:00:00Z"))).toBe("2026-01-11"); // CET midnight
    expect(new Date(berlinTime("2026-10-09")).toISOString()).toBe("2026-10-08T22:00:00.000Z");
    expect(new Date(berlinTime("2026-01-11")).toISOString()).toBe("2026-01-10T23:00:00.000Z");
    expect(new Date(berlinTime("2026-10-25", 4)).toISOString()).toBe("2026-10-25T03:00:00.000Z"); // after fall-back
    expect(new Date(berlinTime("2026-03-29", 4)).toISOString()).toBe("2026-03-29T02:00:00.000Z"); // after spring-forward
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("other time zones", () => {
  it("uses UTC days by default", () => {
    const p = deriveProfiles(session("Ragnar", "2026-10-08T21:30:00Z", "2026-10-08T22:30:00Z"), Date.parse("2026-10-09T12:00:00Z")).find((x) => x.name === "Ragnar")!;
    expect(dailyOf(p, "2026-10-08")).toBe(H);
    expect(dailyOf(p, "2026-10-09")).toBe(0);
  });

  it("maps days in a zone ahead of UTC without DST (Asia/Tokyo, +09:00)", () => {
    const tokyo = calendar("Asia/Tokyo");
    expect(tokyo.day(Date.parse("2026-10-08T14:59:59Z"))).toBe("2026-10-08");
    expect(tokyo.day(Date.parse("2026-10-08T15:00:00Z"))).toBe("2026-10-09");
    expect(new Date(tokyo.time("2026-10-09")).toISOString()).toBe("2026-10-08T15:00:00.000Z");
    const p = one(session("Ragnar", "2026-10-08T14:30:00Z", "2026-10-08T15:30:00Z"), "2026-10-09T12:00:00Z", "Ragnar", "Asia/Tokyo");
    expect(dailyOf(p, "2026-10-08")).toBe(0.5 * H);
    expect(dailyOf(p, "2026-10-09")).toBe(0.5 * H);
  });

  it("handles a zone behind UTC across its own DST change (America/New_York)", () => {
    const ny = calendar("America/New_York");
    expect(new Date(ny.time("2026-07-01")).toISOString()).toBe("2026-07-01T04:00:00.000Z"); // EDT
    expect(new Date(ny.time("2026-12-01")).toISOString()).toBe("2026-12-01T05:00:00.000Z"); // EST
    // 02:00-04:00 New York on the night clocks fall back (2026-11-01).
    const owl = one(session("Ragnar", "2026-11-01T05:00:00Z", "2026-11-01T09:30:00Z"), "2026-11-02T12:00:00Z", "Ragnar", "America/New_York");
    expect(badge(owl, "night_owl")).toBe("2026-11-01T09:00:00.000Z");
    // The same UTC evening that is "tomorrow" in Berlin is still "today" in New York.
    const p = one(session("Ragnar", "2026-10-08T22:30:00Z", "2026-10-08T23:00:00Z"), "2026-10-09T12:00:00Z", "Ragnar", "America/New_York");
    expect(dailyOf(p, "2026-10-08")).toBe(0.5 * H);
  });
});

describe("deriveProfiles", () => {
  it("splits a session at the Berlin midnight, not the UTC one (summer)", () => {
    const p = one(session("Ragnar", "2026-10-08T21:30:00Z", "2026-10-08T22:30:00Z"), "2026-10-09T12:00:00Z");
    expect(dailyOf(p, "2026-10-08")).toBe(0.5 * H);
    expect(dailyOf(p, "2026-10-09")).toBe(0.5 * H);
    expect(p.daily).toHaveLength(30);
    expect(p.daily.at(-1)!.day).toBe("2026-10-09");
    expect(p.currentStreak).toBe(2);
    expect(p.longestStreak).toBe(2);
  });

  it("splits at the CET midnight in winter", () => {
    const p = one(session("Ragnar", "2026-01-10T22:30:00Z", "2026-01-10T23:30:00Z"), "2026-01-11T12:00:00Z");
    expect(dailyOf(p, "2026-01-10")).toBe(0.5 * H);
    expect(dailyOf(p, "2026-01-11")).toBe(0.5 * H);
  });

  it("counts a late UTC evening as the next Berlin day", () => {
    const p = one(session("Ragnar", "2026-10-08T22:30:00Z", "2026-10-08T23:00:00Z"), "2026-10-09T12:00:00Z");
    expect(dailyOf(p, "2026-10-08")).toBe(0);
    expect(dailyOf(p, "2026-10-09")).toBe(0.5 * H);
    expect(p.longestStreak).toBe(1);
  });

  it("tracks streaks with a one-day grace for today and earns streak_7 on the 7th day", () => {
    // 20:00 Berlin (18:00Z) on Oct 1..7.
    const events = Array.from({ length: 7 }, (_, i) => session("Ragnar", `2026-10-0${i + 1}T18:00:00Z`, `2026-10-0${i + 1}T19:00:00Z`)).flat();
    const yesterdayGrace = one(events, "2026-10-08T12:00:00Z");
    expect(yesterdayGrace.longestStreak).toBe(7);
    expect(yesterdayGrace.currentStreak).toBe(7);
    expect(badge(yesterdayGrace, "streak_7")).toBe("2026-10-07T18:00:00.000Z");
    const broken = one(events, "2026-10-09T12:00:00Z");
    expect(broken.currentStreak).toBe(0);
    expect(broken.longestStreak).toBe(7);
    const six = one(events.slice(2), "2026-10-08T12:00:00Z");
    expect(six.longestStreak).toBe(6);
    expect(badge(six, "streak_7")).toBeNull();
  });

  it("earns night_owl only for a session covering 02:00-04:00 Berlin, including the DST night", () => {
    const now = "2026-10-26T12:00:00Z";
    expect(badge(one(session("Ragnar", "2026-10-09T23:30:00Z", "2026-10-10T02:10:00Z"), now), "night_owl")).toBe("2026-10-10T02:00:00.000Z");
    expect(badge(one(session("Ragnar", "2026-10-09T23:30:00Z", "2026-10-10T01:50:00Z"), now), "night_owl")).toBeNull();
    expect(badge(one(session("Ragnar", "2026-10-10T00:30:00Z", "2026-10-10T03:00:00Z"), now), "night_owl")).toBeNull(); // starts 02:30
    expect(badge(one(session("Ragnar", "2026-10-24T23:30:00Z", "2026-10-25T03:10:00Z"), now), "night_owl")).toBe("2026-10-25T03:00:00.000Z");
    expect(badge(one(session("Ragnar", "2026-01-10T00:30:00Z", "2026-01-10T03:00:00Z"), now), "night_owl")).toBe("2026-01-10T03:00:00.000Z"); // CET
  });

  it("earns unbroken for 5 death-free hours inside one session", () => {
    const t0 = Date.parse("2026-10-05T14:00:00Z");
    const ok = [ev(t0, "player_join", { name: "Ragnar" }), ev(t0 + 0.5 * H, "death", { name: "Ragnar" }), ev(t0 + 6 * H, "player_leave", { name: "Ragnar" })];
    expect(badge(one(ok, t0 + 7 * H), "unbroken")).toBe(new Date(t0 + 5.5 * H).toISOString());
    const no = [ev(t0, "player_join", { name: "Ragnar" }), ev(t0 + 3 * H, "death", { name: "Ragnar" }), ev(t0 + 6 * H, "player_leave", { name: "Ragnar" })];
    expect(badge(one(no, t0 + 7 * H), "unbroken")).toBeNull();
    // An open session counts up to now.
    expect(badge(one([ev(t0, "player_join", { name: "Ragnar" })], t0 + 5 * H), "unbroken")).toBe(new Date(t0 + 5 * H).toISOString());
  });

  it("earns first_blood, playtime milestones and raid_veteran", () => {
    const events = [
      ...session("Ragnar", "2026-10-01T10:00:00Z", "2026-10-01T16:00:00Z"),
      ev("2026-10-01T17:00:00Z", "raid", { name: "wolves" }), // nobody online
      ev("2026-10-02T10:00:00Z", "player_join", { name: "Ragnar" }),
      ev("2026-10-02T11:00:00Z", "death", { name: "Ragnar" }),
      ev("2026-10-02T12:00:00Z", "raid", { name: "army_eikthyr" }),
      ev("2026-10-02T16:00:00Z", "player_leave", { name: "Ragnar" }),
    ];
    const p = one(events, "2026-10-03T12:00:00Z");
    expect(badge(p, "first_blood")).toBe("2026-10-02T11:00:00.000Z");
    expect(badge(p, "hearth_10")).toBe("2026-10-02T14:00:00.000Z");
    expect(badge(p, "hearth_50")).toBeNull();
    expect(badge(p, "raid_veteran")).toBe("2026-10-02T12:00:00.000Z");
    expect(p.badges.map((b) => b.id)).toEqual(["first_blood", "hearth_10", "hearth_50", "night_owl", "unbroken", "raid_veteran", "streak_7"]);
    expect(p.deaths).toBe(1);
    expect(p.deathsPerHour).toBe(0.08);
    expect(p.longestSessionMs).toBe(6 * H);
    expect(p.firstSeen).toBe("2026-10-01T10:00:00.000Z");
    expect(p.lastSeen).toBe("2026-10-02T16:00:00.000Z");
  });

  it("agrees with deriveHistory on sessions, playtime and deaths", () => {
    const T0 = Date.parse("2026-10-09T18:00:00Z");
    const m = (min: number) => T0 + min * 60_000;
    const events = [
      ev(m(0), "player_join", { name: "Ragnar" }),
      ev(m(0), "player_count", { count: 1 }),
      ev(m(10), "player_join", { name: "Freya" }),
      ev(m(10), "player_join", { name: "Freya" }),
      ev(m(20), "death", { name: "Freya" }),
      ev(m(30), "player_count", { count: 0 }),
      ev(m(40), "player_join", { name: "Ragnar" }),
      ev(m(50), "server_state", { status: "stopping" }),
      ev(m(60), "player_join", { name: "Freya" }),
      ev(m(65), "death", { name: "Bjorn" }),
    ];
    const now = m(70);
    const h = deriveHistory(events, now);
    const profiles = deriveProfiles(events, now, BERLIN);
    expect(profiles.map((p) => p.name).sort()).toEqual(h.players.map((p) => p.name).sort());
    for (const hp of h.players) {
      const p = profiles.find((x) => x.name === hp.name)!;
      expect([p.sessions, p.playtimeMs, p.deaths, p.online, p.lastSeen]).toEqual([hp.sessions, hp.playtimeMs, hp.deaths, hp.online, hp.lastSeen]);
    }
  });
});
