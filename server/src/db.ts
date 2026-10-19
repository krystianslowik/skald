import { Database } from "bun:sqlite";
import { ROUTINE_EVENTS } from "./history";
import { isBridgeRead, type AgentEvent, type AgentEventType } from "./types";

interface Row {
  id: number;
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

  /** The connection, for the push store's tables in the same file (one writer). */
  get connection(): Database {
    return this.db;
  }

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    // Deleted and overwritten content (a removed Discord webhook) is zeroed, not left in free pages.
    this.db.exec("PRAGMA secure_delete = ON");
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
      CREATE INDEX IF NOT EXISTS events_type ON events (type, ts);
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

  /**
   * Deletes rows from before `cutoff` (epoch ms) that no derived view can
   * show again. Every all-time input to the profiles and the ranking is kept:
   * joins, leaves, deaths, raids, server states and the `player_count` 0 rows
   * that close sessions. Removed:
   *
   * - world saves and backups (the events list shows them for a week only);
   * - non-zero player counts, which only feed the 7-day players-online series,
   *   except the newest one before the cutoff, so the value the series starts
   *   from does not change.
   *
   * Times are read with `Date.parse`, as the folds read them. Returns the
   * number of rows deleted.
   */
  prune(cutoff: number): number {
    const ids: number[] = [];
    const before = (ts: string) => Date.parse(ts) < cutoff;
    const routine = this.db
      .query(`SELECT id, ts FROM events WHERE type IN (${ROUTINE_EVENTS.map(() => "?").join(", ")})`)
      .all(...ROUTINE_EVENTS) as Pick<Row, "id" | "ts">[];
    for (const r of routine) if (before(r.ts)) ids.push(r.id);

    // Kept: every 0, the newest readable count in fold order (the value the
    // series starts from) and the last inserted row (`last()`, on-change
    // dedupe). `count` is read as the folds read it: Number(), finite.
    const counts = this.db
      .query("SELECT id, ts, data FROM events WHERE type = 'player_count' ORDER BY ts DESC, id DESC")
      .all() as Pick<Row, "id" | "ts" | "data">[];
    const lastId = counts.reduce((a, r) => Math.max(a, r.id), 0);
    let newestValue = true;
    for (const r of counts) {
      if (!before(r.ts)) continue;
      const count = Number((JSON.parse(r.data) as Record<string, unknown>).count);
      const readable = Number.isFinite(count);
      const keep = r.id === lastId || (readable && (newestValue || count === 0));
      if (readable) newestValue = false;
      if (!keep) ids.push(r.id);
    }
    return this.remove(ids);
  }

  /**
   * Deletes the bridge reads that panels before 2026.10.1 stored. They are
   * never shown, and are no longer stored, so this runs once at startup.
   */
  pruneBridgeReads(): number {
    const admin = this.db.query("SELECT id, seq, ts, data FROM events WHERE type = 'admin'").all() as Row[];
    return this.remove(admin.filter((r) => isBridgeRead({ seq: r.seq, ts: r.ts, type: "admin", data: JSON.parse(r.data) })).map((r) => r.id));
  }

  private remove(ids: number[]): number {
    if (ids.length === 0) return 0;
    return this.db.query("DELETE FROM events WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids)).changes;
  }

  /** Gives the space of deleted rows back to the file system. */
  vacuum(): void {
    this.db.exec("VACUUM");
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

  /** Copies the journal into the database and truncates it, so nothing overwritten stays readable there. */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  /** The secure_delete setting, for tests. */
  secureDelete(): boolean {
    return (this.db.query("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete === 1;
  }

  close(): void {
    this.db.close();
  }
}
