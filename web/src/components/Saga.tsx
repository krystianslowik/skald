import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo, useId, useMemo, useState, type ReactNode } from "react";
import { isPlatform, type AgentEvent, type Platform } from "../types";
import { gameVersion } from "../lib/format";
import { sagaRows, type SagaRow } from "../lib/saga";
import { gameClock } from "../lib/admin";
import { refusalReason } from "../lib/refusal";
import { itemLabel } from "../lib/storage";
import { useI18n, type I18n, type TextKey } from "../i18n";
import { PlayerName } from "./PlayerName";
import { DayLabel } from "./RelativeTime";

const SERVER_STATE: Record<string, TextKey> = {
  starting: "saga.server.starting",
  running: "saga.server.running",
  stopping: "saga.server.stopping",
  stopped: "saga.server.stopped",
};

const ACTION: Record<string, TextKey> = {
  backup: "action.backup",
  restart: "action.restart",
  update: "action.update",
};

/**
 * Agent action results, as a short status. backup/update are signals the
 * image handles asynchronously (up to ~20 s), so "requested" rather than
 * "done"; only restart reports completion.
 */
const COMPLETE = /complete/;
const STARTED = /started/;

export function actionStatus(i: Pick<I18n, "t">, ok: boolean, message: string): string {
  if (!ok) return i.t("action.failed", { message });
  if (COMPLETE.test(message)) return i.t("action.done");
  if (STARTED.test(message)) return i.t("action.inProgress");
  return i.t("action.requested");
}

export function actionTitle(i: Pick<I18n, "t">, name: string): string {
  const key = ACTION[name];
  return key ? i.t(key) : name;
}

export type Tone = "join" | "leave" | "death" | "save" | "slow" | "server" | "action" | "raid" | "settings" | "admin";

/** Commands whose saga line names a player when there was one ("for X", "near X"). */
const WITH_PLAYER = new Set(["spawn", "creature-spawn", "creature-kill", "creature-tame", "repair", "fill", "fill-kilns", "fill-smelters", "fill-fermenters", "grow", "map-reveal", "map-pins", "event-start"]);

/** "20 Wood, Iron sword ★3 and 2 more": what a spawn dropped. */
function itemsText(i: Pick<I18n, "lookup" | "t">, d: Record<string, unknown>): string {
  const lines = Array.isArray(d.items) ? (d.items as Record<string, unknown>[]) : d.item ? [d] : [];
  const parts = lines.slice(0, 3).map((l) => {
    const n = Number(l.amount ?? 1) || 1;
    const q = Number(l.quality ?? 1) || 1;
    return `${n > 1 ? `${n} ` : ""}${itemLabel(String(l.item ?? "?"), i.lookup)}${q > 1 ? ` ${"\u2605".repeat(Math.min(q, 5))}` : ""}`;
  });
  const more = lines.length - parts.length;
  return more > 0 ? i.t("saga.admin.more", { list: parts.join(", "), n: more }) : parts.join(", ");
}

/**
 * "scrap iron and coal": what a fill command put in, by the items the bridge
 * reported. Mead bases keep their capitals ("Mead Base: Tasty").
 */
export function fillText(i: Pick<I18n, "lookup" | "intl">, d: Record<string, unknown>, lower = true): string {
  const added = d.added && typeof d.added === "object" ? Object.keys(d.added) : [];
  const names = [...added, ...(typeof d.fuel === "string" && d.fuel ? [d.fuel] : [])];
  const labels = names.map((n) => {
    const label = i.lookup(`admin.fill.item.${n}`) ?? itemLabel(n, i.lookup);
    return lower ? label.toLocaleLowerCase(i.intl) : label;
  });
  return new Intl.ListFormat(i.intl, { type: "conjunction" }).format(labels);
}

const platformKey = (p: unknown): Platform => (isPlatform(p) ? p : "unknown");

/** One step of a world restore: each outcome its own line, failures saying what was kept. */
function describeRestore(i: I18n, d: Record<string, unknown>, actor: string): string {
  const { t, lookup } = i;
  const step = String(d.step ?? "");
  const vars = { actor, backup: String(d.backup ?? ""), archive: String(d.archive ?? ""), n: Number(d.files ?? 0), error: String(d.error ?? "") };
  const key = d.result === "ok" ? `saga.restore.${step}` : `saga.restore.${step}.error`;
  return lookup(key, vars) ?? t("saga.admin.failed", { actor, what: t("saga.admin.cmd.restore"), error: vars.error });
}

/** An admin command from the bridge's audit trail, as a line of the saga. */
export function describeAdmin(i: I18n, d: Record<string, unknown>): string {
  const { t, lookup } = i;
  const raw = String(d.actor ?? "");
  const actor = !raw || raw === "unknown" || raw.startsWith("dashboard-") ? t("saga.admin.someone") : raw;
  const command = String(d.command ?? "");
  if (command === "restore") return describeRestore(i, d, actor);
  // A list file changed by the agent: the player by name, or unnamed with a masked id.
  const fileChange = d.via === "file";
  const player = typeof d.player === "string" ? d.player : fileChange ? t("saga.admin.anon", { platform: t(`platform.${platformKey(d.platform)}`), masked: String(d.masked ?? "") }) : "";
  if (fileChange && d.result === "ok") {
    const key = command === "unban" ? "saga.admin.unban.who" : `saga.admin.${command}`;
    const line = lookup(key, { actor, player }) ?? t("saga.admin.generic", { actor, what: lookup(`saga.admin.cmd.${command}`) ?? command });
    return t("saga.admin.afterRestart", { line });
  }
  if (d.result !== "ok") {
    const what = lookup(`saga.admin.cmd.${command}`) ?? command;
    const error = String(d.error ?? "");
    return d.result === "error" ? t("saga.admin.failed", { actor, what, error: refusalReason(i, error) ?? error }) : t("saga.admin.timeout", { actor, what });
  }
  const vars: Record<string, string | number> = { actor, player };
  switch (command) {
    case "spawn":
      vars.what = itemsText(i, d);
      break;
    case "chest-add": {
      vars.what = itemsText(i, d);
      const at = (d.at ?? {}) as { x?: unknown; z?: unknown };
      vars.x = Number.isFinite(Number(at.x)) ? Math.round(Number(at.x)) : "?";
      vars.z = Number.isFinite(Number(at.z)) ? Math.round(Number(at.z)) : "?";
      break;
    }
    case "broadcast":
      vars.text = String(d.text ?? "");
      break;
    case "time":
      vars.clock = gameClock(Number(d.dayFraction) || 0);
      break;
    case "event-start":
      vars.raid = i.raidLabel(String(d.name ?? d.started ?? ""));
      break;
    case "teleport":
      vars.where = typeof d.toPlayer === "string" ? d.toPlayer : typeof d.toSpot === "string" ? (lookup(`spot.${d.toSpot}`) ?? d.toSpot) : t("saga.admin.somewhere");
      break;
    case "globalkey-set":
    case "globalkey-remove": {
      const key = String(d.key ?? "");
      vars.key = lookup(`boss.${key}`) ?? lookup(`gkey.${key}`) ?? key;
      break;
    }
    case "creature-spawn":
      vars.n = Number(d.count ?? 1) || 1;
      vars.creature = lookup(`creature.${d.prefab}`) ?? String(d.prefab ?? "?");
      break;
    case "creature-kill":
      vars.n = Number(d.killed ?? 0);
      break;
    case "creature-tame":
      vars.n = Number(d.tamed ?? 0);
      break;
    case "repair":
      vars.n = Number(d.repaired ?? 0);
      break;
    case "fill":
      vars.n = Number(d.smelters ?? 0) + Number(d.fermenters ?? 0);
      break;
    case "fill-kilns":
    case "fill-smelters":
    case "fill-fermenters":
      return describeFill(i, command, d, actor, player);
    case "grow":
      vars.n = Number(d.plants ?? 0);
      break;
    case "map-reveal":
    case "map-pins":
      vars.n = Number(d.tables ?? 0);
      break;
    case "status":
      vars.effect = lookup(`effect.${d.effect}`) ?? String(d.effect ?? "");
      break;
    case "ack-build":
      vars.build = gameVersion(String(d.build ?? ""));
      break;
  }
  const key = WITH_PLAYER.has(command) && !player ? `saga.admin.${command}.at` : `saga.admin.${command}`;
  return lookup(key, vars) ?? t("saga.admin.generic", { actor, what: lookup(`saga.admin.cmd.${command}`) ?? command });
}

/**
 * "filled 3 smelters with scrap iron and coal near Ragnar"; or that the
 * stations there were full or refused the ore; or that there were none.
 */
function describeFill(i: I18n, command: "fill-kilns" | "fill-smelters" | "fill-fermenters", d: Record<string, unknown>, actor: string, player: string): string {
  const n = Number((command === "fill-kilns" ? d.kilns : command === "fill-smelters" ? d.smelters : d.fermenters) ?? 0) || 0;
  const vars = { actor, player, what: fillText(i, d, command !== "fill-fermenters") };
  if (n > 0) return i.tn(player ? `saga.admin.${command}` : `saga.admin.${command}.at`, n, vars);
  const untouched = (Number(d.skipped ?? 0) || 0) + (Number(d.full ?? 0) || 0) > 0;
  const key = `saga.admin.${command}${untouched ? ".unchanged" : ".none"}${player ? "" : ".at"}`;
  return i.lookup(key, vars) ?? i.t("saga.admin.generic", { actor, what: i.t(`saga.admin.cmd.${command}`) });
}

const SETTINGS_APPLY: Record<string, TextKey> = {
  armed: "saga.settingsArmed",
  cancelled: "saga.settingsCancelled",
  applying: "saga.settingsApplying",
  applied: "saga.settingsApplied",
  failed: "saga.settingsFailed",
};

/** A settings_changed key as words: "name", "raids", "no map". Never a value. */
export function settingLabel(i: Pick<I18n, "lookup">, key: string): string {
  if (key.startsWith("modifier.")) return i.lookup(`mod.${key.slice(9)}`) ?? key.slice(9);
  if (key.startsWith("key.")) return i.lookup(`setkey.${key.slice(4)}`)?.toLowerCase() ?? key.slice(4);
  return i.lookup(`setkeyname.${key}`) ?? key;
}

/** `player` is set when the text starts with a player name (rendered as a profile link). */
export function describe(i: I18n, ev: AgentEvent): { text: string; tone: Tone; player?: string } | null {
  const { t } = i;
  const d = ev.data;
  const name = String(d.name ?? "");
  switch (ev.type) {
    case "player_join":
      return { text: t("saga.join", { name }), tone: "join", player: name };
    case "player_leave":
      return { text: t("saga.leave", { name }), tone: "leave", player: name };
    case "death":
      return { text: t("saga.death", { name }), tone: "death", player: name };
    case "world_saved":
      return { text: d.ms ? t("saga.saved", { ms: String(d.ms) }) : t("saga.savedPlain"), tone: "save" };
    case "world_backup":
      return { text: t("saga.backup"), tone: "save" };
    case "server_state": {
      const key = SERVER_STATE[String(d.status)];
      return key ? { text: t(key), tone: "server" } : null;
    }
    case "join_code":
      return { text: t("saga.joinCode", { code: String(d.code ?? "") }), tone: "server" };
    case "version":
      return { text: t("saga.version", { version: gameVersion(String(d.version ?? "")) }), tone: "server" };
    case "raid":
      return { text: t("saga.raid", { raid: i.raidLabel(name) }), tone: "raid" };
    case "playfab":
      return d.state === "error" ? { text: t("saga.playfabError"), tone: "death" } : null;
    case "action":
      return { text: t("saga.action", { what: actionTitle(i, String(d.name)), status: actionStatus(i, Boolean(d.ok), String(d.message ?? "")) }), tone: "action" };
    case "settings_changed": {
      const keys = Array.isArray(d.changedKeys) ? d.changedKeys.map(String) : [];
      if (keys.length === 0) return null;
      return { text: t("saga.settingsChanged", { what: keys.map((k) => settingLabel(i, k)).join(", ") }), tone: "settings" };
    }
    case "settings_apply": {
      const key = SETTINGS_APPLY[String(d.state)];
      return key ? { text: t(key), tone: d.state === "failed" ? "death" : "settings" } : null;
    }
    case "admin":
      return { text: describeAdmin(i, d), tone: d.result === "ok" ? "admin" : "death" };
    case "task": {
      const title = String(d.title ?? "");
      if (!title) return null;
      return { text: typeof d.owner === "string" && d.owner ? t("saga.taskBy", { title, owner: d.owner }) : t("saga.task", { title }), tone: "action" };
    }
    default:
      return null;
  }
}

export function Glyph({ tone }: { tone: Tone }) {
  const common = { width: 16, height: 16, viewBox: "0 0 20 20", fill: "none", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (tone) {
    case "join":
      return (
        <svg {...common} stroke="#f3b867" aria-hidden>
          <path d="M10 3v14M10 3l5 5M10 3L5 8" />
        </svg>
      );
    case "leave":
      return (
        <svg {...common} stroke="#b3a596" aria-hidden>
          <path d="M6 15c0-3 3-3 3-6s-2-3-2-5M12 16c0-2 2-3 2-5s-1-2-1-4" />
        </svg>
      );
    case "death":
      return (
        <svg {...common} stroke="#e86a5a" aria-hidden>
          <path d="M5 5l10 10M15 5L5 15M10 2v3M10 15v3" />
        </svg>
      );
    case "save":
    case "slow":
      return (
        <svg {...common} stroke={tone === "slow" ? "#ecc212" : "#d79c34"} aria-hidden>
          <path d="M4 10h12M10 4v12M6 6l8 8M14 6l-8 8" />
        </svg>
      );
    case "raid":
      return (
        <svg {...common} stroke="#ecc212" aria-hidden>
          <path d="M3 17L13 7M13 7l1-4 3 3-4 1M7 13l-2-2M17 17L7 7M7 7L6 3 3 6l4 1M13 13l2-2" />
        </svg>
      );
    case "action":
      return (
        <svg {...common} stroke="#f3b867" aria-hidden>
          <path d="M10 2v16M10 6l5-4M10 6L5 2" />
        </svg>
      );
    case "admin":
      return (
        <svg {...common} stroke="#ecc212" aria-hidden>
          <path d="M3 17h14M6 17l1.2-3h5.6L14 17M11.5 2.5l3 3M9.5 4.5l3-3 3 3-3 3zM10.5 6.5L6 11" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common} stroke="#8cbce6" aria-hidden>
          <path d="M3 5h8M14 5h3M3 10h2M8 10h9M3 15h10M16 15h1M12.5 3.5v3M6.5 8.5v3M14.5 13.5v3" />
        </svg>
      );
    default:
      return (
        <svg {...common} stroke="#8a7a6a" aria-hidden>
          <path d="M10 2L18 10L10 18L2 10Z" />
        </svg>
      );
  }
}

type Line = { text: string; tone: Tone; player?: string };

/** The words for one saga row; a fold reads "World saved 47×, 12 backups · last 16:09". */
function rowLine(i18n: I18n, row: SagaRow): Line | null {
  const { t, tn, clock, duration } = i18n;
  switch (row.kind) {
    case "visit": {
      const { name, join, leave } = row;
      const text = leave
        ? t("saga.visit", { name, from: clock(join.ts), to: clock(leave.ts), duration: duration(Date.parse(leave.ts) - Date.parse(join.ts)) })
        : t("saga.visitOpen", { name, from: clock(join.ts) });
      return { text, tone: "join", player: name };
    }
    case "fold": {
      const parts = row.saves > 0 ? [t("saga.fold.saves", { n: row.saves }), ...(row.backups > 0 ? [tn("saga.fold.backups", row.backups)] : [])] : [tn("saga.fold.backupsOnly", row.backups)];
      return { text: `${parts.join(", ")} · ${t("saga.fold.last", { time: clock(row.e.ts) })}`, tone: "save" };
    }
    case "event": {
      const d = describe(i18n, row.e);
      if (!d) return null;
      if (row.updated) return { text: t("saga.versionUpdated", { version: gameVersion(String(row.e.data.version ?? "")) }), tone: "server" };
      return row.slow ? { ...d, tone: "slow" } : d;
    }
  }
}

const TEXT_TONE: Partial<Record<Tone, string>> = { death: "text-blood", leave: "text-ash", slow: "text-gold" };

/** A line in the top-left message feed: a small slot icon, the text, the time. */
function FeedLine({ d, time, quiet = false }: { d: Line; time?: ReactNode; quiet?: boolean }) {
  return (
    // A touch row is 44 px tall: a name in it gets the full finger-sized target, not half of it shared with the next row's.
    <div className="flex items-center gap-2.5 py-1 coarse:min-h-11">
      <span className="slot grid h-7 w-7 shrink-0 place-items-center">
        <Glyph tone={d.tone} />
      </span>
      <span className={`on-world flex-1 text-sm font-bold leading-snug ${quiet ? "text-ash" : (TEXT_TONE[d.tone] ?? "text-bone")}`}>
        {d.player && d.text.startsWith(d.player) ? (
          <>
            <PlayerName name={d.player} />
            {d.text.slice(d.player.length)}
          </>
        ) : (
          d.text
        )}
      </span>
      {time}
    </div>
  );
}

/** The event scroll: newest first, grouped by day; routine saves fold away, a visit is one line. */
export const Saga = memo(function Saga({ events, online }: { events: AgentEvent[]; online?: readonly { id?: string; name: string }[] }) {
  const i18n = useI18n();
  const { t, clock, fullDate } = i18n;
  const reduced = useReducedMotion();
  const foldId = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => {
    const shown = events.filter((e) => describe(i18n, e) !== null);
    return sagaRows(shown, online ? new Set(online.map((p) => p.id ?? p.name)) : undefined).flatMap((row) => {
      const d = rowLine(i18n, row);
      return d ? [{ row, d }] : [];
    });
  }, [events, online, i18n]);
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const timeOf = (ts: string) => (
    <time className="shrink-0 text-xs tabular-nums text-ash" dateTime={ts} title={fullDate(ts)}>
      {clock(ts)}
    </time>
  );
  const spring = { type: "spring", bounce: 0, visualDuration: 0.35 } as const;
  let lastDay = "";
  return (
    <div className="scroll-quiet relative max-h-105 overflow-y-auto pr-2 mask-[linear-gradient(180deg,#000_85%,transparent)]">
      {rows.length === 0 && <p className="text-sm text-ash">{t("saga.empty")}</p>}
      <ol className="relative">
        <AnimatePresence initial={false}>
          {rows.map(({ row, d }) => {
            const e = row.e;
            // Grouped by calendar day; only the label ("Today") follows the clock.
            const day = new Date(e.ts).toDateString();
            const header = day !== lastDay;
            lastDay = day;
            const expanded = row.kind === "fold" && open.has(row.key);
            const listId = `${foldId}-${row.key}`;
            return (
              <motion.li
                key={row.key}
                layout={reduced ? false : "position"}
                initial={{ opacity: 0, x: reduced ? 0 : -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={spring}
              >
                {header && (
                  <div className="mb-1 mt-3 flex items-center gap-3 first:mt-0">
                    <span className="label-caps shrink-0">
                      <DayLabel iso={e.ts} />
                    </span>
                    <span aria-hidden className="h-px flex-1 bg-linear-to-r from-iron/60 to-transparent" />
                  </div>
                )}
                {d.tone === "raid" ? (
                  // A raid reads like the game's centre-screen warning: gold caps, no box.
                  <div className="flex flex-col items-center py-3 text-center">
                    <span className="raid-cry text-lg leading-tight sm:text-xl">{d.text}</span>
                    {timeOf(e.ts)}
                  </div>
                ) : row.kind === "fold" ? (
                  // Routine bookkeeping: one quiet line that opens into the saves it stands for.
                  <>
                    <button
                      type="button"
                      onClick={() => toggle(row.key)}
                      aria-expanded={expanded}
                      aria-controls={expanded ? listId : undefined}
                      className="press-soft -mx-1 block w-[calc(100%+0.5rem)] rounded-[2px] px-1 text-left hover:bg-black/25"
                    >
                      <FeedLine
                        d={d}
                        quiet
                        time={
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden className={`shrink-0 text-ash transition-transform ${expanded ? "rotate-180" : ""}`}>
                            <path d="M2.5 4.5L6 8l3.5-3.5" />
                          </svg>
                        }
                      />
                    </button>
                    <AnimatePresence initial={false}>
                      {expanded && (
                        <motion.ol
                          id={listId}
                          className="overflow-hidden border-l border-iron/40 pl-3"
                          initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                          animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
                          exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                          transition={spring}
                        >
                          {row.events.map((f) => {
                            const fd = describe(i18n, f);
                            return fd ? (
                              <li key={`${f.ts}-${f.seq}-${f.type}`}>
                                <FeedLine d={fd} quiet time={timeOf(f.ts)} />
                              </li>
                            ) : null;
                          })}
                        </motion.ol>
                      )}
                    </AnimatePresence>
                  </>
                ) : (
                  <FeedLine d={d} time={row.kind === "visit" ? undefined : timeOf(e.ts)} />
                )}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>
    </div>
  );
});
