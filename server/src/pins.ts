import { Database } from "bun:sqlite";
import type { Context, Hono } from "hono";
import { RateLimiter } from "./auth";
import { randomBytes } from "node:crypto";
import { worldId } from "./catchup";
import { DONE_STATES, PIN_ICONS, PIN_MAX, PIN_NAME_MAX, PIN_NOTE_MAX, PIN_STATES, sameName, tidyText, type PinExpect, type PinIcon, type PinState, type WebPin } from "./pintypes";
import { jsonBody, writeLimit } from "./routehelp";
import type { WorldMeta } from "./types";

/** Pins stand inside the world disc's square, like the floor-plan boxes. */
const WORLD_EDGE = 10_500;
/** A pin with a full note is a few hundred bytes. */
const MAX_BODY = 4 * 1024;

/** The table's layout version, kept in the shared `meta` table for a later migration to read. */
const SCHEMA_VERSION = 1;
const SCHEMA_KEY = "pins.schema";
/** The key world ids are made with: made once and kept, so pins stay with their world whatever else changes. */
const WORLD_KEY = "pins.worldkey";

interface Row {
  id: string;
  world: string;
  x: number;
  z: number;
  icon: string;
  note: string;
  author: string;
  created: number;
  updated: number;
  state: string;
  claimed_by: string | null;
  state_by: string;
  state_at: number;
  archived: number;
  version: number;
}

const COLUMNS = "id, world, x, z, icon, note, author, created, updated, state, claimed_by, state_by, state_at, archived, version";

const isIcon = (v: unknown): v is PinIcon => typeof v === "string" && (PIN_ICONS as readonly string[]).includes(v);
const isState = (v: unknown): v is PinState => typeof v === "string" && (PIN_STATES as readonly string[]).includes(v);

function fromRow(r: Row): WebPin {
  return {
    id: r.id,
    x: r.x,
    z: r.z,
    icon: isIcon(r.icon) ? r.icon : "point",
    note: r.note,
    author: r.author,
    version: r.version,
    createdAt: r.created,
    updatedAt: r.updated,
    state: isState(r.state) ? r.state : "new",
    claimedBy: r.claimed_by,
    stateBy: r.state_by,
    stateAt: r.state_at,
    archived: r.archived === 1,
  };
}

/** Tidied text, or null when it is not text or longer than `max` characters. */
function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = tidyText(v);
  return [...s].length > max ? null : s;
}

/** A display name: 1 to PIN_NAME_MAX characters, or why it is refused. */
export function parseName(v: unknown): string | { error: string } {
  const s = clean(v, PIN_NAME_MAX);
  if (s === null) return { error: `name must be text of at most ${PIN_NAME_MAX} characters` };
  if (!s) return { error: "name missing" };
  return s;
}

/** A note: one line of up to PIN_NOTE_MAX characters, empty allowed. */
export function parseNote(v: unknown): string | { error: string } {
  if (v === undefined || v === null) return "";
  const s = clean(v, PIN_NOTE_MAX);
  return s === null ? { error: `note must be text of at most ${PIN_NOTE_MAX} characters` } : s;
}

const coord = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= WORLD_EDGE ? Math.round(v * 10) / 10 : null);

/**
 * Whether a pin may go from `from` to `to`: a new pin can be claimed or
 * finished, a claim can be dropped or finished, and a finished pin can be
 * reopened or marked the other way (cleared vs depleted).
 */
export function canMove(from: PinState, to: PinState): boolean {
  if (from === to) return true;
  if (from === "new") return true;
  if (from === "claimed") return to !== "claimed";
  return to === "new" || DONE_STATES.includes(to);
}

type PinFailure =
  | { ok: false; error: "bad_request" | "outside" | "not_found" | "full" | "bad_move" | "not_archived" | "no_world"; message: string }
  /** Someone changed a field this edit changes after the edit's page saw it (or holds the claim): `pin` is the current one. */
  | { ok: false; error: "stale"; message: string; pin: WebPin };
export type PinResult = { ok: true; pin: WebPin } | PinFailure;

export interface PinCreate {
  x: unknown;
  z: unknown;
  icon?: unknown;
  note?: unknown;
  by: unknown;
}

export interface PinChange {
  by: unknown;
  state?: unknown;
  note?: unknown;
  icon?: unknown;
  archived?: unknown;
  /** What the page saw of the fields it changes (see PinExpect). */
  expect?: unknown;
}

/** One change, as the pages receive it: a pin added or changed, one gone, or a new list (the world changed). */
export type PinEvent = { kind: "put"; pin: WebPin } | { kind: "gone"; id: string } | { kind: "list" };

/**
 * The web pins, in the history database (one writer), each kept with the
 * world it was placed in: only the current world's pins are listed and sent,
 * so a new or imported world starts with none. Every change goes to the
 * listeners for /live.
 *
 * There are no accounts: a claim names whoever claimed it, and anyone may
 * drop or finish it. The guard is against two pages acting on what they saw
 * (`expect`), not against people.
 */
export class PinStore {
  private db: Database;
  private readonly own: boolean;
  private listeners = new Set<(ev: PinEvent) => void>();
  /** The world being played (catchup.ts worldId of its seed); "" until the agent has read a save. */
  private current = "";
  private readonly worldKey: string;

  /** `db`: the history store's connection; a path opens its own (tests). */
  constructor(
    db: Database | string,
    private readonly clock: () => number = Date.now,
    private readonly max = PIN_MAX,
  ) {
    this.own = typeof db === "string";
    this.db = typeof db === "string" ? new Database(db, { create: true }) : db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_pins (
        id         TEXT PRIMARY KEY,
        world      TEXT NOT NULL,
        x          REAL NOT NULL,
        z          REAL NOT NULL,
        icon       TEXT NOT NULL,
        note       TEXT NOT NULL,
        author     TEXT NOT NULL,
        created    INTEGER NOT NULL,
        updated    INTEGER NOT NULL,
        state      TEXT NOT NULL,
        claimed_by TEXT,
        state_by   TEXT NOT NULL,
        state_at   INTEGER NOT NULL,
        archived   INTEGER NOT NULL DEFAULT 0,
        version    INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS web_pins_world ON web_pins (world, created);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.db.query("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(SCHEMA_KEY, String(SCHEMA_VERSION));
    this.db.query("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(WORLD_KEY, randomBytes(32).toString("base64url"));
    this.worldKey = (this.db.query("SELECT value FROM meta WHERE key = ?").get(WORLD_KEY) as { value: string }).value;
  }

  schemaVersion(): number {
    return Number((this.db.query("SELECT value FROM meta WHERE key = ?").get(SCHEMA_KEY) as { value: string } | null)?.value ?? 0);
  }

  /**
   * The world from the agent's state. Its id is keyed like the catch-up's,
   * so the stored value does not give the seed away, but with the store's
   * own key, kept in the database: a new SESSION_SECRET does not lose the
   * pins. A state without a world (agent away) keeps the one known.
   */
  followWorld(meta: Pick<WorldMeta, "seedName" | "seed"> | null | undefined): void {
    if (meta) this.setWorld(worldId(this.worldKey, meta.seedName, meta.seed));
  }

  /** The world now played. A different one sends every page its pins (or none). */
  setWorld(id: string): void {
    if (id === this.current) return;
    this.current = id;
    this.emit({ kind: "list" });
  }

  get world(): string {
    return this.current;
  }

  /** The current world's pins, archived ones included, oldest first. */
  list(): WebPin[] {
    return (this.db.query(`SELECT ${COLUMNS} FROM web_pins WHERE world = ? ORDER BY created, id`).all(this.current) as Row[]).map(fromRow);
  }

  /** A pin of the current world. */
  get(id: string): WebPin | null {
    const r = this.db.query(`SELECT ${COLUMNS} FROM web_pins WHERE id = ? AND world = ?`).get(id, this.current) as Row | null;
    return r ? fromRow(r) : null;
  }

  /** Pins kept in the current world. */
  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM web_pins WHERE world = ?").get(this.current) as { n: number }).n;
  }


  subscribe(fn: (ev: PinEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: PinEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        // a broken socket must not stop the others
      }
    }
  }

  create(input: PinCreate): PinResult {
    // Before the agent has read a save, a pin would land in no world and never be listed.
    if (!this.current) return { ok: false, error: "no_world", message: "the world is not known yet; try again in a moment" };
    const x = coord(input.x);
    const z = coord(input.z);
    if (x === null || z === null) return { ok: false, error: "outside", message: "x and z must be numbers inside the world" };
    const icon = input.icon === undefined ? "point" : input.icon;
    if (!isIcon(icon)) return bad("unknown icon");
    const note = parseNote(input.note);
    if (typeof note !== "string") return bad(note.error);
    const by = parseName(input.by);
    if (typeof by !== "string") return bad(by.error);
    const now = this.clock();
    const pin: WebPin = { id: crypto.randomUUID(), x, z, icon, note, author: by, version: 1, createdAt: now, updatedAt: now, state: "new", claimedBy: null, stateBy: by, stateAt: now, archived: false };
    // At the limit the oldest archived pin makes room, in the same transaction as the new one.
    const write = this.db.transaction((): { evicted: Row | null } | "full" => {
      let evicted: Row | null = null;
      if (this.count() >= this.max) {
        evicted = this.db.query(`SELECT ${COLUMNS} FROM web_pins WHERE world = ? AND archived = 1 ORDER BY updated, id LIMIT 1`).get(this.current) as Row | null;
        if (!evicted) return "full";
        this.db.query("DELETE FROM web_pins WHERE id = ?").run(evicted.id);
      }
      this.db
        .query(`INSERT INTO web_pins (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(pin.id, this.current, x, z, icon, note, by, now, now, "new", null, by, now, 0, 1);
      return { evicted };
    });
    const res = write();
    if (res === "full") return { ok: false, error: "full", message: `at most ${this.max} pins; archive or delete some first` };
    // Only once both are written.
    if (res.evicted) this.emit({ kind: "gone", id: res.evicted.id });
    this.emit({ kind: "put", pin });
    return { ok: true, pin };
  }

  /**
   * A new state, note, icon or archive flag; what is left out stays. Each
   * guarded field this changes (state, note, icon) is checked against
   * `expect`: when someone changed it since, the edit is stale. A change to
   * what it already is (two people making the same move) is no clash. A
   * claim held by someone else is never taken over.
   */
  update(id: string, change: PinChange): PinResult {
    const cur = this.get(id);
    if (!cur) return { ok: false, error: "not_found", message: "no such pin" };
    const by = parseName(change.by);
    if (typeof by !== "string") return bad(by.error);
    const expect = parseExpect(change.expect);
    if (typeof expect === "string") return bad(expect);
    const stale = (message: string): PinResult => ({ ok: false, error: "stale", message, pin: cur });
    const next: WebPin = { ...cur };

    if (change.state !== undefined) {
      if (!isState(change.state)) return bad("unknown state");
      const to = change.state;
      if (to === "claimed" && cur.state === "claimed" && !sameName(cur.claimedBy, by)) return stale(`already claimed by ${cur.claimedBy}`);
      if (to !== cur.state) {
        if (expect.state !== undefined && expect.state !== cur.state) return stale("the pin's state changed");
        if (expect.claimedBy !== undefined && !sameName(expect.claimedBy, cur.claimedBy) && (expect.claimedBy || cur.claimedBy)) return stale("the pin's claim changed");
        if (!canMove(cur.state, to)) return { ok: false, error: "bad_move", message: `a ${cur.state} pin cannot become ${to}` };
        next.state = to;
        next.stateBy = by;
        next.stateAt = this.clock();
        // A claim names its claimer; dropping it or reopening forgets them; finishing keeps them as the record.
        if (to === "claimed") next.claimedBy = by;
        else if (to === "new") next.claimedBy = null;
      }
    }
    if (change.note !== undefined) {
      const note = parseNote(change.note);
      if (typeof note !== "string") return bad(note.error);
      if (note !== cur.note && expect.note !== undefined && expect.note !== cur.note) return stale("the note changed");
      next.note = note;
    }
    if (change.icon !== undefined) {
      if (!isIcon(change.icon)) return bad("unknown icon");
      if (change.icon !== cur.icon && expect.icon !== undefined && expect.icon !== cur.icon) return stale("the mark changed");
      next.icon = change.icon;
    }
    if (change.archived !== undefined) {
      if (typeof change.archived !== "boolean") return bad("archived must be true or false");
      if (change.archived !== cur.archived && expect.archived !== undefined && expect.archived !== cur.archived) return stale(cur.archived ? "the pin was archived" : "the pin was restored");
      next.archived = change.archived;
    }
    if (next.state === cur.state && next.note === cur.note && next.icon === cur.icon && next.archived === cur.archived) return { ok: true, pin: cur };
    next.updatedAt = this.clock();
    next.version = cur.version + 1;
    this.db
      .query("UPDATE web_pins SET icon = ?, note = ?, updated = ?, state = ?, claimed_by = ?, state_by = ?, state_at = ?, archived = ?, version = ? WHERE id = ?")
      .run(next.icon, next.note, next.updatedAt, next.state, next.claimedBy, next.stateBy, next.stateAt, next.archived ? 1 : 0, next.version, id);
    this.emit({ kind: "put", pin: next });
    return { ok: true, pin: next };
  }

  /** Deletes an archived pin for good: an open pin is archived first, so nothing goes in one step. */
  delete(id: string): { ok: true } | PinFailure {
    const cur = this.get(id);
    if (!cur) return { ok: false, error: "not_found", message: "no such pin" };
    if (!cur.archived) return { ok: false, error: "not_archived", message: "archive the pin before deleting it" };
    this.db.query("DELETE FROM web_pins WHERE id = ?").run(id);
    this.emit({ kind: "gone", id });
    return { ok: true };
  }

  close(): void {
    if (this.own) this.db.close();
  }
}

const bad = (message: string): PinResult => ({ ok: false, error: "bad_request", message });

/** The `expect` of an edit, or why it is refused. */
function parseExpect(v: unknown): PinExpect | string {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return "expect must be an object";
  const o = v as Record<string, unknown>;
  const out: PinExpect = {};
  if (o.state !== undefined) {
    if (!isState(o.state)) return "expect.state is not a state";
    out.state = o.state;
  }
  if (o.claimedBy !== undefined) {
    if (o.claimedBy !== null && typeof o.claimedBy !== "string") return "expect.claimedBy must be text or null";
    out.claimedBy = o.claimedBy === null ? null : tidyText(o.claimedBy);
  }
  if (o.note !== undefined) {
    if (typeof o.note !== "string") return "expect.note must be text";
    out.note = tidyText(o.note);
  }
  if (o.icon !== undefined) {
    if (!isIcon(o.icon)) return "expect.icon is not a mark";
    out.icon = o.icon;
  }
  if (o.archived !== undefined) {
    if (typeof o.archived !== "boolean") return "expect.archived must be true or false";
    out.archived = o.archived;
  }
  return out;
}

const STATUS: Record<PinFailure["error"], 400 | 404 | 409> = { bad_request: 400, outside: 400, not_found: 404, full: 409, bad_move: 409, not_archived: 409, stale: 409, no_world: 409 };

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export interface PinRoutesDeps {
  store: PinStore;
  /** Changes per client: 120 a minute, then a minute's pause, by default. Reads are never limited. */
  limiter?: RateLimiter;
  /** Who a change counts against (the client address); one shared bucket without it. */
  clientKey?: (c: Context) => string;
}

/**
 * /api/pins, behind the panel's sign-in and origin check: every signed-in
 * viewer reads and changes the pins, with no admin session (they are the
 * group's). There are no accounts, so `by` is the name the viewer picked on
 * their device.
 */
export function mountPins(app: Hono, deps: PinRoutesDeps): void {
  const limited = writeLimit(deps.limiter ?? new RateLimiter(120, 60_000, 60_000), "pins", deps.clientKey);
  const answer = (c: Context, res: PinResult | { ok: true } | PinFailure) => {
    c.header("Cache-Control", "no-store");
    return res.ok ? c.json(res) : c.json(res, STATUS[res.error]);
  };
  app.get("/api/pins", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, pins: deps.store.list() });
  });
  app.post("/api/pins", async (c) => {
    const raw = await jsonBody(c, MAX_BODY);
    if (raw instanceof Response) return raw;
    const body = obj(raw);
    if (!body) return c.json({ ok: false, error: "bad_request", message: "JSON object expected" }, 400);
    const stop = limited(c);
    if (stop) return stop;
    return answer(c, deps.store.create({ x: body.x, z: body.z, icon: body.icon, note: body.note, by: body.by }));
  });
  app.patch("/api/pins/:id", async (c) => {
    const raw = await jsonBody(c, MAX_BODY);
    if (raw instanceof Response) return raw;
    const body = obj(raw);
    if (!body) return c.json({ ok: false, error: "bad_request", message: "JSON object expected" }, 400);
    const stop = limited(c);
    if (stop) return stop;
    return answer(c, deps.store.update(c.req.param("id"), { by: body.by, state: body.state, note: body.note, icon: body.icon, archived: body.archived, expect: body.expect }));
  });
  app.delete("/api/pins/:id", (c) => {
    const stop = limited(c);
    if (stop) return stop;
    return answer(c, deps.store.delete(c.req.param("id")));
  });
}
