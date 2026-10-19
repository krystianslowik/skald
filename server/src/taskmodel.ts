// Shared tasks: the shape, the input rules and the shopping list. Kept free
// of Bun/Node imports: the web package compiles it via `@server/*`, so the
// browser checks a form with the same rules the server enforces, and both
// sides subtract the stores the same way.

export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** What a task works towards: a boss (its global key) or a base, by the name the group calls it. */
export type TaskTarget = { kind: "boss"; key: string } | { kind: "base"; name: string };

/** One line of a task's material list: an item prefab and how many are needed. */
export interface TaskMaterial {
  item: string;
  qty: number;
}

export interface Task {
  id: number;
  title: string;
  /** Who took it on; "" while nobody has. Free text: the panel has one shared password, no accounts. */
  owner: string;
  status: TaskStatus;
  note: string;
  target: TaskTarget | null;
  materials: TaskMaterial[];
  createdAt: string;
  updatedAt: string;
  /** Counts the task's changes from 0; an edit names the one it started from, so a stale one is refused. */
  rev: number;
  /** When it was last marked done; null while open. */
  doneAt: string | null;
}

/** Fields an edit may only change from the value it saw: two players claiming a task, moving it on, or changing its list at once. */
export const GUARDED_FIELDS = ["status", "owner", "materials"] as const;
export type GuardedField = (typeof GUARDED_FIELDS)[number];
/** The values an edit started from, for the guarded fields it changes. */
export type TaskExpect = Partial<Pick<Task, GuardedField>>;

/** Same value, by content (a material list as much as a name). */
export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The guarded fields an edit changes, as they were before it. */
export function expectOf(before: Task, diff: TaskInput): TaskExpect {
  const out: TaskExpect = {};
  for (const f of GUARDED_FIELDS) if (diff[f] !== undefined) (out as Record<string, unknown>)[f] = before[f];
  return out;
}

/** The fields a create or an edit may carry; an edit carries only what changes. */
export interface TaskInput {
  title?: string;
  owner?: string;
  status?: TaskStatus;
  note?: string;
  target?: TaskTarget | null;
  materials?: TaskMaterial[];
}

export const TASK_LIMITS = {
  title: 80,
  owner: 40,
  note: 500,
  baseName: 40,
  materials: 30,
  qty: 99_999,
  /** Open and done together: a board, not an archive. */
  tasks: 200,
} as const;

/** An item prefab as the agent names it ("Wood", "SurtlingCore"); never a path or markup. */
export const ITEM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** A boss's global key ("defeated_eikthyr"). */
export const BOSS_KEY = /^defeated_[a-z0-9_]{1,40}$/;

export type TaskInputError = "title" | "owner" | "status" | "note" | "target" | "materials" | "body";
export type TaskParse = { ok: true; value: TaskInput } | { ok: false; error: TaskInputError };

/** Code points, so a name in any script is measured the way it reads. */
const len = (s: string) => [...s].length;

/** No control characters except newlines in a note. */
function clean(s: string, newlines: boolean): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x0a && newlines) continue;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** Trimmed, tabs (pasted from a table) as spaces; null when not a string, too long, or holding control characters. */
function text(v: unknown, max: number, newlines = false): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\t/g, " ").trim();
  return len(s) <= max && clean(s, newlines) ? s : null;
}

function target(v: unknown): TaskTarget | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const t = v as Record<string, unknown>;
  if (t.kind === "boss" && typeof t.key === "string" && BOSS_KEY.test(t.key)) return { kind: "boss", key: t.key };
  if (t.kind === "base") {
    const name = text(t.name, TASK_LIMITS.baseName);
    if (name) return { kind: "base", name };
  }
  return undefined;
}

/** Same item twice adds up; lines keep the order they were first given in. */
function materials(v: unknown): TaskMaterial[] | null {
  if (!Array.isArray(v) || v.length > TASK_LIMITS.materials) return null;
  const out = new Map<string, number>();
  for (const m of v) {
    if (typeof m !== "object" || m === null) return null;
    const { item, qty } = m as Record<string, unknown>;
    if (typeof item !== "string" || !ITEM_NAME.test(item)) return null;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > TASK_LIMITS.qty) return null;
    out.set(item, Math.min(TASK_LIMITS.qty, (out.get(item) ?? 0) + qty));
  }
  return [...out].map(([item, qty]) => ({ item, qty }));
}

/**
 * Checks a request body. A create (`partial` false) needs a title; an edit
 * may carry any subset. Unknown fields are ignored; a field present with a
 * bad value fails the whole input, named by the first such field.
 */
export function parseTaskInput(body: unknown, partial: boolean): TaskParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "body" };
  const b = body as Record<string, unknown>;
  const value: TaskInput = {};
  if (b.title !== undefined || !partial) {
    const title = text(b.title, TASK_LIMITS.title);
    if (!title) return { ok: false, error: "title" };
    value.title = title;
  }
  if (b.owner !== undefined) {
    const owner = text(b.owner, TASK_LIMITS.owner);
    if (owner === null) return { ok: false, error: "owner" };
    value.owner = owner;
  }
  if (b.status !== undefined) {
    if (!(TASK_STATUSES as readonly unknown[]).includes(b.status)) return { ok: false, error: "status" };
    value.status = b.status as TaskStatus;
  }
  if (b.note !== undefined) {
    const note = text(b.note, TASK_LIMITS.note, true);
    if (note === null) return { ok: false, error: "note" };
    value.note = note;
  }
  if (b.target !== undefined) {
    const t = target(b.target);
    if (t === undefined) return { ok: false, error: "target" };
    value.target = t;
  }
  if (b.materials !== undefined) {
    const m = materials(b.materials);
    if (!m) return { ok: false, error: "materials" };
    value.materials = m;
  }
  return { ok: true, value };
}

/** A container's stacks, as the storage index lists them. */
export interface StockSource {
  items: readonly { name: string; stack: number }[];
}

/** How many of each item the group has across the given containers. */
export function stockTotals(containers: readonly StockSource[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of containers) for (const it of c.items) out.set(it.name, (out.get(it.name) ?? 0) + it.stack);
  return out;
}

export interface MaterialNeed extends TaskMaterial {
  /** In the stores now, capped at nothing: can be more than needed. */
  have: number;
  /** Still to gather: `qty - have`, never below 0. */
  missing: number;
}

/**
 * A task's material list against the stores: what each line still lacks.
 * Each task is held against the whole stock on its own, the way a group
 * reads "can we build this now"; two tasks that need the same wood both see
 * all of it.
 */
export function shortfall(list: readonly TaskMaterial[], stock: ReadonlyMap<string, number>): MaterialNeed[] {
  return list.map(({ item, qty }) => {
    const have = Math.max(0, stock.get(item) ?? 0);
    return { item, qty, have, missing: Math.max(0, qty - have) };
  });
}

/** Only the lines still missing something: the shopping list. */
export const stillMissing = (needs: readonly MaterialNeed[]): MaterialNeed[] => needs.filter((n) => n.missing > 0);
