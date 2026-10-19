import { playerKey } from "./apply";
import type { AgentEvent } from "../types";

/** A save this slow (ms) is worth its own line, with a warning tone. */
export const SLOW_SAVE_MS = 2000;
const FOLD_MIN = 3;

export type SagaRow =
  /** One event as its own line; `slow` marks a save that took too long, `updated` a version that replaced another. */
  | { kind: "event"; key: string; e: AgentEvent; slow?: boolean; updated?: boolean }
  /** A join and its leave as one line; `leave` is unset while the visit is still on. Sits where it ended. */
  | { kind: "visit"; key: string; e: AgentEvent; name: string; join: AgentEvent; leave?: AgentEvent }
  /** A run of routine saves and backups on one day, newest first; `e` is the newest. */
  | { kind: "fold"; key: string; e: AgentEvent; events: AgentEvent[]; saves: number; backups: number };

export const eventKey = (e: AgentEvent) => `${e.ts}-${e.seq}-${e.type}`;

const isSlow = (e: AgentEvent) => e.type === "world_saved" && Number(e.data.ms) >= SLOW_SAVE_MS;
const isRoutine = (e: AgentEvent) => (e.type === "world_saved" && !isSlow(e)) || e.type === "world_backup";
const localDay = (ts: string) => new Date(ts).toDateString();

/**
 * Shapes the newest-first recent events into saga lines: a join and its leave
 * become one visit line, a version after a different one reads as an update,
 * and consecutive routine saves and backups of one day fold into a single row.
 * `online` (when known, the online players' ids, else names) is the truth
 * for a visit still being on; a join closed
 * by a server stop, or by a leave the window lost, stays a plain join line.
 */
export function sagaRows(newestFirst: AgentEvent[], online?: ReadonlySet<string>, dayOf: (ts: string) => string = localDay): SagaRow[] {
  const open = new Map<string, AgentEvent>();
  const visitOf = new Map<AgentEvent, AgentEvent>();
  const hidden = new Set<AgentEvent>();
  const updated = new Set<AgentEvent>();
  let version = "";
  for (let i = newestFirst.length - 1; i >= 0; i--) {
    const e = newestFirst[i]!;
    const name = typeof e.data.name === "string" ? e.data.name : "";
    switch (e.type) {
      case "player_join":
        if (!name) break;
        // A repeated join while the visit is on says nothing new (as in deriveHistory).
        if (open.has(playerKey(e.data))) hidden.add(e);
        else open.set(playerKey(e.data), e);
        break;
      case "player_leave": {
        const join = open.get(playerKey(e.data));
        if (!join) break;
        open.delete(playerKey(e.data));
        visitOf.set(e, join);
        hidden.add(join);
        break;
      }
      case "server_state":
        if (e.data.status !== "running") open.clear();
        break;
      case "version": {
        const v = String(e.data.version ?? "");
        if (version && v && v !== version) updated.add(e);
        if (v) version = v;
        break;
      }
    }
  }
  const openVisits = new Set<AgentEvent>();
  for (const [key, join] of open) {
    if (!online || online.has(key)) openVisits.add(join);
  }

  const rows: SagaRow[] = [];
  let run: AgentEvent[] = [];
  // A save with its backup beside it, or two saves, read fine as they are; three or more fold.
  const flush = () => {
    if (run.length < FOLD_MIN) for (const e of run) rows.push({ kind: "event", key: eventKey(e), e });
    else {
      const saves = run.filter((r) => r.type === "world_saved").length;
      // Keyed by the oldest line so the fold keeps its identity while new saves land on top.
      rows.push({ kind: "fold", key: `fold-${eventKey(run.at(-1)!)}`, e: run[0]!, events: run, saves, backups: run.length - saves });
    }
    run = [];
  };
  for (const e of newestFirst) {
    if (hidden.has(e)) continue;
    if (isRoutine(e)) {
      if (run.length > 0 && dayOf(run[0]!.ts) !== dayOf(e.ts)) flush();
      run.push(e);
      continue;
    }
    flush();
    const join = visitOf.get(e);
    const name = String(e.data.name ?? "");
    if (join) rows.push({ kind: "visit", key: eventKey(e), e, name, join, leave: e });
    else if (openVisits.has(e)) rows.push({ kind: "visit", key: eventKey(e), e, name, join: e });
    else rows.push({ kind: "event", key: eventKey(e), e, slow: isSlow(e) || undefined, updated: updated.has(e) || undefined });
  }
  flush();
  return rows;
}
