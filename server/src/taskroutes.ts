import type { Context, Hono } from "hono";
import { parseTaskInput, type Task } from "./taskmodel";
import type { TaskStore } from "./tasks";

/** A task with a full material list and note is about 2 KB; anything far past that is not one. */
const MAX_BODY = 16 * 1024;

export interface TaskRoutesDeps {
  store: Pick<TaskStore, "list" | "create" | "update" | "remove">;
  /** A task was marked done: the saga gets a line. */
  onDone?: (task: Task) => void;
}

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
  const answer = (c: Context, task: Task, status: 200 | 201 = 200) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, task }, status);
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
    const res = deps.store.create(input.value);
    if (!res.ok) return c.json({ ok: false, error: res.error }, 409);
    if (res.completed) deps.onDone?.(res.task);
    return answer(c, res.task, 201);
  });

  app.patch("/api/tasks/:id", async (c) => {
    const id = taskId(c);
    if (id === null) return c.json({ ok: false, error: "not_found" }, 404);
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const input = parseTaskInput(body, true);
    if (!input.ok) return c.json({ ok: false, error: "invalid", field: input.error }, 400);
    const res = deps.store.update(id, input.value);
    if (!res.ok) return c.json({ ok: false, error: res.error }, 404);
    if (res.completed) deps.onDone?.(res.task);
    return answer(c, res.task);
  });

  app.delete("/api/tasks/:id", (c) => {
    const id = taskId(c);
    if (id === null || !deps.store.remove(id)) return c.json({ ok: false, error: "not_found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true });
  });
}

/** The saga line's data for a finished task: its title and who did it, nothing else. */
export function doneEvent(task: Task): Record<string, unknown> {
  return task.owner ? { title: task.title, owner: task.owner } : { title: task.title };
}
