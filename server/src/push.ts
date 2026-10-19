// Phone push notifications: the same news as Discord (notify.ts feeds this
// as a sink), sent with Web Push to every device that asked, in the device's
// language, filtered by its own choice and quiet hours.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { RateLimiter } from "./auth";
import { cause, log as defaultLog, type Logger } from "./log";
import { fill, gameVersion, RAIDS, type Item, type ItemKind, type NotifySink } from "./notify";
import { PUSH_DEFAULT_KINDS, PUSH_KINDS, QUIET_TIME, type PushInfo, type PushKind, type PushPayload, type PushPrefs, type PushSubscriptionInput } from "./pushtypes";
import type { Locale } from "./types";
import { buildPushRequest, checkKeys, generateVapidKeys, loadVapidKeys, type VapidKeys } from "./webpush";

export { PUSH_DEFAULT_KINDS, PUSH_KINDS, type PushKind, type PushPrefs };

/** The news kinds each device choice covers. */
const KIND_OF: Partial<Record<ItemKind, PushKind>> = {
  join: "join",
  server: "server",
  join_code: "server",
  boss: "boss",
  raid: "raid",
  death: "death",
  failure: "failure",
  version: "update",
  compat: "update",
};

/**
 * Push services browsers subscribe with. The server posts to a URL a viewer
 * hands it, so nothing else is accepted: no internal address can be made a
 * target. A suffix entry starts with a dot.
 */
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com", "web.push.apple.com", ".push.apple.com", ".notify.windows.com"];

/**
 * A subscription endpoint as accepted: https on a known push service, no
 * port, login or fragment, at most 1024 characters. `allowLocal` (the mock
 * server only) also takes http://127.0.0.1:<port>, for end-to-end tests.
 */
export function parseEndpoint(raw: unknown, allowLocal = false): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.hash) return null;
  if (allowLocal && u.protocol === "http:" && u.hostname === "127.0.0.1") return u.href;
  if (u.protocol !== "https:" || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!PUSH_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) && host.length > h.length : host === h))) return null;
  return u.href;
}

const LOCALES: readonly Locale[] = ["en", "pl"];

function validZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A device's choice from a request body, or why it is refused. */
export function parsePrefs(raw: unknown): PushPrefs | string {
  if (!raw || typeof raw !== "object") return "prefs missing";
  const p = raw as Record<string, unknown>;
  if (!Array.isArray(p.kinds) || !p.kinds.every((k) => PUSH_KINDS.includes(k as PushKind))) return "unknown kind";
  if (typeof p.firstJoinOnly !== "boolean") return "firstJoinOnly must be true or false";
  let quiet: PushPrefs["quiet"] = null;
  if (p.quiet !== null && p.quiet !== undefined) {
    const q = p.quiet as Record<string, unknown>;
    if (typeof q.from !== "string" || typeof q.to !== "string" || !QUIET_TIME.test(q.from) || !QUIET_TIME.test(q.to)) return "quiet hours must be HH:MM";
    quiet = { from: q.from, to: q.to };
  }
  if (!validZone(p.timeZone)) return "unknown time zone";
  if (!LOCALES.includes(p.locale as Locale)) return "unknown locale";
  return { kinds: PUSH_KINDS.filter((k) => (p.kinds as unknown[]).includes(k)), firstJoinOnly: p.firstJoinOnly, quiet, timeZone: p.timeZone, locale: p.locale as Locale };
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether `now` falls in the device's quiet hours, read in its own time zone. */
export function isQuiet(prefs: Pick<PushPrefs, "quiet" | "timeZone">, now: number): boolean {
  const q = prefs.quiet;
  if (!q || q.from === q.to) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: prefs.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const m = Number(parts.find((x) => x.type === "hour")?.value) * 60 + Number(parts.find((x) => x.type === "minute")?.value);
  const from = minutes(q.from);
  const to = minutes(q.to);
  return from < to ? m >= from && m < to : m >= from || m < to;
}

// ---- wording -------------------------------------------------------------------

const STRINGS = {
  en: {
    "join.title": "At the fire",
    join: "{names} arrives at the fire",
    joinMany: "{names} arrive at the fire",
    more: "{n} more",
    "server.title": "The server is up",
    "server.code": "Join code: {code}",
    "server.noCode": "The fire burns again",
    "joinCode.title": "New join code",
    "boss.title": "Boss defeated",
    boss: "{bosses} defeated",
    "raid.title": "Raid",
    "death.title": "Fallen",
    death: "{names} falls in battle",
    deathMany: "{names} fall in battle",
    "failure.title": "Something failed",
    "failure.action": "{action} failed",
    "failure.settings": "Applying the new settings failed",
    "action.backup": "Backup",
    "action.restart": "Server restart",
    "action.update": "Update check",
    "update.title": "Game update",
    version: "Game updated to {version}",
    "compat.ok": "Skald checked the update: all fine",
    "compat.warn": "Skald checked the update: something to look at",
    "compat.fail": "Skald checked the update: something broke",
    "test.title": "Skald",
    test: "Test notification. Notifications work on this device.",
  },
  pl: {
    "join.title": "Przy ognisku",
    join: "{names} przybywa do ogniska",
    joinMany: "{names} przybywają do ogniska",
    more: "jeszcze {n}",
    "server.title": "Serwer działa",
    "server.code": "Kod dołączenia: {code}",
    "server.noCode": "Ogień znów płonie",
    "joinCode.title": "Nowy kod dołączenia",
    "boss.title": "Boss pokonany",
    boss: "Pokonano: {bosses}",
    "raid.title": "Najazd",
    "death.title": "Polegli",
    death: "{names} pada w boju",
    deathMany: "{names} padają w boju",
    "failure.title": "Coś się nie udało",
    "failure.action": "{action}: nie powiodło się",
    "failure.settings": "Nie udało się zastosować nowych ustawień",
    "action.backup": "Kopia świata",
    "action.restart": "Restart serwera",
    "action.update": "Sprawdzenie aktualizacji",
    "update.title": "Aktualizacja gry",
    version: "Gra zaktualizowana do {version}",
    "compat.ok": "Skald sprawdził aktualizację: wszystko w porządku",
    "compat.warn": "Skald sprawdził aktualizację: coś wymaga uwagi",
    "compat.fail": "Skald sprawdził aktualizację: coś przestało działać",
    "test.title": "Skald",
    test: "Testowe powiadomienie. Powiadomienia działają na tym urządzeniu.",
  },
} satisfies Record<Locale, Record<string, string>>;

type Key = keyof (typeof STRINGS)["en"];

/** As the panel names them (web/src/i18n, `boss.*`). */
const BOSSES: Record<Locale, Record<string, string>> = {
  en: {
    defeated_eikthyr: "Eikthyr",
    defeated_gdking: "The Elder",
    defeated_bonemass: "Bonemass",
    defeated_dragon: "Moder",
    defeated_goblinking: "Yagluth",
    defeated_queen: "The Queen",
    defeated_frozenking: "Kall Fimbulbringer",
    defeated_frozenking_p3: "Kall Fimbulbringer",
    defeated_fader: "Fader",
  },
  pl: {
    defeated_eikthyr: "Eikthyr",
    defeated_gdking: "Starzec",
    defeated_bonemass: "Kościoszlam",
    defeated_dragon: "Modera",
    defeated_goblinking: "Yagluth",
    defeated_queen: "Królowa",
    defeated_frozenking: "Kall Zwiastun Mrozu",
    defeated_frozenking_p3: "Kall Zwiastun Mrozu",
    defeated_fader: "Fader",
  },
};

const BODY_MAX = 300;
const clip = (s: string) => (s.length > BODY_MAX ? `${s.slice(0, BODY_MAX - 1)}…` : s);

/** Names as one list; past three, the first two and how many more. */
function nameList(names: readonly string[], locale: Locale): string {
  const shown = names.length > 3 ? [...names.slice(0, 2), fill(STRINGS[locale].more, { n: String(names.length - 2) })] : [...names];
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(shown);
}

/** What one device is told about; the names of the latest join and death notifications, for collapsing. */
interface DeviceMemory {
  join?: { names: string[]; at: number };
  death?: { names: string[]; at: number };
  sent: number[];
}

/**
 * One batch as the notifications one device gets, at most one per tag.
 * Joins and deaths add to the names of the last such notification while it
 * is younger than `collapseMs`, so the newest one reads "Ragnar, Freya and
 * Bjorn arrive" and replaces the older ones on the device.
 */
export function notificationsFor(items: readonly Item[], prefs: PushPrefs, ctx: { joinCode: string }, mem: DeviceMemory, now: number, collapseMs: number): PushPayload[] {
  const s = STRINGS[prefs.locale];
  const on = new Set(prefs.kinds);
  const mine = items.filter((it) => {
    const k = KIND_OF[it.kind];
    if (!k || !on.has(k)) return false;
    if (it.kind === "server") return it.status === "running";
    if (it.kind === "failure") return it.what !== "admin";
    return true;
  });
  const out: PushPayload[] = [];
  // The window runs from the first notification of a group, so it closes even on a busy evening.
  const names = (kind: "join" | "death", list: string[], fresh = false) => {
    const last = mem[kind];
    const open = !fresh && last && now - last.at < collapseMs;
    const merged = open ? [...new Set([...last.names, ...list])] : [...new Set(list)];
    mem[kind] = { names: merged, at: open ? last.at : now };
    return merged;
  };

  let joins = mine.filter((it): it is Extract<Item, { kind: "join" }> => it.kind === "join");
  if (prefs.firstJoinOnly && !joins.some((j) => j.first)) joins = [];
  if (joins.length > 0) {
    // Someone lighting an empty fire starts a new group: whoever came before has left.
    const all = names("join", joins.map((j) => j.name), joins.some((j) => j.first));
    out.push({ title: s["join.title"], body: clip(fill(all.length > 1 ? s.joinMany : s.join, { names: nameList(all, prefs.locale) })), tag: "join", url: "/" });
  }
  const deaths = mine.filter((it): it is Extract<Item, { kind: "death" }> => it.kind === "death");
  if (deaths.length > 0) {
    const all = names("death", deaths.map((d) => d.name));
    out.push({ title: s["death.title"], body: clip(fill(all.length > 1 ? s.deathMany : s.death, { names: nameList(all, prefs.locale) })), tag: "death", url: "/#saga" });
  }
  const up = mine.some((it) => it.kind === "server");
  const code = [...mine].reverse().find((it): it is Extract<Item, { kind: "join_code" }> => it.kind === "join_code")?.code ?? "";
  if (up) {
    const c = code || ctx.joinCode;
    out.push({ title: s["server.title"], body: c ? fill(s["server.code"], { code: c }) : s["server.noCode"], tag: "server", url: "/" });
  } else if (code) {
    out.push({ title: s["joinCode.title"], body: fill(s["server.code"], { code }), tag: "server", url: "/" });
  }
  const bosses = mine.filter((it): it is Extract<Item, { kind: "boss" }> => it.kind === "boss").map((b) => BOSSES[prefs.locale][b.key] ?? b.key);
  if (bosses.length > 0) out.push({ title: s["boss.title"], body: clip(fill(s.boss, { bosses: new Intl.ListFormat(prefs.locale, { type: "conjunction" }).format(bosses) })), tag: "boss", url: "/" });
  const raid = [...mine].reverse().find((it): it is Extract<Item, { kind: "raid" }> => it.kind === "raid");
  if (raid) out.push({ title: s["raid.title"], body: clip(RAIDS[prefs.locale][raid.raid] ?? raid.raid), tag: "raid", url: "/#saga" });
  const failures = mine.flatMap((it) => {
    if (it.kind !== "failure") return [];
    if (it.what === "settings") return [s["failure.settings"]];
    if (it.what === "action") return [fill(s["failure.action"], { action: s[`action.${it.action}` as Key] ?? it.action })];
    return [];
  });
  if (failures.length > 0) out.push({ title: s["failure.title"], body: clip(failures.join("\n")), tag: "failure", url: "/#settings" });
  const updates = mine.flatMap((it) => {
    if (it.kind === "version") return [fill(s.version, { version: gameVersion(it.version) })];
    if (it.kind === "compat") return [s[`compat.${it.result.status}` as Key] ?? ""].filter(Boolean);
    return [];
  });
  if (updates.length > 0) out.push({ title: s["update.title"], body: clip(updates.join("\n")), tag: "update", url: "/" });
  return out;
}

// ---- storage ------------------------------------------------------------------

export interface PushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
  prefs: PushPrefs;
  /** Refusals in a row from the push service. */
  fails: number;
}

interface Row {
  endpoint: string;
  p256dh: string;
  auth: string;
  prefs: string;
  fails: number;
}

/**
 * The devices and the VAPID keys, in skald-web's own database (DB_PATH),
 * on the history store's connection.
 */
export class PushStore {
  private db: Database;

  /** `db`: the history store's connection, so the file has one writer; a path opens its own (tests). */
  constructor(db: Database | string) {
    this.db = typeof db === "string" ? new Database(db, { create: true }) : db;
    this.db.exec("PRAGMA secure_delete = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_devices (
        endpoint TEXT PRIMARY KEY,
        p256dh   TEXT NOT NULL,
        auth     TEXT NOT NULL,
        prefs    TEXT NOT NULL,
        created  INTEGER NOT NULL,
        fails    INTEGER NOT NULL DEFAULT 0,
        -- A hash of the session that subscribed it: a few devices per session, all forgotten on its sign-out.
        session  TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  getMeta(key: string): string | null {
    const r = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  all(): PushDevice[] {
    const rows = this.db.query("SELECT endpoint, p256dh, auth, prefs, fails FROM push_devices ORDER BY created").all() as Row[];
    const out: PushDevice[] = [];
    for (const r of rows) {
      const prefs = parsePrefs(safeJson(r.prefs));
      if (typeof prefs !== "string") out.push({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, prefs, fails: r.fails });
    }
    return out;
  }

  get(endpoint: string): PushDevice | null {
    const r = this.db.query("SELECT endpoint, p256dh, auth, prefs, fails FROM push_devices WHERE endpoint = ?").get(endpoint) as Row | null;
    if (!r) return null;
    const prefs = parsePrefs(safeJson(r.prefs));
    return typeof prefs === "string" ? null : { endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, prefs, fails: r.fails };
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM push_devices").get() as { n: number }).n;
  }

  put(d: Omit<PushDevice, "fails">, now: number, session = ""): void {
    this.db
      .query(
        `INSERT INTO push_devices (endpoint, p256dh, auth, prefs, created, fails, session) VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, prefs = excluded.prefs, fails = 0, session = excluded.session`,
      )
      .run(d.endpoint, d.p256dh, d.auth, JSON.stringify(d.prefs), now, session);
  }

  countSession(session: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM push_devices WHERE session = ?").get(session) as { n: number }).n;
  }

  /** Removes a session's devices; returns their endpoints. */
  removeSession(session: string): string[] {
    const rows = this.db.query("SELECT endpoint FROM push_devices WHERE session = ?").all(session) as { endpoint: string }[];
    this.db.query("DELETE FROM push_devices WHERE session = ?").run(session);
    return rows.map((r) => r.endpoint);
  }

  setFails(endpoint: string, fails: number): void {
    this.db.query("UPDATE push_devices SET fails = ? WHERE endpoint = ?").run(fails, endpoint);
  }

  remove(endpoint: string): boolean {
    return this.db.query("DELETE FROM push_devices WHERE endpoint = ?").run(endpoint).changes > 0;
  }

  clear(): void {
    this.db.exec("DELETE FROM push_devices");
  }

  close(): void {
    this.db.close();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- delivery -----------------------------------------------------------------

const META_VAPID = "push.vapid";
const META_RESET = "push.reset";

export interface PushServiceOptions {
  store: PushStore;
  /** VAPID `sub`: who push services can reach about this panel (mailto: or https:). */
  contact: string;
  /**
   * Changes when the panel password does: every device is forgotten then, as
   * a new password is meant to shut out who had the old one.
   */
  resetKey?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  log?: Logger;
  /** The mock server only: endpoints on 127.0.0.1 over http, for end-to-end tests. */
  allowLocal?: boolean;
  /** Devices one panel keeps at most. */
  maxDevices?: number;
  /** Devices one signed-in session may subscribe. */
  maxPerSession?: number;
  /** Joins and deaths within this long of the last one add to its notification. */
  collapseMs?: number;
  /** Notifications per device within `rateWindowMs`; past it they are dropped. */
  rateMax?: number;
  rateWindowMs?: number;
  timeoutMs?: number;
}

export type PushResult = { ok: true } | { ok: false; error: "not_subscribed" | "busy" | "failed" | "gone"; retryAfter?: number };
export type SubscribeResult = { ok: true; prefs: PushPrefs } | { ok: false; error: "bad_endpoint" | "bad_keys" | "full" | "session_full"; message: string };

/** How long a push service keeps news for an offline device: a join code goes stale with the next restart. */
const CODE_TTL_S = 60 * 60;
const NEWS_TTL_S = 6 * 60 * 60;
/** Refusals in a row (other than "gone") after which a device is forgotten. */
const MAX_FAILS = 10;
/** Test pushes: at most one per device per this long. */
export const PUSH_TEST_COOLDOWN_MS = 10_000;

/**
 * Sends the news to every subscribed device. A sink of the Discord notifier:
 * `batch` only works out the notifications and starts the requests, it never
 * waits on a push service.
 */
export class PushService implements NotifySink {
  private vapid: VapidKeys | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly logger: Logger;
  private readonly memory = new Map<string, DeviceMemory>();
  private readonly testedAt = new Map<string, number>();
  private readonly inflight = new Set<Promise<void>>();
  /** Which choices some device has on, so the notifier skips news nobody wants. */
  private inUse = new Set<PushKind>();
  private readonly o: Required<Pick<PushServiceOptions, "maxDevices" | "maxPerSession" | "collapseMs" | "rateMax" | "rateWindowMs" | "timeoutMs">>;

  constructor(private readonly opt: PushServiceOptions) {
    this.fetchImpl = opt.fetchImpl ?? fetch;
    this.clock = opt.clock ?? Date.now;
    this.logger = opt.log ?? defaultLog;
    this.o = {
      maxDevices: opt.maxDevices ?? 100,
      maxPerSession: opt.maxPerSession ?? 5,
      collapseMs: opt.collapseMs ?? 15 * 60_000,
      rateMax: opt.rateMax ?? 12,
      rateWindowMs: opt.rateWindowMs ?? 10 * 60_000,
      timeoutMs: opt.timeoutMs ?? 10_000,
    };
    this.refresh();
  }

  /** Loads the VAPID keys, or makes and stores them on the first start. */
  async init(): Promise<void> {
    const store = this.opt.store;
    if (this.opt.resetKey !== undefined) {
      const was = store.getMeta(META_RESET);
      if (was !== null && was !== this.opt.resetKey) {
        store.clear();
        this.memory.clear();
        this.testedAt.clear();
        this.logger.info("push: the panel password or session secret changed, every device has to turn notifications on again", { route: "push" });
      }
      store.setMeta(META_RESET, this.opt.resetKey);
    }
    this.vapid = await loadVapidKeys(store.getMeta(META_VAPID));
    this.refresh();
    if (this.vapid) return;
    this.vapid = await generateVapidKeys();
    store.setMeta(META_VAPID, JSON.stringify(this.vapid));
    // New keys: subscriptions made with the old ones would be refused by every push service.
    for (const d of store.all()) this.forget(d.endpoint);
    this.refresh();
  }

  get publicKey(): string {
    if (!this.vapid) throw new Error("push: init() first");
    return this.vapid.publicKey;
  }

  info(): PushInfo {
    return { ok: true, publicKey: this.publicKey, kinds: [...PUSH_KINDS] };
  }

  wants(kind: ItemKind): boolean {
    const k = KIND_OF[kind];
    return k !== undefined && this.inUse.has(k);
  }

  /** `session`: a hash of the subscribing session; it may hold `maxPerSession` devices. */
  async subscribe(sub: PushSubscriptionInput, prefs: PushPrefs, session = ""): Promise<SubscribeResult> {
    const endpoint = parseEndpoint(sub?.endpoint, this.opt.allowLocal);
    if (!endpoint) return { ok: false, error: "bad_endpoint", message: "not a push service this panel sends to" };
    const keys = sub.keys ?? { p256dh: "", auth: "" };
    try {
      if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") throw new Error("keys");
      await checkKeys(keys);
    } catch {
      return { ok: false, error: "bad_keys", message: "the subscription's keys are not usable" };
    }
    const store = this.opt.store;
    if (!store.get(endpoint)) {
      if (session && store.countSession(session) >= this.o.maxPerSession) return { ok: false, error: "session_full", message: `at most ${this.o.maxPerSession} devices per sign-in` };
      if (store.count() >= this.o.maxDevices) return { ok: false, error: "full", message: `at most ${this.o.maxDevices} devices` };
    }
    store.put({ endpoint, p256dh: keys.p256dh, auth: keys.auth, prefs }, this.clock(), session);
    this.refresh();
    return { ok: true, prefs };
  }

  device(endpoint: unknown): PushPrefs | null {
    const e = parseEndpoint(endpoint, this.opt.allowLocal);
    return e ? (this.opt.store.get(e)?.prefs ?? null) : null;
  }

  unsubscribe(endpoint: unknown): boolean {
    const e = parseEndpoint(endpoint, this.opt.allowLocal);
    if (!e) return false;
    const gone = this.opt.store.get(e) !== null;
    this.forget(e);
    this.refresh();
    return gone;
  }

  /** Signing out: every device that session subscribed. */
  forgetSession(session: string): void {
    if (!session) return;
    for (const e of this.opt.store.removeSession(session)) this.forget(e);
    this.refresh();
  }

  /** Every removal goes through here, so nothing about a device outlives it. */
  private forget(endpoint: string): void {
    this.opt.store.remove(endpoint);
    this.memory.delete(endpoint);
    this.testedAt.delete(endpoint);
  }

  /** A test notification to one device, outside quiet hours and the rate limit. */
  async test(endpoint: unknown): Promise<PushResult> {
    const e = parseEndpoint(endpoint, this.opt.allowLocal);
    const d = e ? this.opt.store.get(e) : null;
    if (!d) return { ok: false, error: "not_subscribed" };
    const now = this.clock();
    const last = this.testedAt.get(d.endpoint) ?? Number.NEGATIVE_INFINITY;
    if (now - last < PUSH_TEST_COOLDOWN_MS) return { ok: false, error: "busy", retryAfter: Math.max(1, Math.ceil((last + PUSH_TEST_COOLDOWN_MS - now) / 1000)) };
    this.testedAt.set(d.endpoint, now);
    const s = STRINGS[d.prefs.locale];
    return this.send(d, { title: s["test.title"], body: s.test, tag: "test", url: "/" }, "high");
  }

  batch(items: readonly Item[], ctx: { joinCode: string }): void {
    const now = this.clock();
    for (const d of this.opt.store.all()) {
      if (isQuiet(d.prefs, now)) continue;
      let mem = this.memory.get(d.endpoint);
      if (!mem) this.memory.set(d.endpoint, (mem = { sent: [] }));
      for (const n of notificationsFor(items, d.prefs, ctx, mem, now, this.o.collapseMs)) {
        mem.sent = mem.sent.filter((t) => now - t < this.o.rateWindowMs);
        if (mem.sent.length >= this.o.rateMax) {
          this.logger.warn("push: too many notifications for one device, dropped", { route: "push" });
          break;
        }
        mem.sent.push(now);
        this.track(this.send(d, n, n.tag === "server" || n.tag === "raid" ? "high" : "normal"));
      }
    }
  }

  /** Resolves once every request started so far is done. For tests. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  /** Never rejects: a database or network error in the background is logged, not a crash. */
  private track(work: Promise<unknown>): void {
    const p: Promise<void> = work.then(
      () => undefined,
      (e) => this.logger.warn("push: delivery failed", { route: "push", cause: cause(e).replace(/https?:\/\/\S+/g, "[endpoint]") }),
    );
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private refresh(): void {
    this.inUse = new Set(this.opt.store.all().flatMap((d) => d.prefs.kinds));
  }

  /** One message to one device. The endpoint is a capability: it never reaches the log. */
  private async send(d: PushDevice, payload: PushPayload, urgency: "normal" | "high"): Promise<PushResult> {
    if (!this.vapid) return { ok: false, error: "failed" };
    let res: Response;
    try {
      const { url, init } = await buildPushRequest({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth }, payload: JSON.stringify(payload), topic: payload.tag, urgency, ttl: payload.tag === "server" ? CODE_TTL_S : NEWS_TTL_S }, this.vapid, this.opt.contact, this.clock());
      res = await this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.o.timeoutMs) });
      await res.body?.cancel().catch(() => undefined);
    } catch (e) {
      this.logger.warn("push: delivery failed", { route: "push", cause: cause(e).replace(/https?:\/\/\S+/g, "[endpoint]") });
      return { ok: false, error: "failed" };
    }
    if (res.ok) {
      if (d.fails) this.opt.store.setFails(d.endpoint, 0);
      return { ok: true };
    }
    if (res.status === 404 || res.status === 410) {
      // The browser dropped the subscription (unsubscribed, app removed, expired).
      this.forget(d.endpoint);
      this.refresh();
      return { ok: false, error: "gone" };
    }
    this.logger.warn("push: refused by the push service", { route: "push", status: res.status });
    // A busy service is not the device's fault; anything else counts toward forgetting it.
    if (res.status !== 429 && res.status < 500) {
      const fails = d.fails + 1;
      d.fails = fails;
      if (fails >= MAX_FAILS) {
        this.forget(d.endpoint);
        this.refresh();
      } else this.opt.store.setFails(d.endpoint, fails);
    }
    return { ok: false, error: "failed" };
  }
}

// ---- routes -------------------------------------------------------------------

async function body(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * /api/push, mounted behind the panel session (any signed-in viewer manages
 * their own device; nothing here changes the server). The origin check on
 * /api/* covers every method that changes something.
 */
export interface PushRouteOptions {
  /** Subscribing and tests per client address. */
  limiter: RateLimiter;
  /** The client address the limiter keys on (TRUSTED_IP_HEADER aware). */
  clientKey: (c: Context) => string;
  /** A stable hash of the caller's session. */
  session: (c: Context) => string;
}

export function pushRoutes(push: Pick<PushService, "info" | "subscribe" | "device" | "unsubscribe" | "test">, o: PushRouteOptions): Hono {
  const r = new Hono();
  // Subscriptions are a few hundred bytes; nothing here needs more.
  r.use("*", bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ ok: false, error: "too_large" }, 413) }));
  /** null when the caller may go on; otherwise the 429. */
  const limited = (c: Context) => {
    const wait = o.limiter.hit(o.clientKey(c));
    return wait > 0 ? c.json({ ok: false, error: "rate_limited", retryAfter: wait }, 429, { "Retry-After": String(wait) }) : null;
  };
  r.get("/", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(push.info());
  });
  r.put("/", async (c) => {
    const denied = limited(c);
    if (denied) return denied;
    const b = await body(c);
    if (!b) return c.json({ ok: false, error: "bad_request" }, 400);
    const prefs = parsePrefs(b.prefs);
    if (typeof prefs === "string") return c.json({ ok: false, error: "bad_prefs", message: prefs }, 400);
    const res = await push.subscribe(b.subscription as PushSubscriptionInput, prefs, o.session(c));
    if (!res.ok) return c.json(res, res.error === "full" || res.error === "session_full" ? 409 : 400);
    return c.json(res);
  });
  // POST: the endpoint is a capability and stays out of URLs (and access logs).
  r.post("/device", async (c) => {
    const b = await body(c);
    if (!b) return c.json({ ok: false, error: "bad_request" }, 400);
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, prefs: push.device(b.endpoint) });
  });
  r.delete("/", async (c) => {
    const b = await body(c);
    if (!b) return c.json({ ok: false, error: "bad_request" }, 400);
    push.unsubscribe(b.endpoint);
    return c.json({ ok: true });
  });
  r.post("/test", async (c) => {
    const denied = limited(c);
    if (denied) return denied;
    const b = await body(c);
    if (!b) return c.json({ ok: false, error: "bad_request" }, 400);
    const res = await push.test(b.endpoint);
    if (res.ok) return c.json(res);
    if (res.error === "busy") return c.json(res, 429, { "Retry-After": String(res.retryAfter ?? 10) });
    if (res.error === "not_subscribed" || res.error === "gone") return c.json(res, 404);
    return c.json(res, 502);
  });
  return r;
}

/**
 * What the devices follow: a new panel password or session secret forgets
 * them all at the next start, as either one is meant to shut someone out.
 */
export function pushResetKey(passwordHash: string, sessionSecret: string): string {
  const h = (v: string) => createHash("sha256").update(v).digest("hex");
  return h(`skald-push|${h(passwordHash)}|${h(sessionSecret)}`);
}

/** A session token's stable, non-reversible tag for the device table. */
export function pushSessionTag(token: string | undefined): string {
  return token ? createHash("sha256").update(`skald-push-session|${token}`).digest("hex").slice(0, 32) : "";
}
