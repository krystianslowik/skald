import type { Context, Hono } from "hono";
import { RateLimiter } from "./auth";
import { jsonBody as readJson, writeLimit } from "./routehelp";
import { GUARDED_FIELDS, parseTaskInput, type Task, type TaskExpect } from "./taskmodel";
import type { TaskChange, TaskStore } from "./tasks";

/** A task with a full material list and note is about 2 KB; anything far past that is not one. */
const MAX_BODY = 16 * 1024;

export interface TaskRoutesDeps {
  store: Pick<TaskStore, "list" | "create" | "update" | "remove">;
  /** A task was marked done: the saga gets a line. */
  onDone?: (task: Task) => void;
  /** Writes per client: 30 a minute, then a minute's pause, by default. Reads are never limited. */
  limiter?: RateLimiter;
  /** Who a write counts against (the client address); one shared bucket without it. */
  clientKey?: (c: Context) => string;
}

const jsonBody = (c: Context) => readJson(c, MAX_BODY);

const taskId = (c: Context): number | null => {
  const raw = c.req.param("id") ?? "";
  return /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : null;
};

/**
 * The shared task board under /api/tasks. Mounted behind the panel's sign-in
 * and origin check; anyone with the panel password may change it (no admin
 * session), as the board is the group's, not the operator's. Each change
 * reaches every open page over /live (see TaskStore).
 */
export function mountTasks(app: Hono, deps: TaskRoutesDeps): void {
  const limiter = deps.limiter ?? new RateLimiter(30, 60_000, 60_000);
  const answer = (c: Context, task: Task, status: 200 | 201 = 200) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, task }, status);
  };
  /** A write's 429, or null when the client may write. */
  const limited = writeLimit(limiter, "tasks", deps.clientKey);
  const changed = (c: Context, res: TaskChange, created = false) => {
    if (!res.ok) {
      if (res.error === "stale") return c.json({ ok: false, error: "stale", task: res.task }, 409);
      return c.json({ ok: false, error: res.error }, res.error === "too_many" ? 409 : 404);
    }
    if (res.completed) deps.onDone?.(res.task);
    return answer(c, res.task, created ? 201 : 200);
  };

  app.get("/api/tasks", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ tasks: deps.store.list() });
  });

  app.post("/api/tasks", async (c) => {
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const input = parseTaskInput(body, false);
    if (!input.ok) return c.json({ ok: false, error: "invalid", field: input.error }, 400);
    const stop = limited(c);
    if (stop) return stop;
    return changed(c, deps.store.create(input.value), true);
  });

  app.patch("/api/tasks/:id", async (c) => {
    const id = taskId(c);
    if (id === null) return c.json({ ok: false, error: "not_found" }, 404);
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const input = parseTaskInput(body, true);
    if (!input.ok) return c.json({ ok: false, error: "invalid", field: input.error }, 400);
    // `expect`: what the page saw of the guarded fields it changes; a mismatch is a 409 with the current task.
    const rawExpect = (body as { expect?: unknown }).expect;
    let expect: TaskExpect = {};
    if (rawExpect !== undefined) {
      const picked = typeof rawExpect === "object" && rawExpect !== null ? Object.fromEntries(GUARDED_FIELDS.flatMap((f) => (f in rawExpect ? [[f, (rawExpect as Record<string, unknown>)[f]]] : []))) : null;
      const parsed = picked ? parseTaskInput(picked, true) : null;
      if (!parsed?.ok) return c.json({ ok: false, error: "invalid", field: "body" }, 400);
      expect = parsed.value as TaskExpect;
    }
    const stop = limited(c);
    if (stop) return stop;
    return changed(c, deps.store.update(id, input.value, expect));
  });

  app.delete("/api/tasks/:id", (c) => {
    const id = taskId(c);
    if (id === null) return c.json({ ok: false, error: "not_found" }, 404);
    const stop = limited(c);
    if (stop) return stop;
    if (!deps.store.remove(id)) return c.json({ ok: false, error: "not_found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true });
  });
}

/** The saga line's data for a finished task: its title and who did it, nothing else. */
export function doneEvent(task: Task): Record<string, unknown> {
  return task.owner ? { title: task.title, owner: task.owner } : { title: task.title };
}
