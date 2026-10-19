import { playerKey } from "./apply";
import { NOTIFY_KINDS, type AgentEvent, type AgentState, type CompatResult, type LiveMessage, type Locale, type NotifyChange, type NotifyConfig, type NotifyKind, type SafeRestartRun } from "./types";

export { NOTIFY_KINDS, type NotifyChange, type NotifyKind };

/**
 * One piece of news; joins, leaves and deaths of a batch share a line.
 * `first` on a join: nobody was at the fire before it.
 */
export type Item =
  // key tells apart players sharing a name ("Ragnar#2"); the name otherwise.
  | { kind: "join"; name: string; key?: string; first?: boolean }
  | { kind: "leave"; name: string; key?: string; ms: number | null }
  | { kind: "death"; name: string }
  | { kind: "raid"; raid: string }
  | { kind: "server"; status: "stopped" | "starting" | "running" }
  | { kind: "join_code"; code: string }
  | { kind: "version"; version: string }
  /** A compatibility check of a new build; `followUp`: after its first save. */
  | { kind: "compat"; result: CompatResult; followUp: boolean }
  | { kind: "failure"; what: "admin"; actor: string; command: string; error: string }
  | { kind: "failure"; what: "settings"; error: string }
  | { kind: "failure"; what: "action"; action: string; error: string }
  /**
   * A safe restart: its heads-up (minutes 0: going down now), its end with the
   * new join code, a failure (the archive kept, when there is one), or a
   * cancel of one players were warned about.
   */
  | { kind: "restart"; phase: "warning"; minutes: number }
  | { kind: "restart"; phase: "done"; code: string }
  | { kind: "restart"; phase: "failed"; error: string; archive: string }
  | { kind: "restart"; phase: "cancelled" }
  /** A boss whose key turned defeated since the last state; not a Discord kind, only sinks take it. */
  | { kind: "boss"; key: string };

export type ItemKind = Item["kind"];

/** The steps of a safe restart from which it holds the server news. */
const HOLDING: ReadonlySet<string> = new Set(["save", "stop", "backup", "verify", "start", "recover"]);

/** The Discord kind an item goes out under: a safe restart's failure is a failure, the rest is server news. */
export function discordKind(item: Item): NotifyKind | null {
  if (item.kind === "restart") return item.phase === "failed" ? "failure" : "server";
  if (item.kind === "boss") return null;
  return item.kind;
}

/**
 * Another consumer of the same news (phone push): it sees every batch after
 * the dedupe, baseline and coalescing, whatever Discord is set to.
 */
export interface NotifySink {
  wants(kind: ItemKind): boolean;
  /** `joinCode`: the newest join code the notifier knows. Must not throw or wait. */
  batch(items: readonly Item[], ctx: { joinCode: string }): void;
}

/** Kinds that wait for company before going out. */
const COALESCED: ReadonlySet<ItemKind> = new Set(["join", "leave", "death"]);

/** Discord's limit on `content`. */
const CONTENT_MAX = 2000;
/** Messages waiting while Discord is slow or limiting; older ones are dropped first. */
const OUTBOX_MAX = 20;
/** Seen events remembered for dedupe. */
const SEEN_MAX = 512;
/** A 429 never parks the queue longer than this. */
const RETRY_CAP_MS = 60_000;

const STRINGS = {
  en: {
    join: "{names} arrives at the fire",
    joinMany: "{names} arrive at the fire",
    leave: "{names} walks into the dark",
    leaveMany: "{names} walk into the dark",
    death: "{names} falls in battle",
    deathMany: "{names} fall in battle",
    raid: "Raid: {raid}",
    "server.stopped": "Server stopped",
    "server.starting": "The server is starting",
    "server.running": "The fire burns again, the server is up",
    joinCode: "New join code: **{code}**",
    version: "Game updated to {version}",
    "compat.ok": "Skald checked the game update from {from} to {to}: all fine",
    "compat.warn": "Skald checked the game update from {from} to {to}: something to look at",
    "compat.fail": "Skald checked the game update from {from} to {to}: something broke",
    "compat.followUp.ok": "Skald checked the first save on {to}: all fine",
    "compat.followUp.warn": "Skald checked the first save on {to}: something to look at",
    "compat.followUp.fail": "Skald checked the first save on {to}: something broke",
    "compat.awaitingSave": "The save is checked again after the first save on the new build.",
    "compat.panel": "Details in the admin sheet.",
    "compat.check.version": "Version",
    "compat.check.save": "Save",
    "compat.check.terrain": "Terrain",
    "compat.check.bridge": "Admin plugin",
    "compat.check.logs": "Server log",
    "compat.reason.containers_unreadable": "{n} containers unreadable ({why})",
    "compat.reason.chunks_unreadable": "{n} parts of the world unreadable",
    "compat.reason.untested": "not tested on this build yet, commands wait for a confirmation",
    "compat.reason.disabled": "the plugin turned itself off",
    "compat.reason.unreachable": "not reachable",
    "compat.reason.world_loaded_missing": "no world loaded line",
    "compat.reason.join_code_missing": "no join code",
    "compat.reason.map_behind": "the map is not built from the newest save",
    "compat.why.inventory_version": "the game saves inventories in a new format (version {v}) that Skald does not know yet",
    "compat.why.inventory_items": "a container lists {v} items, more than fit",
    "compat.why.inventory_flags": "an item has unknown flags ({v})",
    "compat.why.inventory_trailing": "{v} unknown bytes follow the last item",
    "compat.why.truncated": "the save is cut short",
    "compat.why.bad_varint": "a name in the save has a length Skald cannot read",
    adminFailed: "{actor}: {command} failed ({error})",
    settingsFailed: "Applying the new settings failed ({error})",
    actionFailed: "{action} failed ({error})",
    "restart.warning": "The server restarts in {n} min for a backup. Find a safe spot.",
    "restart.now": "The server restarts now for a backup. Back in a few minutes.",
    "restart.done": "The server is back after a safe restart. New join code: **{code}**",
    "restart.doneNoCode": "The server is back after a safe restart.",
    "restart.failed": "The safe restart failed ({error}). The backup is kept as {archive}.",
    "restart.failedNoArchive": "The safe restart failed ({error}).",
    "restart.cancelled": "The server restart is called off.",
    "action.backup": "Backup",
    "action.restart": "Server restart",
    "action.update": "Update check",
    test: "Test notification from Skald. Discord notifications work.",
    underMinute: "under a minute",
  },
  pl: {
    join: "{names} przybywa do ogniska",
    joinMany: "{names} przybywają do ogniska",
    leave: "{names} odchodzi w mrok",
    leaveMany: "{names} odchodzą w mrok",
    death: "{names} pada w boju",
    deathMany: "{names} padają w boju",
    raid: "Najazd: {raid}",
    "server.stopped": "Serwer zatrzymany",
    "server.starting": "Serwer się rozpala",
    "server.running": "Ogień znów płonie, serwer działa",
    joinCode: "Nowy kod dołączenia: **{code}**",
    version: "Gra zaktualizowana do {version}",
    "compat.ok": "Skald sprawdził aktualizację gry z {from} do {to}: wszystko w porządku",
    "compat.warn": "Skald sprawdził aktualizację gry z {from} do {to}: coś wymaga uwagi",
    "compat.fail": "Skald sprawdził aktualizację gry z {from} do {to}: coś przestało działać",
    "compat.followUp.ok": "Skald sprawdził pierwszy zapis na {to}: wszystko w porządku",
    "compat.followUp.warn": "Skald sprawdził pierwszy zapis na {to}: coś wymaga uwagi",
    "compat.followUp.fail": "Skald sprawdził pierwszy zapis na {to}: coś przestało działać",
    "compat.awaitingSave": "Zapis świata zostanie sprawdzony ponownie po pierwszym zapisie na nowej wersji.",
    "compat.panel": "Szczegóły w panelu admina.",
    "compat.check.version": "Wersja",
    "compat.check.save": "Zapis świata",
    "compat.check.terrain": "Teren",
    "compat.check.bridge": "Wtyczka admina",
    "compat.check.logs": "Log serwera",
    "compat.reason.containers_unreadable": "nieczytelne skrzynie: {n} ({why})",
    "compat.reason.chunks_unreadable": "nieczytelne fragmenty świata: {n}",
    "compat.reason.untested": "jeszcze nie sprawdzony na tej wersji, komendy czekają na potwierdzenie",
    "compat.reason.disabled": "wtyczka sama się wyłączyła",
    "compat.reason.unreachable": "nieosiągalny",
    "compat.reason.world_loaded_missing": "brak wpisu o wczytaniu świata",
    "compat.reason.join_code_missing": "brak kodu dołączenia",
    "compat.reason.map_behind": "mapa nie jest zbudowana z najnowszego zapisu",
    "compat.why.inventory_version": "gra zapisuje ekwipunek w nowym formacie (wersja {v}), którego Skald jeszcze nie zna",
    "compat.why.inventory_items": "skrzynia podaje {v} przedmiotów, więcej niż się mieści",
    "compat.why.inventory_flags": "przedmiot ma nieznane znaczniki ({v})",
    "compat.why.inventory_trailing": "po ostatnim przedmiocie zostały nieznane bajty ({v})",
    "compat.why.truncated": "zapis jest ucięty",
    "compat.why.bad_varint": "nazwa w zapisie ma długość, której Skald nie umie odczytać",
    adminFailed: "{actor}: {command} nie powiodło się ({error})",
    settingsFailed: "Nie udało się zastosować nowych ustawień ({error})",
    actionFailed: "{action} nie powiodło się ({error})",
    "restart.warning": "Restart serwera za {n} min, na kopię świata. Znajdźcie bezpieczne miejsce.",
    "restart.now": "Restart serwera teraz, na kopię świata. Wracamy za kilka minut.",
    "restart.done": "Serwer wrócił po bezpiecznym restarcie. Nowy kod dołączenia: **{code}**",
    "restart.doneNoCode": "Serwer wrócił po bezpiecznym restarcie.",
    "restart.failed": "Bezpieczny restart nie powiódł się ({error}). Kopia zostaje jako {archive}.",
    "restart.failedNoArchive": "Bezpieczny restart nie powiódł się ({error}).",
    "restart.cancelled": "Restart serwera odwołany.",
    "action.backup": "Kopia świata",
    "action.restart": "Restart serwera",
    "action.update": "Sprawdzenie aktualizacji",
    test: "Testowe powiadomienie ze Skalda. Powiadomienia na Discordzie działają.",
    underMinute: "niecała minuta",
  },
} satisfies Record<Locale, Record<string, string>>;

type Key = keyof (typeof STRINGS)["en"];

/** The raid messages the game shows, as the web's saga words them. */
export const RAIDS: Record<Locale, Record<string, string>> = {
  en: {
    army_eikthyr: "Eikthyr rallies the creatures of the forest",
    army_theelder: "The forest is moving...",
    army_bonemass: "A foul smell from the swamp... (Bonemass's army)",
    army_moder: "A cold wind blows from the mountains",
    army_goblin: "The horde is attacking!",
    foresttrolls: "The ground is shaking",
    skeletons: "A skeleton surprise!",
    blobs: "A foul smell from the swamp... (blobs)",
    wolves: "You are being hunted...",
    bats: "You stirred the cauldron",
    surtlings: "There's a smell of sulfur in the air...",
    army_charred: "The undead army marches",
    army_seekers: "They sought you out",
    army_gjall: "What's up, Gjall?!",
    hildirboss1: "She's hot on your tail!",
    hildirboss2: "You get the chills...",
    hildirboss3: "They were bros, man",
    hildirboss: "Hildir's bounty hunters",
  },
  pl: {
    army_eikthyr: "Eikthyr gromadzi leśne stworzenia",
    army_theelder: "Las się porusza",
    army_bonemass: "Stęchlizna z bagien (armia Kościoszlamu)",
    army_moder: "Z gór wieje zimny wiatr",
    army_goblin: "Horda atakuje",
    foresttrolls: "Ziemia drży",
    skeletons: "Nadchodzą Szkielety",
    blobs: "Stęchlizna z bagien (flegmy)",
    wolves: "Polują na ciebie…",
    bats: "Zamieszałeś w kotle",
    surtlings: "W powietrzu unosi się swąd siarki...",
    army_charred: "Armia nieumarłych maszeruje",
    army_seekers: "Odszukały cię.",
    army_gjall: "Jak leci, Gjall!?",
    hildirboss1: "Smali do ciebie cholewki",
    hildirboss2: "Przechodzą cię ciarki",
    hildirboss3: "Człowieku, to byli brachole",
    hildirboss: "łowcy nagród Hildir",
  },
};

/** Parses DISCORD_NOTIFY: empty means every kind; an unknown kind throws. */
export function parseNotifyKinds(raw: string): NotifyKind[] {
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return [...NOTIFY_KINDS];
  for (const k of list) {
    if (!NOTIFY_KINDS.includes(k as NotifyKind)) throw new Error(`DISCORD_NOTIFY: unknown kind "${k}" (one of ${NOTIFY_KINDS.join(", ")})`);
  }
  return [...new Set(list as NotifyKind[])];
}

const WEBHOOK_ANY = /https?:\/\/[^\s"']*\/api\/webhooks\/[^\s"']+/gi;

/** Removes the webhook URL (and anything shaped like one) from a log or error line. */
export function redact(text: string, url: string): string {
  const out = url ? text.split(url).join("[webhook]") : text;
  return out.replace(WEBHOOK_ANY, "[webhook]");
}

/** Player names are player-chosen: no markdown tricks in the channel. */
function escapeMd(s: string): string {
  return s.replace(/[\\*_~`|>#[\]]/g, "\\$&");
}

// Valheim reports its build as "l-1.0.17".
export function gameVersion(v: string): string {
  return v.replace(/^[a-z]-/, "");
}

export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

function duration(ms: number, locale: Locale): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return STRINGS[locale].underMinute;
  const h = Math.floor(min / 60);
  if (h === 0) return `${min} min`;
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/**
 * Renders one batch as message lines. Joins, leaves and deaths merge into one
 * line per kind at the place of the first, so five joins read as one line.
 */
export function formatBatch(items: readonly Item[], locale: Locale): string[] {
  const s = STRINGS[locale];
  const list = (names: string[]) => new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
  const lines: string[] = [];
  const done = new Set<ItemKind>();
  for (const it of items) {
    if (COALESCED.has(it.kind)) {
      if (done.has(it.kind)) continue;
      done.add(it.kind);
      // One label per player (its id; deaths carry only the name): a leave
      // carries the visit, repeated deaths a count.
      const labels = new Map<string, string>();
      const deaths = new Map<string, number>();
      for (const x of items) {
        if (x.kind !== it.kind) continue;
        const name = (x as { name: string }).name;
        const who = x.kind === "join" || x.kind === "leave" ? (x.key ?? name) : name;
        let label = escapeMd(name);
        if (x.kind === "leave" && x.ms !== null) label += ` (${duration(x.ms, locale)})`;
        if (x.kind === "death") {
          const n = (deaths.get(name) ?? 0) + 1;
          deaths.set(name, n);
          if (n > 1) label += ` (${n}×)`;
        }
        labels.set(who, label);
      }
      const names = [...labels.values()];
      lines.push(fill(s[(names.length > 1 ? `${it.kind}Many` : it.kind) as Key], { names: list(names) }));
      continue;
    }
    switch (it.kind) {
      case "raid":
        lines.push(fill(s.raid, { raid: RAIDS[locale][it.raid] ?? escapeMd(it.raid) }));
        break;
      case "server":
        lines.push(s[`server.${it.status}`]);
        break;
      case "join_code":
        lines.push(fill(s.joinCode, { code: escapeMd(it.code) }));
        break;
      case "version":
        lines.push(fill(s.version, { version: escapeMd(gameVersion(it.version)) }));
        break;
      case "compat":
        lines.push(...compatLines(it.result, it.followUp, locale));
        break;
      case "restart":
        lines.push(restartLine(it, locale));
        break;
      case "failure":
        if (it.what === "admin") lines.push(fill(s.adminFailed, { actor: escapeMd(it.actor), command: escapeMd(it.command), error: escapeMd(it.error) }));
        else if (it.what === "settings") lines.push(fill(s.settingsFailed, { error: escapeMd(it.error) }));
        else lines.push(fill(s.actionFailed, { action: s[`action.${it.action}` as Key] ?? escapeMd(it.action), error: escapeMd(it.error) }));
        break;
    }
  }
  return lines;
}

/** A safe restart's news as one message line. */
function restartLine(it: Extract<Item, { kind: "restart" }>, locale: Locale): string {
  const s = STRINGS[locale];
  switch (it.phase) {
    case "warning":
      return it.minutes > 0 ? fill(s["restart.warning"], { n: String(it.minutes) }) : s["restart.now"];
    case "done":
      return it.code ? fill(s["restart.done"], { code: escapeMd(it.code) }) : s["restart.doneNoCode"];
    case "failed":
      return it.archive ? fill(s["restart.failed"], { error: escapeMd(it.error), archive: escapeMd(it.archive) }) : fill(s["restart.failedNoArchive"], { error: escapeMd(it.error) });
    case "cancelled":
      return s["restart.cancelled"];
  }
}

/**
 * A compatibility check as message lines: the build change and the outcome,
 * then one line per check that warns or fails.
 */
function compatLines(r: CompatResult, followUp: boolean, locale: Locale): string[] {
  const s = STRINGS[locale] as Record<string, string>;
  const vars = { from: escapeMd(gameVersion(r.previousBuild ?? "?")), to: escapeMd(gameVersion(r.build)) };
  const lines = [fill(s[`compat.${followUp ? "followUp." : ""}${r.status}`] ?? r.status, vars)];
  for (const c of r.checks) {
    if (c.status !== "warn" && c.status !== "fail") continue;
    const d = c.detail ?? {};
    const reason = c.reason ?? "";
    const n = String((reason === "chunks_unreadable" ? d.chunksUnreadable : d.containersUnreadable) ?? "");
    const text = s[`compat.reason.${reason}`] ? fill(s[`compat.reason.${reason}`]!, { n, why: containerWhy(d, s) }) : escapeMd(reason);
    lines.push(`- ${s[`compat.check.${c.name}`] ?? escapeMd(c.name)}: ${text}`);
  }
  if (r.awaitingSave) lines.push(s["compat.awaitingSave"]!);
  if (r.status !== "ok") lines.push(s["compat.panel"]!);
  return lines;
}

/**
 * Why containers did not read, from the agent's reason code (and its value);
 * the agent's own text, escaped, for a code without words here.
 */
function containerWhy(d: Record<string, unknown>, s: Record<string, string>): string {
  const text = typeof d.containerReasonCode === "string" ? s[`compat.why.${d.containerReasonCode}`] : undefined;
  if (!text) return escapeMd(String(d.containerReason ?? ""));
  const v = Number(d.containerReasonValue) || 0;
  return fill(text, { v: d.containerReasonCode === "inventory_flags" ? `0x${v.toString(16)}` : String(v) });
}

/** Discord's 429 wait: the body's `retry_after`, else the header, both in seconds. */
async function retryAfterMs(res: Response): Promise<number> {
  try {
    const body = (await res.json()) as { retry_after?: unknown };
    const s = Number(body.retry_after);
    if (Number.isFinite(s) && s >= 0) return s * 1000;
  } catch {
    // no JSON body; try the header
  }
  // Number(null) and Number("") are 0: no header must mean the fallback, not "at once".
  const raw = res.headers.get("Retry-After")?.trim();
  const h = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(h) && h >= 0 ? h * 1000 : 1000;
}

export interface NotifierOptions {
  /** The webhook; empty means off until `configure` sets one. */
  url: string;
  kinds: readonly NotifyKind[];
  locale: Locale;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  /** Where failures are logged; the webhook URL never reaches it. */
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long joins, leaves and deaths wait for company. */
  coalesceMs?: number;
  /** A server state must hold this long before it is announced. */
  serverHoldMs?: number;
  timeoutMs?: number;
  /** Retries after a 429 before the message is dropped. */
  maxRetries?: number;
  /** Events older than this when they arrive (a long reconnect) are not sent. */
  maxAgeMs?: number;
}

/**
 * `busy`: a test is in flight or one just went out. `rate_limited`: Discord
 * answered 429 and asked to wait. Both carry `retryAfter` in seconds.
 */
export type SendResult = { ok: true } | { ok: false; error: string; retryAfter?: number };

/**
 * Posts notable live events to a Discord webhook. Fed by the hub's listener:
 * `handle` only queues and never throws or waits, so the event pipeline is
 * never held up by Discord. Only events that happen after boot are sent.
 */
export class DiscordNotifier {
  private url: string;
  private kinds: ReadonlySet<NotifyKind>;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly opts: Required<Pick<NotifierOptions, "coalesceMs" | "serverHoldMs" | "timeoutMs" | "maxRetries" | "maxAgeMs">>;
  private readonly bootAt: number;
  private seeded = false;
  private seen = new Set<string>();
  private joinedAt = new Map<string, number>();
  private joinCode = "";
  private version = "";
  private status = "";
  private announcedStatus = "";
  private serverTimer: ReturnType<typeof setTimeout> | null = null;
  /** `discord`: the webhook the item was queued for; empty when only sinks take it. */
  private pending: { item: Item; discord: string }[] = [];
  private readonly sinks: NotifySink[] = [];
  /** Defeated bosses of `bossWorld` in the last readable state; null before one. */
  private defeated: Set<string> | null = null;
  private bossWorld = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private outbox: string[] = [];
  private sending: Promise<void> | null = null;
  private stopped = false;
  /** The safe restart in progress (its id). */
  private restartRun: string | null = null;
  /**
   * From its save to its end the run's own messages say what the server and
   * join code news would, so that news waits; while it only waits or counts
   * down, the news goes out as usual.
   */
  private restartHold = false;
  /** Its heads-up went out (a cancel is then news too). */
  private restartWarned = false;
  /** The join code when the hold began. */
  private restartCode = "";

  constructor(private readonly o: NotifierOptions) {
    this.url = o.url;
    this.kinds = new Set(o.kinds);
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.clock = o.clock ?? Date.now;
    this.log = o.log ?? ((line) => console.error(line));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.opts = {
      coalesceMs: o.coalesceMs ?? 10_000,
      serverHoldMs: o.serverHoldMs ?? 30_000,
      timeoutMs: o.timeoutMs ?? 10_000,
      maxRetries: o.maxRetries ?? 3,
      maxAgeMs: o.maxAgeMs ?? 15 * 60_000,
    };
    this.bootAt = this.clock();
  }

  /** The hub listener. */
  handle(m: LiveMessage): void {
    try {
      if (m.type === "state") {
        this.seed(m.state, m.online);
        if (m.online) this.restartGone(m.state);
        // A leave lost in a long reconnect must not keep a player at the fire for good.
        if (m.online && m.state.players.length === 0) this.joinedAt.clear();
        this.bosses(m.state, m.online);
      }
      else if (m.type === "event") this.event(m.event);
    } catch (e) {
      this.log(`discord: ${redact(e instanceof Error ? e.message : String(e), this.url)}`);
    }
  }

  /**
   * Points the notifier at another webhook, or turns it off with null. What it
   * learned from the live states (the baseline join code, who is online since
   * when) is kept, so turning it on mid-session sends no stale news. Messages
   * still waiting are dropped when it is turned off or points elsewhere: they
   * were meant for the old channel. A message in flight stops retrying.
   */
  configure(target: { url: string; kinds: readonly NotifyKind[] } | null): void {
    const before = this.url;
    this.url = target?.url ?? "";
    this.kinds = new Set(target?.kinds ?? []);
    if (this.url !== before) {
      // What waits for a sink still goes there; Discord's share was for the old channel.
      this.pending = this.pending.filter((p) => this.sinkWants(p.item.kind)).map((p) => ({ item: p.item, discord: "" }));
      this.outbox = [];
      if (this.flushTimer && this.pending.length === 0) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
    }
  }

  /** Another consumer of the news (phone push). */
  addSink(sink: NotifySink): void {
    this.sinks.push(sink);
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.serverTimer) clearTimeout(this.serverTimer);
  }

  /** Resolves once everything queued so far has been sent or dropped. For tests. */
  async idle(): Promise<void> {
    while (this.sending) await this.sending;
  }

  /**
   * Sends the test message now, outside the queue, and says how it went. To
   * `url` when given: a saved webhook can be tried before it is turned on.
   * A 429 is reported, not waited out: the admin can try again once
   * Discord's wait (`retryAfter`, capped) is over.
   */
  async test(url = this.url): Promise<SendResult> {
    return this.post(STRINGS[this.o.locale].test, url, false);
  }

  /**
   * The values the first live state holds are the baseline: a join code or
   * version that differs from them later is news. Seeded once, so a state
   * fetched after a reconnect cannot swallow a change that already happened.
   */
  private seed(st: AgentState, online: boolean): void {
    if (this.seeded || !online) return;
    this.seeded = true;
    this.joinCode = st.server.joinCode ?? "";
    this.version = st.server.version ?? "";
    this.status = st.server.status;
    this.announcedStatus = st.server.status;
    // Started before this boot: its own end is the news.
    if (st.safeRestart?.state === "running") this.joinRun(st.safeRestart);
    for (const p of st.players) this.joinedAt.set(p.name, Date.parse(p.since) || this.clock());
  }

  private event(ev: AgentEvent): void {
    if (this.stopped) return;
    const ts = Date.parse(ev.ts);
    // Replayed history (boot, or the backlog of a long reconnect) is not news.
    if (!Number.isFinite(ts) || ts < this.bootAt || this.clock() - ts > this.opts.maxAgeMs) return;
    const key = `${ev.seq}|${ev.ts}|${ev.type}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);

    const d = ev.data;
    switch (ev.type) {
      case "player_join": {
        const name = String(d.name ?? "");
        if (!name) return;
        const first = this.joinedAt.size === 0;
        this.joinedAt.set(playerKey(d), ts);
        return this.add({ kind: "join", name, key: playerKey(d), first });
      }
      case "player_leave": {
        const name = String(d.name ?? "");
        if (!name) return;
        const at = this.joinedAt.get(playerKey(d));
        this.joinedAt.delete(playerKey(d));
        return this.add({ kind: "leave", name, key: playerKey(d), ms: at === undefined ? null : Math.max(0, ts - at) });
      }
      case "player_count":
        if (Number(d.count) === 0) this.joinedAt.clear();
        return;
      case "death": {
        const name = String(d.name ?? "");
        if (name) this.add({ kind: "death", name });
        return;
      }
      case "raid":
        if (d.name) this.add({ kind: "raid", raid: String(d.name) });
        return;
      case "join_code": {
        const code = String(d.code ?? "");
        if (!code || code === this.joinCode) return;
        this.joinCode = code;
        // A safe restart's end carries it.
        if (this.restartHold) return;
        return this.add({ kind: "join_code", code });
      }
      case "version": {
        const v = String(d.version ?? "");
        if (!v || v === this.version) return;
        const before = this.version;
        this.version = v;
        // The first version seen is a baseline, not an update.
        if (before) this.add({ kind: "version", version: v });
        return;
      }
      case "compat": {
        // Only a finished check of a new build is news: right after the
        // update, and after its first save when that found a problem.
        if (d.running === true || !d.result || typeof d.result !== "object") return;
        const r = d.result as CompatResult;
        if (!r.updated || !r.previousBuild || !Array.isArray(r.checks)) return;
        if (r.trigger === "update") return this.add({ kind: "compat", result: r, followUp: false });
        if (r.trigger === "save" && r.status !== "ok") return this.add({ kind: "compat", result: r, followUp: true });
        return;
      }
      case "server_state":
        return this.serverState(String(d.status));
      case "admin":
        if (d.result === "error") this.add({ kind: "failure", what: "admin", actor: String(d.actor ?? "?"), command: String(d.command ?? "?"), error: String(d.error ?? "") });
        return;
      case "settings_apply":
        if (d.state === "failed") this.add({ kind: "failure", what: "settings", error: String(d.message ?? "") });
        return;
      case "action":
        if (d.ok === false) this.add({ kind: "failure", what: "action", action: String(d.name ?? "?"), error: String(d.message ?? "") });
        return;
      case "restart_run":
        return this.restartEvent(d);
      default:
        // routine saves, backups, logs and the rest are never sent
        return;
    }
  }

  /** A run already under way when first heard of: past its wait, its heads-up went out before. */
  private joinRun(run: SafeRestartRun): void {
    this.restartRun = run.id;
    this.restartCode = this.joinCode;
    this.restartWarned = run.step !== "" && run.step !== "wait";
    this.restartHold = HOLDING.has(run.step);
  }

  /**
   * A run this notifier holds news for, but which the agent no longer runs
   * (an agent restart ends a run without its end event): the hold is lifted.
   */
  private restartGone(st: AgentState): void {
    if (!this.restartRun) return;
    const r = st.safeRestart;
    if (r && r.state === "running" && r.id === this.restartRun) return;
    const held = this.restartHold;
    this.restartRun = null;
    this.restartHold = false;
    this.restartWarned = false;
    if (!held) return;
    // What changed under the hold is news now: the server's state (held for
    // serverHoldMs like any other) and a new join code.
    const status = st.server.status;
    this.status = "";
    this.serverState(status);
    const code = st.server.joinCode ?? "";
    if (code && code !== this.restartCode) {
      this.joinCode = code;
      this.add({ kind: "join_code", code });
    }
  }

  /**
   * A safe restart's step: the heads-up when the countdown starts (or, with
   * nobody to count down for, when the game stops), then its end. Server and
   * join code news is held from its begin to its end.
   */
  private restartEvent(d: Record<string, unknown>): void {
    const run = d.run && typeof d.run === "object" ? (d.run as SafeRestartRun) : null;
    if (!run) return;
    const step = String(d.step ?? "");
    const result = String(d.result ?? "");
    if (step === "begin") {
      this.restartRun = run.id;
      this.restartWarned = false;
      this.restartHold = false;
      return;
    }
    if (step !== "end") {
      if (this.restartRun !== run.id) this.joinRun(run);
      if (HOLDING.has(step) && !this.restartHold) {
        this.restartHold = true;
        this.restartCode = this.joinCode;
      }
      const countdown = step === "countdown" && result === "running";
      const goingDown = step === "stop" && result === "running" && !this.restartWarned;
      if (countdown || goingDown) {
        this.restartWarned = true;
        this.add({ kind: "restart", phase: "warning", minutes: countdown ? run.request.warnMinutes : 0 });
      }
      return;
    }
    this.restartRun = null;
    const warned = this.restartWarned;
    const held = this.restartHold;
    this.restartWarned = false;
    this.restartHold = false;
    // What the server did meanwhile was told by the run; nothing to catch up on.
    if (held) {
      if (this.serverTimer) clearTimeout(this.serverTimer);
      this.serverTimer = null;
      this.announcedStatus = this.status;
    }
    if (result === "done") {
      if (run.joinCode) this.joinCode = run.joinCode;
      return this.add({ kind: "restart", phase: "done", code: run.joinCode ?? "" });
    }
    if (result === "failed") {
      this.add({ kind: "restart", phase: "failed", error: run.error ?? "", archive: run.archive ?? "" });
      // The game may be up with a new code all the same.
      const code = run.joinCode || this.joinCode;
      if (run.joinCode) this.joinCode = run.joinCode;
      if (held && code && code !== this.restartCode) this.add({ kind: "join_code", code });
      return;
    }
    if (result === "cancelled" && warned) this.add({ kind: "restart", phase: "cancelled" });
  }

  /**
   * Server states wait `serverHoldMs` for the next one; only the state that
   * holds is announced, and only when it differs from the last announced, so
   * a quick stop and start says nothing.
   */
  private serverState(status: string): void {
    if (status !== "running") this.joinedAt.clear();
    if (status === this.status) return;
    this.status = status;
    // A safe restart tells its own story.
    if (this.restartHold) return;
    if (status !== "stopped" && status !== "starting" && status !== "running") return;
    if (this.serverTimer) clearTimeout(this.serverTimer);
    this.serverTimer = setTimeout(() => {
      this.serverTimer = null;
      const settled = this.status;
      if (settled !== "stopped" && settled !== "starting" && settled !== "running") return;
      if (settled === this.announcedStatus) return;
      this.announcedStatus = settled;
      this.add({ kind: "server", status: settled });
    }, this.opts.serverHoldMs);
  }

  /**
   * A boss is news when its key turns defeated between two readable states of
   * the same world. The first readable state, and the first of another world,
   * are the baseline.
   */
  private bosses(st: AgentState, online: boolean): void {
    const meta = st.world?.meta;
    if (!online || !meta || !Array.isArray(meta.bosses)) return;
    const now = new Set(meta.bosses.filter((b) => b.defeated).map((b) => b.key));
    const before = this.defeated;
    const sameWorld = meta.name === this.bossWorld;
    this.defeated = now;
    this.bossWorld = meta.name;
    if (!before || !sameWorld) return;
    for (const key of now) if (!before.has(key)) this.add({ kind: "boss", key });
  }

  private sinkWants(kind: ItemKind): boolean {
    return this.sinks.some((s) => s.wants(kind));
  }

  private add(item: Item): void {
    if (this.stopped) return;
    const kind = discordKind(item);
    const discord = this.url && kind && this.kinds.has(kind) ? this.url : "";
    if (!discord && !this.sinkWants(item.kind)) return;
    this.pending.push({ item, discord });
    if (COALESCED.has(item.kind)) {
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), this.opts.coalesceMs);
      return;
    }
    // Anything else goes now, taking whatever waits with it to keep the order.
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 0);
  }

  private flush(): void {
    this.flushTimer = null;
    const queued = this.pending;
    this.pending = [];
    if (queued.length === 0) return;
    for (const sink of this.sinks) {
      const mine = queued.map((p) => p.item).filter((it) => sink.wants(it.kind));
      if (mine.length === 0) continue;
      try {
        sink.batch(mine, { joinCode: this.joinCode });
      } catch (e) {
        this.log(`notify: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const items = queued.filter((p) => p.discord && p.discord === this.url).map((p) => p.item);
    if (items.length === 0) return;
    let content = formatBatch(items, this.o.locale).join("\n");
    if (content.length > CONTENT_MAX) content = `${content.slice(0, CONTENT_MAX - 1)}…`;
    this.outbox.push(content);
    while (this.outbox.length > OUTBOX_MAX) {
      this.outbox.shift();
      this.log("discord: queue full, dropped the oldest message");
    }
    if (!this.sending) this.sending = this.drain().finally(() => (this.sending = null));
  }

  /** One message in flight at a time, in order. */
  private async drain(): Promise<void> {
    while (this.outbox.length > 0 && !this.stopped) {
      const content = this.outbox.shift()!;
      const res = await this.post(content);
      if (!res.ok) this.log(`discord: message dropped: ${res.error}`);
    }
  }

  /**
   * `url` is fixed when the message starts. With `retry`, a 429 is waited out
   * (up to maxRetries), and given up once the webhook changed or was removed
   * meanwhile.
   */
  private async post(content: string, url = this.url, retry = true): Promise<SendResult> {
    // Player names must never ping @everyone or a role.
    const body = JSON.stringify({ content, allowed_mentions: { parse: [] } });
    if (!url) return { ok: false, error: "not_configured" };
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          // Webhooks never redirect; following one would send the body past the host allow-list.
          redirect: "error",
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (e) {
        return { ok: false, error: redact(e instanceof Error ? e.message : String(e), url) };
      }
      if (res.ok) {
        await res.body?.cancel();
        return { ok: true };
      }
      if (retry && res.status === 429 && attempt < this.opts.maxRetries) {
        const wait = Math.min(RETRY_CAP_MS, await retryAfterMs(res));
        await this.sleep(wait);
        if (this.url === url) continue;
        return { ok: false, error: "webhook changed" };
      }
      if (!retry && res.status === 429) {
        // Reads the body for retry_after, so no cancel() after it.
        const wait = Math.min(RETRY_CAP_MS, await retryAfterMs(res));
        return { ok: false, error: "rate_limited", retryAfter: Math.max(1, Math.ceil(wait / 1000)) };
      }
      await res.body?.cancel();
      return { ok: false, error: `HTTP ${res.status}` };
    }
  }
}

// ---- the webhook from the admin sheet ----------------------------------------

const WEBHOOK_HOSTS: ReadonlySet<string> = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);
/** The one query Discord's webhooks take that matters here: post into a thread of a forum channel. */
const WEBHOOK_QUERY = /^\?thread_id=\d{1,32}$/;
const WEBHOOK_PATH = /^\/api\/webhooks\/(\d{1,32})\/([A-Za-z0-9_-]{1,256})$/;

/**
 * A Discord webhook URL as the admin sheet accepts it: https, discord.com or
 * discordapp.com (or the PTB and Canary clients' hosts),
 * `/api/webhooks/<id>/<token>`, optionally `?thread_id=<id>`, nothing else (no
 * port, login, other query or fragment). Returns the canonical URL, or null. The host check is
 * what keeps a saved webhook and its test message from reaching anything but
 * Discord.
 */
export function parseWebhookUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > 512) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !WEBHOOK_HOSTS.has(u.hostname) || u.port || u.username || u.password || u.hash) return null;
  if (u.search && !WEBHOOK_QUERY.test(u.search)) return null;
  if (!WEBHOOK_PATH.test(u.pathname)) return null;
  return `https://${u.hostname}${u.pathname}${u.search}`;
}

/** A webhook URL that can be recognised but not used: the id's last four digits, the token's first four characters. */
export function maskWebhookUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "…";
  }
  const m = WEBHOOK_PATH.exec(u.pathname);
  if (!m) return `${u.hostname}/…`;
  return `${u.hostname}/api/webhooks/…${m[1]!.slice(-4)}/${m[2]!.slice(0, 4)}…`;
}

/** Where the panel's choice is kept: skald-web's own database (the history store's meta table). */
export interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  /** Writes the journal back and empties it, so a removed webhook is not left in it. */
  checkpoint?(): void;
}

/** Test messages: one at a time, and at most one per this many ms. */
export const TEST_COOLDOWN_MS = 10_000;

const META_URL = "discord.url";
const META_ENABLED = "discord.enabled";
const META_KINDS = "discord.kinds";

export type NotifyUpdate = { ok: true; config: NotifyConfig } | { ok: false; error: "env" | "bad_url" };

/**
 * Discord notifications as configured: DISCORD_WEBHOOK_URL (with
 * DISCORD_NOTIFY) when set, which wins and is read-only, else what an admin
 * saved in the panel. Every change re-points the one notifier.
 */
export class NotifySettings {
  constructor(
    private readonly o: {
      notifier: Pick<DiscordNotifier, "configure" | "test">;
      store: MetaStore;
      /** DISCORD_WEBHOOK_URL; empty when unset. */
      envUrl: string;
      /** DISCORD_NOTIFY, also the panel's default choice. */
      envKinds: readonly NotifyKind[];
      clock?: () => number;
    },
  ) {
    this.apply();
  }

  get fromEnv(): boolean {
    return this.o.envUrl !== "";
  }

  /** Whether messages go out: a webhook, turned on, with at least one kind. */
  get on(): boolean {
    const c = this.current();
    return c.url !== "" && c.enabled && c.kinds.length > 0;
  }

  view(): NotifyConfig {
    const c = this.current();
    return { source: this.fromEnv ? "env" : "panel", masked: c.url ? maskWebhookUrl(c.url) : null, enabled: c.enabled, kinds: [...c.kinds] };
  }

  /** A change from the panel. Fields left out keep their value; the URL is checked first. */
  update(change: NotifyChange): NotifyUpdate {
    if (this.fromEnv) return { ok: false, error: "env" };
    let url: string | null = null;
    if (change.url !== undefined) {
      url = parseWebhookUrl(change.url);
      if (!url) return { ok: false, error: "bad_url" };
    }
    const previous = this.o.store.getMeta(META_URL);
    if (url) this.o.store.setMeta(META_URL, url);
    if (change.enabled !== undefined) this.o.store.setMeta(META_ENABLED, change.enabled ? "true" : "false");
    if (change.kinds !== undefined) this.o.store.setMeta(META_KINDS, JSON.stringify(NOTIFY_KINDS.filter((k) => change.kinds!.includes(k))));
    // The old webhook would otherwise linger in the journal.
    if (url && previous && previous !== url) this.o.store.checkpoint?.();
    this.apply();
    return { ok: true, config: this.view() };
  }

  /** Forgets the panel's webhook. The kinds stay for the next one, which starts turned on. */
  clear(): NotifyUpdate {
    if (this.fromEnv) return { ok: false, error: "env" };
    this.o.store.setMeta(META_URL, "");
    this.o.store.setMeta(META_ENABLED, "true");
    this.o.store.checkpoint?.();
    this.apply();
    return { ok: true, config: this.view() };
  }

  /** A test message to the webhook in use, also while notifications are turned off. */
  async test(): Promise<SendResult> {
    const { url } = this.current();
    if (!url) return { ok: false, error: "not_configured" };
    const now = (this.o.clock ?? Date.now)();
    const left = (until: number) => Math.max(1, Math.ceil((until - now) / 1000));
    if (this.testing) return { ok: false, error: "busy", retryAfter: left(this.busyUntil) };
    // Discord limits each webhook on its own: another one is not held by this one's 429.
    if (url === this.limitedUrl && now < this.limitedUntil) return { ok: false, error: "rate_limited", retryAfter: left(this.limitedUntil) };
    if (now < this.busyUntil) return { ok: false, error: "busy", retryAfter: left(this.busyUntil) };
    this.testing = true;
    this.busyUntil = now + TEST_COOLDOWN_MS;
    try {
      const res = await this.o.notifier.test(url);
      if (res.ok) return res;
      // Nothing reached the channel: another (corrected) webhook can be tried at once.
      this.busyUntil = Number.NEGATIVE_INFINITY;
      if (res.error === "rate_limited") {
        // At least as long as Discord asked (capped by the notifier), never shorter than the usual pause.
        this.limitedUrl = url;
        this.limitedUntil = now + Math.max(TEST_COOLDOWN_MS, (res.retryAfter ?? 0) * 1000);
        return { ok: false, error: "rate_limited", retryAfter: left(this.limitedUntil) };
      }
      return res;
    } finally {
      this.testing = false;
    }
  }

  private testing = false;
  /** After a test that went out (or is going): no test to any webhook before this. */
  private busyUntil = Number.NEGATIVE_INFINITY;
  /** After Discord's 429: no test to `limitedUrl` before this. */
  private limitedUrl = "";
  private limitedUntil = Number.NEGATIVE_INFINITY;

  private current(): { url: string; enabled: boolean; kinds: readonly NotifyKind[] } {
    if (this.fromEnv) return { url: this.o.envUrl, enabled: true, kinds: this.o.envKinds };
    let kinds: readonly NotifyKind[] = this.o.envKinds;
    const raw = this.o.store.getMeta(META_KINDS);
    if (raw !== null) {
      try {
        const list: unknown = JSON.parse(raw);
        if (Array.isArray(list)) kinds = NOTIFY_KINDS.filter((k) => list.includes(k));
      } catch {
        // unreadable: the default choice
      }
    }
    return { url: this.o.store.getMeta(META_URL) ?? "", enabled: this.o.store.getMeta(META_ENABLED) !== "false", kinds };
  }

  private apply(): void {
    const c = this.current();
    this.o.notifier.configure(c.url && c.enabled ? { url: c.url, kinds: c.kinds } : null);
  }
}
