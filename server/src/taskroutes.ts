import type { Context, Hono } from "hono";
import { RateLimiter } from "./auth";
import { parseTaskInput, type Task } from "./taskmodel";
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

/** The database stayed locked past the connection's short wait. */
const isBusy = (e: unknown) => {
  const x = e as { code?: unknown; message?: unknown } | null;
  return x?.code === "SQLITE_BUSY" || (typeof x?.message === "string" && /database is locked|SQLITE_BUSY/.test(x.message));
};

/** A JSON object body, or the 4xx to answer. JSON only: a cross-site form cannot send it without a preflight. */
async function jsonBody(c: Context): Promise<unknown | Response> {
  if (!/^application\/json\b/i.test(c.req.header("Content-Type") ?? "")) return c.json({ ok: false, error: "bad request body" }, 415);
  if (Number(c.req.header("Content-Length") ?? 0) > MAX_BODY) return c.json({ ok: false, error: "body too large" }, 413);
  let raw = "";
  try {
    raw = await c.req.text();
  } catch {
    return c.json({ ok: false, error: "bad request body" }, 400);
  }
  if (raw.length > MAX_BODY) return c.json({ ok: false, error: "body too large" }, 413);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return c.json({ ok: false, error: "bad request body" }, 400);
  }
}

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
  const limited = (c: Context) => {
    const wait = limiter.hit(`tasks:${deps.clientKey?.(c) ?? "all"}`);
    return wait > 0 ? c.json({ ok: false, error: "rate_limited", retryAfter: wait }, 429, { "Retry-After": String(wait) }) : null;
  };
  /** Runs a store write; a database still locked after its short wait is a 503 to retry, not a 500. */
  const write = <T>(c: Context, fn: () => T): T | Response => {
    try {
      return fn();
    } catch (e) {
      if (isBusy(e)) return c.json({ ok: false, error: "busy" }, 503, { "Retry-After": "1" });
      throw e;
    }
  };
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
    const res = write(c, () => deps.store.create(input.value));
    return res instanceof Response ? res : changed(c, res, true);
  });

  app.patch("/api/tasks/:id", async (c) => {
    const id = taskId(c);
    if (id === null) return c.json({ ok: false, error: "not_found" }, 404);
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const input = parseTaskInput(body, true);
    if (!input.ok) return c.json({ ok: false, error: "invalid", field: input.error }, 400);
    const rev = (body as { rev?: unknown }).rev;
    if (rev !== undefined && !(typeof rev === "number" && Number.isInteger(rev) && rev >= 0)) return c.json({ ok: false, error: "invalid", field: "body" }, 400);
    const stop = limited(c);
    if (stop) return stop;
    const res = write(c, () => deps.store.update(id, input.value, rev as number | undefined));
    return res instanceof Response ? res : changed(c, res);
  });

  app.delete("/api/tasks/:id", (c) => {
    const id = taskId(c);
    if (id === null) return c.json({ ok: false, error: "not_found" }, 404);
    const stop = limited(c);
    if (stop) return stop;
    const gone = write(c, () => deps.store.remove(id));
    if (gone instanceof Response) return gone;
    if (!gone) return c.json({ ok: false, error: "not_found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true });
  });
}

/** The saga line's data for a finished task: its title and who did it, nothing else. */
export function doneEvent(task: Task): Record<string, unknown> {
  return task.owner ? { title: task.title, owner: task.owner } : { title: task.title };
}
