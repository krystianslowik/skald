import { Database } from "bun:sqlite";
import type { AgentEvent, AgentEventType } from "./types";

interface Row {
  seq: number;
  ts: string;
  type: string;
  data: string;
}

/**
 * Notable-event history. Rows are keyed by (epoch, seq) where epoch is the
 * agent's `startedAt`: agent seq numbers restart with the agent, and a replay
 * from `since=0` must not duplicate rows.
 */
export class HistoryStore {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch TEXT NOT NULL,
        seq   INTEGER NOT NULL,
        ts    TEXT NOT NULL,
        type  TEXT NOT NULL,
        data  TEXT NOT NULL,
        UNIQUE (epoch, seq)
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  /** Returns true if the row was new. */
  insert(epoch: string, ev: AgentEvent): boolean {
    const res = this.db
      .query("INSERT OR IGNORE INTO events (epoch, seq, ts, type, data) VALUES (?, ?, ?, ?, ?)")
      .run(epoch, ev.seq, ev.ts, ev.type, JSON.stringify(ev.data));
    return res.changes > 0;
  }

  /** All events in insertion order (which follows agent order within an epoch). */
  all(): AgentEvent[] {
    const rows = this.db.query("SELECT seq, ts, type, data FROM events ORDER BY ts, id").all() as Row[];
    return rows.map((r) => ({ seq: r.seq, ts: r.ts, type: r.type as AgentEventType, data: JSON.parse(r.data) }));
  }

  /** Latest stored event of a type, for on-change dedupe after a restart. */
  last(type: AgentEventType): AgentEvent | null {
    const r = this.db
      .query("SELECT seq, ts, type, data FROM events WHERE type = ? ORDER BY id DESC LIMIT 1")
      .get(type) as Row | null;
    return r ? { seq: r.seq, ts: r.ts, type: r.type as AgentEventType, data: JSON.parse(r.data) } : null;
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  }

  getMeta(key: string): string | null {
    const r = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
