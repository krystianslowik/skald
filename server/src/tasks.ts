import { Database } from "bun:sqlite";
import { TASK_LIMITS, type Task, type TaskInput } from "./taskmodel";

/** Fields an edit may only change from the value it saw: two players claiming a task, moving it on, or changing its list at once. */
export const GUARDED_FIELDS = ["status", "owner", "materials"] as const;
export type GuardedField = (typeof GUARDED_FIELDS)[number];
/** The values an edit started from, for the guarded fields it changes. */
export type TaskExpect = Partial<Pick<Task, GuardedField>>;

export type TaskChange =
  | {
      ok: true;
      task: Task;
      /** The change finished the task for the first time: worth a saga line. Reopening and finishing it again is not. */
      completed: boolean;
    }
  | { ok: false; error: "not_found" | "too_many" }
  /** Someone changed a guarded field this edit also changes, after the edit's page saw it: `task` is the current one. */
  | { ok: false; error: "stale"; task: Task };

/** One change, as the pages receive it: a task added or changed, or one gone. */
export type TaskEvent = { kind: "put"; task: Task } | { kind: "gone"; id: number };

/** The table's layout version, kept in the shared `meta` table for a later migration to read. */
const SCHEMA_VERSION = 1;
const SCHEMA_KEY = "tasks.schema";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The group's shared tasks, in the panel database, on the history store's
 * connection (one writer for the file, like the push store). Each change goes
 * to the listeners as one task put or gone; the whole list is `list()`.
 */
export class TaskStore {
  private db: Database;
  private listeners = new Set<(ev: TaskEvent) => void>();
  private cache: Task[] | null = null;
  /** Tasks the saga already has a line for; kept in the row as `logged`, never sent. */
  private logged = new Set<number>();

  /** `db`: the history store's connection; a path opens its own (tests). */
  constructor(db: Database | string, private readonly clock: () => number = Date.now) {
    this.db = typeof db === "string" ? new Database(db, { create: true }) : db;
    if (typeof db === "string") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA secure_delete = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.db.query("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(SCHEMA_KEY, String(SCHEMA_VERSION));
  }

  schemaVersion(): number {
    return Number((this.db.query("SELECT value FROM meta WHERE key = ?").get(SCHEMA_KEY) as { value: string } | null)?.value ?? 0);
  }

  /** Every task, oldest first. */
  list(): Task[] {
    if (!this.cache) {
      const rows = this.db.query("SELECT id, data FROM tasks ORDER BY id").all() as { id: number; data: string }[];
      this.logged.clear();
      this.cache = rows.map((r) => {
        const { logged, ...task } = JSON.parse(r.data) as Task & { logged?: boolean };
        if (logged) this.logged.add(r.id);
        return { ...task, rev: task.rev ?? 0, id: r.id };
      });
    }
    return this.cache;
  }

  get(id: number): Task | null {
    return this.list().find((t) => t.id === id) ?? null;
  }

  /** `input` must have passed `parseTaskInput` as a create (it has a title). */
  create(input: TaskInput): TaskChange {
    if (this.list().length >= TASK_LIMITS.tasks) return { ok: false, error: "too_many" };
    const now = new Date(this.clock()).toISOString();
    const status = input.status ?? "todo";
    const task: Omit<Task, "id"> = {
      title: input.title ?? "",
      owner: input.owner ?? "",
      status,
      note: input.note ?? "",
      target: input.target ?? null,
      materials: input.materials ?? [],
      createdAt: now,
      updatedAt: now,
      doneAt: status === "done" ? now : null,
      rev: 0,
    };
    // Already done when added (old work written down): no saga line, now or later.
    const done = status === "done";
    const res = this.db.query("INSERT INTO tasks (data) VALUES (?)").run(JSON.stringify(done ? { ...task, logged: true } : task));
    const created = { ...task, id: Number(res.lastInsertRowid) };
    if (done) this.logged.add(created.id);
    this.changed([...this.list(), created], { kind: "put", task: created });
    return { ok: true, task: created, completed: false };
  }

  /**
   * `expect`: the values the edit started from, for the guarded fields it
   * changes (status, owner, materials). One that no longer matches makes the
   * edit stale: someone moved the task on, claimed it, or changed its list
   * meanwhile. Title, note and target go to the last writer.
   */
  update(id: number, input: TaskInput, expect: TaskExpect = {}): TaskChange {
    const prev = this.get(id);
    if (!prev) return { ok: false, error: "not_found" };
    for (const f of GUARDED_FIELDS) {
      if (input[f] !== undefined && expect[f] !== undefined && !same(prev[f], expect[f])) return { ok: false, error: "stale", task: prev };
    }
    const now = new Date(this.clock()).toISOString();
    const next: Task = { ...prev, ...input, id, updatedAt: now, rev: prev.rev + 1 };
    const finished = prev.status !== "done" && next.status === "done";
    if (finished) next.doneAt = now;
    else if (next.status !== "done") next.doneAt = null;
    // One saga line per task: a task cycled through done again stays quiet.
    const completed = finished && !this.logged.has(id);
    const logged = completed || this.logged.has(id);
    const { id: _, ...data } = next;
    this.db.query("UPDATE tasks SET data = ? WHERE id = ?").run(JSON.stringify(logged ? { ...data, logged: true } : data), id);
    // Only once the row is written: a failed write leaves the line still to come.
    if (completed) this.logged.add(id);
    this.changed(
      this.list().map((t) => (t.id === id ? next : t)),
      { kind: "put", task: next },
    );
    return { ok: true, task: next, completed };
  }

  remove(id: number): boolean {
    const gone = this.db.query("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
    if (gone) {
      this.logged.delete(id);
      this.changed(
        this.list().filter((t) => t.id !== id),
        { kind: "gone", id },
      );
    }
    return gone;
  }

  /** Called with every change. */
  subscribe(fn: (ev: TaskEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The list after a change, patched in place of a reread. */
  private changed(tasks: Task[], ev: TaskEvent): void {
    this.cache = tasks;
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        // a broken socket must not stop the others
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
