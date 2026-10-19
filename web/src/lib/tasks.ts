// The group's shared tasks. Kept outside React state like the live positions:
// the /live socket hands every change to `setTasks` (useValheim), and only
// the task board subscribes. A board that mounts before the socket has sent
// the list reads it once from /api/tasks.

import { useEffect, useSyncExternalStore } from "react";
import type { Task, TaskInput, TaskInputError } from "@server/taskmodel";
import { Unauthorized } from "./api";

export type { Task, TaskInput, TaskStatus, TaskTarget, TaskMaterial } from "@server/taskmodel";

let current: Task[] | null = null;
/** Bumped by every list from the socket: a read that started before one is older than it. */
let generation = 0;
const subs = new Set<() => void>();

function publish(next: Task[]): void {
  current = next;
  for (const f of subs) f();
}

/** Tasks the socket has reported gone: no late answer to this page's own write brings one back. */
const deleted = new Set<number>();

/** The whole list, as the server sent it over /live. */
export function setTasks(next: Task[]): void {
  generation += 1;
  const ids = new Set(next.map((t) => t.id));
  for (const t of current ?? []) if (!ids.has(t.id)) deleted.add(t.id);
  publish(next);
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
  const tasks = useSyncExternalStore(subscribe, () => current, () => current);
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
  | { ok: false; error: "unauthorized" | "invalid" | "too_many" | "not_found" | "busy" | "failed"; field?: TaskInputError };

async function send(method: string, path: string, body?: unknown): Promise<TaskResult> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "failed" };
  }
  if (res.status === 401) return { ok: false, error: "unauthorized" };
  let data: { task?: Task; error?: string; field?: TaskInputError } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    // an answer without a body: the status says enough
  }
  if (res.ok) return { ok: true, task: data.task };
  if (res.status === 400 && data.error === "invalid") return { ok: false, error: "invalid", field: data.field };
  if (res.status === 409 && data.error === "stale" && data.task) return { ok: false, error: "stale", task: data.task };
  if (res.status === 409) return { ok: false, error: "too_many" };
  if (res.status === 429 || res.status === 503) return { ok: false, error: "busy" };
  if (res.status === 404) return { ok: false, error: "not_found" };
  return { ok: false, error: "failed" };
}

export async function createTask(input: TaskInput): Promise<TaskResult> {
  const r = await send("POST", "/api/tasks", input);
  if (r.ok && r.task) upsert(r.task, true);
  return r;
}

/**
 * `rev`: the revision the edit started from. A status or material change
 * someone else overtook comes back `stale`, and the list takes the server's
 * copy at once.
 */
export async function updateTask(id: number, input: TaskInput, rev?: number): Promise<TaskResult> {
  const r = await send("PATCH", `/api/tasks/${id}`, rev === undefined ? input : { ...input, rev });
  if (r.ok && r.task) upsert(r.task, false);
  else if (!r.ok && r.error === "stale") upsert(r.task, false);
  return r;
}

export async function deleteTask(id: number): Promise<TaskResult> {
  const r = await send("DELETE", `/api/tasks/${id}`);
  if ((r.ok || r.error === "not_found") && current) publish(current.filter((t) => t.id !== id));
  return r;
}

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
  deleted.clear();
  generation = 0;
  reading = null;
}
