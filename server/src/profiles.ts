import type { AgentEvent, Badge, DailyPlay, Platform, PlayerProfile } from "./types";

/**
 * Player profiles: per-player stats, daily playtime, streaks and badges,
 * folded from the stored notable events. Session boundaries follow
 * `deriveHistory` exactly (duplicate joins ignored, leave closes, player_count 0
 * and any non-running server state close everyone, open sessions run to now),
 * so the profile sheet and the ranking never disagree.
 *
 * Calendar days are days in the configured time zone (`SKALD_TZ`), always via
 * Intl with an explicit zone, never the host's local time.
 */

const HOUR = 3_600_000;
const DAY_MS = 86_400_000;
const DAILY_DAYS = 30;

const pad = (n: number) => String(n).padStart(2, "0");

/** Calendar arithmetic in one IANA time zone. */
export interface Calendar {
  readonly timeZone: string;
  /** Calendar day of an instant, `YYYY-MM-DD`. */
  day(t: number): string;
  /** UTC instant of a wall-clock time on `day` (two passes settle DST). */
  time(day: string, hour?: number, minute?: number): number;
}

const calendars = new Map<string, Calendar>();

export function calendar(timeZone = "UTC"): Calendar {
  const cached = calendars.get(timeZone);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const wall = (t: number) => {
    const p: Record<string, number> = {};
    for (const part of fmt.formatToParts(t)) if (part.type !== "literal") p[part.type] = Number(part.value);
    return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
  };
  /** Wall clock minus UTC at instant `t`, in ms. */
  const offset = (t: number) => {
    const w = wall(t);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - (t - (((t % 1000) + 1000) % 1000));
  };
  const cal: Calendar = {
    timeZone,
    day(t) {
      const w = wall(t);
      return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
    },
    time(day, hour = 0, minute = 0) {
      const [y, m, d] = splitDay(day);
      const guess = Date.UTC(y, m - 1, d, hour, minute);
      const first = guess - offset(guess);
      return guess - offset(first);
    },
  };
  calendars.set(timeZone, cal);
  return cal;
}

function splitDay(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y!, m!, d!];
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = splitDay(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const dayIndex = (day: string): number => {
  const [y, m, d] = splitDay(day);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

export interface Session {
  name: string;
  start: number;
  end: number;
  open: boolean;
}

interface Folded {
  sessions: Map<string, Session[]>;
  deaths: Map<string, number[]>;
  raids: number[];
  firstSeen: Map<string, number>;
  lastSeen: Map<string, number>;
  platforms: Map<string, Platform>;
}

const PLATFORMS: readonly Platform[] = ["xbox", "steam", "playstation", "nintendo", "unknown"];

/** Same open/close rules as `deriveHistory`. */
export function foldSessions(events: AgentEvent[], now: number): Folded {
  const sessions = new Map<string, Session[]>();
  const deaths = new Map<string, number[]>();
  const raids: number[] = [];
  const firstSeen = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  const platforms = new Map<string, Platform>();
  const open = new Map<string, number>();

  const seen = (name: string, at: number) => {
    if (!firstSeen.has(name)) firstSeen.set(name, at);
    lastSeen.set(name, at);
  };
  const push = (s: Session) => {
    const list = sessions.get(s.name) ?? [];
    list.push(s);
    sessions.set(s.name, list);
  };
  const close = (name: string, at: number) => {
    const start = open.get(name);
    if (start === undefined) return;
    open.delete(name);
    seen(name, at);
    push({ name, start, end: Math.max(start, at), open: false });
  };
  const closeAll = (at: number) => {
    for (const name of [...open.keys()]) close(name, at);
  };

  for (const ev of events) {
    const at = Date.parse(ev.ts);
    if (!Number.isFinite(at)) continue;
    const name = typeof ev.data.name === "string" ? ev.data.name : "";
    switch (ev.type) {
      case "player_join": {
        if (!name) break;
        if (!open.has(name)) {
          open.set(name, at);
          if (!sessions.has(name)) sessions.set(name, []);
        }
        seen(name, at);
        const p = ev.data.platform as Platform;
        if (PLATFORMS.includes(p) && (p !== "unknown" || !platforms.has(name))) platforms.set(name, p);
        break;
      }
      case "player_leave":
        if (name) close(name, at);
        break;
      case "death":
        if (!name) break;
        seen(name, at);
        deaths.set(name, [...(deaths.get(name) ?? []), at]);
        break;
      case "player_count":
        if (Number(ev.data.count) === 0) closeAll(at);
        break;
      case "server_state":
        if (ev.data.status !== "running") closeAll(at);
        break;
      case "raid":
        raids.push(at);
        break;
    }
  }
  for (const [name, start] of open) {
    push({ name, start, end: Math.max(start, now), open: true });
    lastSeen.set(name, now);
  }
  for (const list of sessions.values()) list.sort((a, b) => a.start - b.start);
  return { sessions, deaths, raids, firstSeen, lastSeen, platforms };
}

interface BadgeContext {
  cal: Calendar;
  sessions: Session[];
  deaths: number[];
  raids: number[];
  streak7At: number | null;
}

interface BadgeDef {
  id: string;
  /** Instant the badge was earned, or null while locked. */
  earned: (c: BadgeContext) => number | null;
}

/** Instant cumulative playtime crosses `ms`. */
function playtimeCrossing(sessions: Session[], ms: number): number | null {
  let before = 0;
  for (const s of sessions) {
    const len = s.end - s.start;
    if (before + len >= ms) return s.start + (ms - before);
    before += len;
  }
  return null;
}

/** First session covering a whole 02:00-04:00 local window; earned at 04:00. */
function nightOwl(cal: Calendar, sessions: Session[]): number | null {
  for (const s of sessions) {
    const last = dayIndex(cal.day(s.end));
    for (let day = cal.day(s.start); dayIndex(day) <= last; day = addDays(day, 1)) {
      const from = cal.time(day, 2);
      const to = cal.time(day, 4);
      if (s.start <= from && s.end >= to) return to;
    }
  }
  return null;
}

/** First 5 h stretch inside one session without a death; earned when the 5 h complete. */
function unbroken(sessions: Session[], deaths: number[]): number | null {
  const need = 5 * HOUR;
  for (const s of sessions) {
    const marks = [s.start, ...deaths.filter((d) => d >= s.start && d <= s.end), s.end];
    for (let i = 1; i < marks.length; i++) {
      if (marks[i]! - marks[i - 1]! >= need) return marks[i - 1]! + need;
    }
  }
  return null;
}

/**
 * Badge rules. Only ids go over the wire; the web app owns the label and
 * description in every language (`badge.<id>.label` / `.description`).
 */
export const BADGES: readonly BadgeDef[] = [
  { id: "first_blood", earned: (c) => c.deaths[0] ?? null },
  { id: "hearth_10", earned: (c) => playtimeCrossing(c.sessions, 10 * HOUR) },
  { id: "hearth_50", earned: (c) => playtimeCrossing(c.sessions, 50 * HOUR) },
  { id: "night_owl", earned: (c) => nightOwl(c.cal, c.sessions) },
  { id: "unbroken", earned: (c) => unbroken(c.sessions, c.deaths) },
  { id: "raid_veteran", earned: (c) => c.raids.find((r) => c.sessions.some((s) => s.start <= r && r <= s.end)) ?? null },
  { id: "streak_7", earned: (c) => c.streak7At },
];

function buildProfile(cal: Calendar, name: string, f: Folded, now: number): PlayerProfile {
  const sessions = f.sessions.get(name) ?? [];
  const deaths = f.deaths.get(name) ?? [];
  const playtimeMs = sessions.reduce((a, s) => a + (s.end - s.start), 0);

  // Split every session across local midnights.
  const perDay = new Map<string, { ms: number; first: number }>();
  for (const s of sessions) {
    let cursor = s.start;
    while (cursor < s.end) {
      const day = cal.day(cursor);
      const next = Math.min(s.end, cal.time(addDays(day, 1)));
      const d = perDay.get(day) ?? { ms: 0, first: cursor };
      d.ms += next - cursor;
      d.first = Math.min(d.first, cursor);
      perDay.set(day, d);
      cursor = next;
    }
  }

  const played = [...perDay.keys()].sort();
  let longestStreak = 0;
  let run = 0;
  let prev = Number.NaN;
  let streak7At: number | null = null;
  for (const day of played) {
    const idx = dayIndex(day);
    run = idx === prev + 1 ? run + 1 : 1;
    prev = idx;
    longestStreak = Math.max(longestStreak, run);
    if (run === 7 && streak7At === null) streak7At = perDay.get(day)!.first;
  }

  const today = cal.day(now);
  let currentStreak = 0;
  let cursorDay = perDay.has(today) ? today : addDays(today, -1);
  while (perDay.has(cursorDay)) {
    currentStreak += 1;
    cursorDay = addDays(cursorDay, -1);
  }

  const daily: DailyPlay[] = [];
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    daily.push({ day, ms: perDay.get(day)?.ms ?? 0 });
  }

  const ctx: BadgeContext = { cal, sessions, deaths, raids: f.raids, streak7At };
  const badges: Badge[] = BADGES.map((b) => {
    const at = b.earned(ctx);
    return { id: b.id, earnedAt: at === null ? null : new Date(at).toISOString() };
  });

  const iso = (t: number | undefined) => new Date(t ?? now).toISOString();
  return {
    name,
    online: sessions.some((s) => s.open),
    platform: f.platforms.get(name) ?? null,
    firstSeen: iso(f.firstSeen.get(name)),
    lastSeen: iso(f.lastSeen.get(name)),
    playtimeMs,
    sessions: sessions.length,
    longestSessionMs: sessions.reduce((a, s) => Math.max(a, s.end - s.start), 0),
    deaths: deaths.length,
    deathsPerHour: playtimeMs > 0 ? Math.round((deaths.length / (playtimeMs / HOUR)) * 100) / 100 : 0,
    currentStreak,
    longestStreak,
    daily,
    badges,
  };
}

/** Every known player's profile, most playtime first. Events must be ascending. */
export function deriveProfiles(events: AgentEvent[], now = Date.now(), timeZone = "UTC"): PlayerProfile[] {
  const f = foldSessions(events, now);
  const cal = calendar(timeZone);
  return [...f.firstSeen.keys()].map((name) => buildProfile(cal, name, f, now)).sort((a, b) => b.playtimeMs - a.playtimeMs);
}
