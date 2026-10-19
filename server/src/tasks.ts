import { Database } from "bun:sqlite";
import { TASK_LIMITS, type Task, type TaskInput } from "./taskmodel";

export type TaskChange =
  | { ok: true; task: Task; /** The edit moved it to done from an open status. */ completed: boolean }
  | { ok: false; error: "not_found" | "too_many" };

/**
 * The group's shared tasks, in the panel database. Opened on its own
 * connection to the same file as the history (WAL lets the two share it), so
 * the history store stays as it is. Every change goes to the listeners with
 * the whole list: it is small, and a page that missed one change is whole
 * again with the next.
 */
export class TaskStore {
  private db: Database;
  private listeners = new Set<(tasks: Task[]) => void>();
  private cache: Task[] | null = null;

  constructor(path: string, private readonly clock: () => number = Date.now) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    // The history connection may be mid-write (a prune, a vacuum): wait rather than fail.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA secure_delete = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT NOT NULL
      );
    `);
  }

  /** Every task, oldest first. */
  list(): Task[] {
    this.cache ??= (this.db.query("SELECT id, data FROM tasks ORDER BY id").all() as { id: number; data: string }[]).map((r) => ({ ...(JSON.parse(r.data) as Task), id: r.id }));
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
    };
    const res = this.db.query("INSERT INTO tasks (data) VALUES (?)").run(JSON.stringify(task));
    const created = { ...task, id: Number(res.lastInsertRowid) };
    this.changed();
    return { ok: true, task: created, completed: status === "done" };
  }

  update(id: number, input: TaskInput): TaskChange {
    const prev = this.get(id);
    if (!prev) return { ok: false, error: "not_found" };
    const now = new Date(this.clock()).toISOString();
    const next: Task = { ...prev, ...input, id, updatedAt: now };
    const completed = prev.status !== "done" && next.status === "done";
    if (completed) next.doneAt = now;
    else if (next.status !== "done") next.doneAt = null;
    const { id: _, ...data } = next;
    this.db.query("UPDATE tasks SET data = ? WHERE id = ?").run(JSON.stringify(data), id);
    this.changed();
    return { ok: true, task: next, completed };
  }

  remove(id: number): boolean {
    const gone = this.db.query("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
    if (gone) this.changed();
    return gone;
  }

  /** Called with the whole list after every change. */
  subscribe(fn: (tasks: Task[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.cache = null;
    const tasks = this.list();
    for (const fn of this.listeners) {
      try {
        fn(tasks);
      } catch {
        // a broken socket must not stop the others
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
