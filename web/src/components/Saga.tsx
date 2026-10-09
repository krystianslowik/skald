import { AnimatePresence, motion } from "motion/react";
import type { AgentEvent } from "../types";
import { gameVersion } from "../lib/format";
import { useI18n, type I18n, type TextKey } from "../i18n";
import { PlayerName } from "./Profile";

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
export function actionStatus(i: Pick<I18n, "t">, ok: boolean, message: string): string {
  if (!ok) return i.t("action.failed", { message });
  if (/complete/.test(message)) return i.t("action.done");
  if (/started/.test(message)) return i.t("action.inProgress");
  return i.t("action.requested");
}

export function actionTitle(i: Pick<I18n, "t">, name: string): string {
  const key = ACTION[name];
  return key ? i.t(key) : name;
}

type Tone = "join" | "leave" | "death" | "save" | "server" | "action" | "raid";

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
    default:
      return null;
  }
}

function Glyph({ tone }: { tone: Tone }) {
  const common = { width: 18, height: 18, viewBox: "0 0 20 20", fill: "none", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (tone) {
    case "join":
      return (
        <svg {...common} stroke="#ffb347" aria-hidden>
          <path d="M10 3v14M10 3l5 5M10 3L5 8" />
        </svg>
      );
    case "leave":
      return (
        <svg {...common} stroke="#9b8f84" aria-hidden>
          <path d="M6 15c0-3 3-3 3-6s-2-3-2-5M12 16c0-2 2-3 2-5s-1-2-1-4" />
        </svg>
      );
    case "death":
      return (
        <svg {...common} stroke="#c2412d" aria-hidden>
          <path d="M5 5l10 10M15 5L5 15M10 2v3M10 15v3" />
        </svg>
      );
    case "save":
      return (
        <svg {...common} stroke="#ff7a1a" aria-hidden>
          <path d="M4 10h12M10 4v12M6 6l8 8M14 6l-8 8" />
        </svg>
      );
    case "raid":
      return (
        <svg {...common} stroke="#c2412d" aria-hidden>
          <path d="M3 17L13 7M13 7l1-4 3 3-4 1M7 13l-2-2M17 17L7 7M7 7L6 3 3 6l4 1M13 13l2-2" />
        </svg>
      );
    case "action":
      return (
        <svg {...common} stroke="#ffb347" aria-hidden>
          <path d="M10 2v16M10 6l5-4M10 6L5 2" />
        </svg>
      );
    default:
      return (
        <svg {...common} stroke="#5b5650" aria-hidden>
          <path d="M10 2L18 10L10 18L2 10Z" />
        </svg>
      );
  }
}

/** The event scroll: newest first, grouped by day. */
export function Saga({ events, now }: { events: AgentEvent[]; now: number }) {
  const i18n = useI18n();
  const { t, dayLabel, clock, fullDate } = i18n;
  const rows = events.map((e) => ({ e, d: describe(i18n, e) })).filter((r): r is { e: AgentEvent; d: NonNullable<ReturnType<typeof describe>> } => r.d !== null);
  let lastDay = "";
  return (
    <div className="scroll-quiet relative max-h-[420px] overflow-y-auto pr-2 [mask-image:linear-gradient(180deg,#000_85%,transparent)]">
      {rows.length === 0 && <p className="text-sm text-ash">{t("saga.empty")}</p>}
      <ol className="relative border-l border-iron/40 pl-5">
        <AnimatePresence initial={false}>
          {rows.map(({ e, d }) => {
            const day = dayLabel(e.ts, now);
            const header = day !== lastDay ? day : null;
            lastDay = day;
            return (
              <motion.li
                key={`${e.ts}-${e.seq}-${e.type}`}
                layout="position"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ type: "spring", stiffness: 200, damping: 24 }}
              >
                {header && <div className="-ml-5 mb-1.5 mt-3 font-display text-xs font-semibold tracking-wider text-ash/80 first:mt-0">{header}</div>}
                <div className="relative flex items-start gap-3 py-1.5">
                  <span className="absolute -left-[29px] top-1.5 rounded-full bg-wood p-0.5">
                    <Glyph tone={d.tone} />
                  </span>
                  <span className={`flex-1 text-sm leading-snug ${d.tone === "death" || d.tone === "raid" ? "text-[#e3a091]" : d.tone === "leave" ? "text-ash" : "text-bone"}`}>
                    {d.player && d.text.startsWith(d.player) ? (
                      <>
                        <PlayerName name={d.player} className="font-medium" />
                        {d.text.slice(d.player.length)}
                      </>
                    ) : (
                      d.text
                    )}
                  </span>
                  <time className="shrink-0 pt-0.5 text-xs tabular-nums text-ash" dateTime={e.ts} title={fullDate(e.ts)}>
                    {clock(e.ts)}
                  </time>
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>
    </div>
  );
}
