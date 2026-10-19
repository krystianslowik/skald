// The group's shared tasks. Kept outside React state like the live positions:
// the /live socket hands every change to `setTasks` (useValheim), and only
// the task board subscribes. A board that mounts before the socket has sent
// the list reads it once from /api/tasks.

import { useEffect, useSyncExternalStore } from "react";
import type { Task, TaskExpect, TaskInput, TaskInputError } from "@server/taskmodel";
import { Unauthorized } from "./api";
import { Optimistic, writeSignal } from "./optimistic";

export type { Task, TaskExpect, TaskInput, TaskStatus, TaskTarget, TaskMaterial } from "@server/taskmodel";
export { expectOf } from "@server/taskmodel";

/** The server's copies: the socket's list with every answer and frame since. */
let current: Task[] | null = null;
/** What the board shows: `current` with this page's pending changes on top. */
let shown: Task[] | null = null;
/** Bumped by every list from the socket: a read that started before one is older than it. */
let generation = 0;
const subs = new Set<() => void>();

function publish(next: Task[] | null = current): void {
  current = next;
  shown = next && next.flatMap((t) => optimistic.view(t.id, t) ?? []);
  for (const f of subs) f();
}

/** This page's changes still out: shown at once, taken back if the server refuses. */
const optimistic = new Optimistic<number, Task, TaskResult>({
  server: (id) => current?.find((t) => t.id === id),
  ok: (r) => r.ok,
  changed: () => publish(),
  thrown: () => ({ ok: false, error: "failed" }),
  gone: (id) => deleted.has(id),
});

/** Tasks the socket has reported gone: no late answer to this page's own write brings one back. */
const deleted = new Set<number>();

/** The whole list, as the server sent it over /live when the socket opened. */
export function setTasks(next: Task[]): void {
  generation += 1;
  const ids = new Set(next.map((t) => t.id));
  for (const t of current ?? []) if (!ids.has(t.id)) deleted.add(t.id);
  // Listed again (a frame from before a create, then a newer one): it lives.
  for (const id of ids) deleted.delete(id);
  publish(next);
}

/** One task added or changed, from /live. An older copy than the one shown is ignored. */
export function putTask(task: Task): void {
  // Before the first whole list there is nothing to change: that list (or the read) brings it.
  if (current === null) return;
  generation += 1;
  deleted.delete(task.id);
  const list = current ?? [];
  const have = list.find((t) => t.id === task.id);
  if (have && have.rev > task.rev) return;
  // The task moved on since a failed change here: its note no longer fits.
  if (have && task.rev > have.rev) optimistic.dismiss(task.id, true);
  publish(have ? list.map((t) => (t.id === task.id ? task : t)) : [...list, task]);
}

/** One task deleted, from /live. */
export function dropTask(id: number): void {
  if (current === null) return;
  generation += 1;
  deleted.add(id);
  optimistic.dismiss(id, true);
  if (current?.some((t) => t.id === id)) publish(current.filter((t) => t.id !== id));
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

let reading: Promise<void> | null = null;

/** GET /api/tasks, unless the socket answers first. */
function readTasks(onUnauthorized?: () => void): Promise<void> {
  const gen = generation;
  return (reading ??= fetch("/api/tasks", { credentials: "same-origin" })
    .then(async (res) => {
      if (res.status === 401) throw new Unauthorized();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tasks?: unknown };
      if (gen === generation && Array.isArray(body.tasks)) publish(body.tasks as Task[]);
    })
    .catch((e: unknown) => {
      if (e instanceof Unauthorized) onUnauthorized?.();
    })
    .finally(() => {
      reading = null;
    }));
}

/** Every task, or null until the first list arrives. */
export function useTasks(onUnauthorized?: () => void): Task[] | null {
  const tasks = useSyncExternalStore(subscribe, () => shown, () => shown);
  useEffect(() => {
    if (current === null) void readTasks(onUnauthorized);
  }, [onUnauthorized]);
  return tasks;
}

/**
 * Puts one task in the list at once, before the socket confirms. A newer
 * copy the socket already brought (someone else's edit right after this
 * one) is kept, and an edit answer never brings back a task the socket has
 * since reported deleted.
 */
function upsert(task: Task, created: boolean): void {
  if (deleted.has(task.id)) return;
  const list = current ?? [];
  const have = list.find((t) => t.id === task.id);
  if (have ? have.rev > task.rev : !created) return;
  publish(have ? list.map((t) => (t.id === task.id ? task : t)) : [...list, task]);
}

export type TaskResult =
  | { ok: true; task?: Task }
  /** `stale`: someone changed the task first; `task` is the server's copy now. */
  | { ok: false; error: "stale"; task: Task }
  /** Too many changes from this address: wait `retryAfter` seconds. */
  | { ok: false; error: "rate_limited"; retryAfter: number }
  | { ok: false; error: "unauthorized" | "invalid" | "too_many" | "not_found" | "failed"; field?: TaskInputError };

async function send(method: string, path: string, body?: unknown): Promise<TaskResult> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      // A request that never answers would hold the task's later changes forever.
      signal: writeSignal(),
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "failed" };
  }
  if (res.status === 401) return { ok: false, error: "unauthorized" };
  let data: { task?: Task; error?: string; field?: TaskInputError; retryAfter?: number } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    // an answer without a body: the status says enough
  }
  if (res.ok) return { ok: true, task: data.task };
  if (res.status === 400 && data.error === "invalid") return { ok: false, error: "invalid", field: data.field };
  if (res.status === 409 && data.error === "stale" && data.task) return { ok: false, error: "stale", task: data.task };
  if (res.status === 409) return { ok: false, error: "too_many" };
  if (res.status === 429) return { ok: false, error: "rate_limited", retryAfter: Number(res.headers.get("Retry-After")) || data.retryAfter || 60 };
  if (res.status === 404) return { ok: false, error: "not_found" };
  return { ok: false, error: "failed" };
}

export async function createTask(input: TaskInput): Promise<TaskResult> {
  const r = await send("POST", "/api/tasks", input);
  if (r.ok && r.task) upsert(r.task, true);
  return r;
}


/**
 * `expect`: the values the edit started from, for the status, owner and
 * materials it changes. If someone changed one of those first, the answer is
 * `stale` and the list takes the server's copy at once.
 */
export async function updateTask(id: number, input: TaskInput, expect?: TaskExpect): Promise<TaskResult> {
  const r = await send("PATCH", `/api/tasks/${id}`, expect && Object.keys(expect).length > 0 ? { ...input, expect } : input);
  if (r.ok && r.task) upsert(r.task, false);
  else if (!r.ok && r.error === "stale") upsert(r.task, false);
  return r;
}


export async function deleteTask(id: number): Promise<TaskResult> {
  const r = await send("DELETE", `/api/tasks/${id}`);
  if (r.ok || r.error === "not_found") {
    // Gone for good: an older /live frame or a late answer must not bring it back.
    deleted.add(id);
    if (current) publish(current.filter((t) => t.id !== id));
  }
  return r;
}

/**
 * Moves a task to `status` on the board at once, then saves it. The save
 * names the status the board showed at the tap, so a second tap right after
 * the first goes out once the first is in and still passes the guard;
 * someone else's change meanwhile is a `stale`, and the board shows theirs.
 */
export function setTaskStatus(id: number, status: Task["status"]): Promise<TaskResult> {
  const now = new Date().toISOString();
  return optimistic.run(
    id,
    // Already there (the /live frame came first): the server's copy, with its times, stays.
    (t) => (t.status === status ? t : { ...t, status, updatedAt: now, doneAt: status === "done" ? now : null }),
    (seen) => (seen ? updateTask(id, { status }, { status: seen.status }) : Promise.resolve<TaskResult>({ ok: false, error: "not_found" })),
  );
}

/** Takes a task off the board at once; it comes back if the server refuses. */
export function removeTask(id: number): Promise<TaskResult> {
  return optimistic.run(
    id,
    () => undefined,
    async () => {
      const r = await deleteTask(id);
      // Gone already is what was asked for.
      return !r.ok && r.error === "not_found" ? { ok: true } : r;
    },
    { chained: false },
  );
}

/** A result a dropped quick change got: the failure of the change before it, already reported there. */
export const taskResultRepeated = (r: TaskResult): boolean => optimistic.repeated(r);

/** A change to this task is still out. */
export const taskPending = (id: number): boolean => optimistic.pending(id);

/** Why the last quick change to this task failed, until the next one. */
export const taskFailure = (id: number): Exclude<TaskResult, { ok: true }> | undefined => {
  const r = optimistic.failure(id);
  return r && !r.ok ? r : undefined;
};

/**
 * What an edit changed against the task as it was opened, so saving one
 * field never undoes what someone else changed in another meanwhile.
 */
export function changedFields(before: Task, after: Required<TaskInput>): TaskInput {
  const out: TaskInput = {};
  if (after.title !== before.title) out.title = after.title;
  if (after.owner !== before.owner) out.owner = after.owner;
  if (after.status !== before.status) out.status = after.status;
  if (after.note !== before.note) out.note = after.note;
  if (JSON.stringify(after.target) !== JSON.stringify(before.target)) out.target = after.target;
  if (JSON.stringify(after.materials) !== JSON.stringify(before.materials)) out.materials = after.materials;
  return out;
}

/** The status a task's quick button moves it to: to do, then doing, then done; done reopens. */
export const nextStatus = (s: Task["status"]): Task["status"] => (s === "todo" ? "doing" : s === "doing" ? "done" : "todo");

/** Open tasks first (being done before still to do), newest change first within each; done ones last, latest done first. */
export function sortTasks(tasks: readonly Task[]): { open: Task[]; done: Task[] } {
  const rank = { doing: 0, todo: 1, done: 2 } as const;
  const open = tasks.filter((t) => t.status !== "done").sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
  const done = tasks.filter((t) => t.status === "done").sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? "") || b.id - a.id);
  return { open, done };
}

/** Tests: forget the list. */
export function resetTasks(): void {
  current = null;
  shown = null;
  optimistic.reset();
  deleted.clear();
  generation = 0;
  reading = null;
}
