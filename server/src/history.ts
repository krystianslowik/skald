import { isBridgeRead, UNSTORED_EVENTS, type AgentEvent, type AgentEventType, type History, type PlayerStats, type SeriesPoint } from "./types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 200;
/** Routine bookkeeping: a save every 30 min and a backup every 2 h, ~60 lines a day. */
export const ROUTINE_EVENTS: readonly AgentEventType[] = ["world_saved", "world_backup"];
/** The types deriveHistory folds into the rankings and the 7-day series; the rest only reach the saga. */
export const RANKING_EVENTS: readonly AgentEventType[] = ["player_join", "player_leave", "death", "player_count", "server_state"];

/**
 * Caps a newest-first recent list so routine saves can never push real events
 * out: the newest `limit` non-routine events are kept, and routine ones only
 * inside the span those cover and at most a week back from `now`.
 */
export function capRecent(newestFirst: AgentEvent[], now = Date.now(), limit = RECENT_LIMIT): AgentEvent[] {
  let kept = 0;
  let cutoff = now - WEEK_MS;
  for (const e of newestFirst) {
    if (ROUTINE_EVENTS.includes(e.type)) continue;
    if (++kept === limit) {
      cutoff = Math.max(cutoff, Date.parse(e.ts));
      break;
    }
  }
  kept = 0;
  return newestFirst.filter((e) => (ROUTINE_EVENTS.includes(e.type) ? Date.parse(e.ts) >= cutoff : ++kept <= limit));
}

/**
 * Folds the stored notable events (ascending) into per-player sessions,
 * playtime, deaths, a recent-events list and a 7-day players-online step series.
 * Leave detection is count-based upstream, so `player_count == 0` and any
 * non-running server state close every open session.
 */
export function deriveHistory(events: AgentEvent[], now = Date.now()): History {
  const stats = new Map<string, PlayerStats>();
  const open = new Map<string, number>();
  const seriesStart = now - WEEK_MS;
  const series: SeriesPoint[] = [];
  let current = 0;
  let valueAtStart = 0;

  const stat = (name: string, ts: string): PlayerStats => {
    let s = stats.get(name);
    if (!s) {
      s = { name, sessions: 0, playtimeMs: 0, deaths: 0, lastSeen: ts, online: false };
      stats.set(name, s);
    }
    s.lastSeen = ts;
    return s;
  };
  const close = (name: string, at: number, ts: string) => {
    const start = open.get(name);
    if (start === undefined) return;
    open.delete(name);
    stat(name, ts).playtimeMs += Math.max(0, at - start);
  };
  const closeAll = (at: number, ts: string) => {
    for (const name of [...open.keys()]) close(name, at, ts);
  };
  const record = (at: number, value: number) => {
    if (value === current) return;
    current = value;
    if (at < seriesStart) valueAtStart = value;
    else series.push([at, value]);
  };

  for (const ev of events) {
    const at = Date.parse(ev.ts);
    if (!Number.isFinite(at)) continue;
    const name = typeof ev.data.name === "string" ? ev.data.name : "";
    switch (ev.type) {
      case "player_join":
        if (!name) break;
        if (!open.has(name)) {
          open.set(name, at);
          stat(name, ev.ts).sessions += 1;
        }
        record(at, Math.max(current, open.size));
        break;
      case "player_leave":
        if (!name) break;
        close(name, at, ev.ts);
        record(at, open.size);
        break;
      case "death":
        if (name) stat(name, ev.ts).deaths += 1;
        break;
      case "player_count": {
        const count = Number(ev.data.count);
        if (!Number.isFinite(count)) break;
        if (count === 0) closeAll(at, ev.ts);
        record(at, count);
        break;
      }
      case "server_state":
        if (ev.data.status !== "running") {
          closeAll(at, ev.ts);
          record(at, 0);
        }
        break;
    }
  }

  const nowIso = new Date(now).toISOString();
  for (const [name, start] of open) {
    const s = stat(name, nowIso);
    s.playtimeMs += Math.max(0, now - start);
    s.online = true;
  }

  const online7d: SeriesPoint[] = [[seriesStart, valueAtStart], ...series, [now, current]];
  const recent = capRecent(events.filter((e) => e.type !== "player_count" && !UNSTORED_EVENTS.includes(e.type) && !isBridgeRead(e)).reverse(), now);
  const players = [...stats.values()].sort((a, b) => b.playtimeMs - a.playtimeMs);
  return { players, events: recent, online7d };
}
