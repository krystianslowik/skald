import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo, useMemo } from "react";
import type { AgentEvent } from "../types";
import { gameVersion } from "../lib/format";
import { useI18n, type I18n, type TextKey } from "../i18n";
import { PlayerName } from "./PlayerName";

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
      return (
        <svg {...common} stroke="#d79c34" aria-hidden>
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
    default:
      return (
        <svg {...common} stroke="#8a7a6a" aria-hidden>
          <path d="M10 2L18 10L10 18L2 10Z" />
        </svg>
      );
  }
}

/** The event scroll: newest first, grouped by day. */
export const Saga = memo(function Saga({ events, now }: { events: AgentEvent[]; now: number }) {
  const i18n = useI18n();
  const { t, dayLabel, clock, fullDate } = i18n;
  const reduced = useReducedMotion();
  const rows = useMemo(
    () => events.flatMap((e) => {
      const d = describe(i18n, e);
      return d ? [{ e, d }] : [];
    }),
    [events, i18n],
  );
  let lastDay = "";
  return (
    <div className="scroll-quiet relative max-h-[26.25rem] overflow-y-auto pr-2 [mask-image:linear-gradient(180deg,#000_85%,transparent)]">
      {rows.length === 0 && <p className="text-sm text-ash">{t("saga.empty")}</p>}
      <ol className="relative">
        <AnimatePresence initial={false}>
          {rows.map(({ e, d }) => {
            const day = dayLabel(e.ts, now);
            const header = day !== lastDay ? day : null;
            lastDay = day;
            const time = (
              <time className="shrink-0 text-xs tabular-nums text-ash" dateTime={e.ts} title={fullDate(e.ts)}>
                {clock(e.ts)}
              </time>
            );
            return (
              <motion.li
                key={`${e.ts}-${e.seq}-${e.type}`}
                layout={reduced ? false : "position"}
                initial={{ opacity: 0, x: reduced ? 0 : -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ type: "spring", bounce: 0, visualDuration: 0.35 }}
              >
                {header && (
                  <div className="mb-1 mt-3 flex items-center gap-3 first:mt-0">
                    <span className="label-caps shrink-0">{header}</span>
                    <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-iron/60 to-transparent" />
                  </div>
                )}
                {d.tone === "raid" ? (
                  // A raid reads like the game's centre-screen warning: gold caps, no box.
                  <div className="flex flex-col items-center py-3 text-center">
                    <span className="raid-cry text-lg leading-tight sm:text-xl">{d.text}</span>
                    {time}
                  </div>
                ) : (
                  // Everything else is a line in the top-left message feed: a small slot icon and the text.
                  <div className="flex items-center gap-2.5 py-1">
                    <span className="slot grid h-7 w-7 shrink-0 place-items-center">
                      <Glyph tone={d.tone} />
                    </span>
                    <span className={`on-world flex-1 text-sm font-bold leading-snug ${d.tone === "death" ? "text-blood" : d.tone === "leave" ? "text-ash" : "text-bone"}`}>
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
                )}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>
    </div>
  );
});
