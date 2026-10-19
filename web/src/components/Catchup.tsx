import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ApiCatchup, MapPoint } from "../types";
import { getCatchup } from "../lib/api";
import { catchupItems, readSeen, rebaseOf, seenOf, writeSeen, type CatchupItem, type Seen } from "../lib/catchup";
import { gameVersion } from "../lib/format";
import { locationName } from "../lib/mapgeo";
import { PHONE, useMedia } from "../lib/useMedia";
import { useI18n, type I18n } from "../i18n";
import { Plank } from "./Plank";
import { PlayerName } from "./PlayerName";
import { Glyph, type Tone } from "./Saga";

/** Where a line leads when tapped. */
export interface CatchupLinks {
  /** The map, on a spot when there is one. */
  onMap: (at?: MapPoint) => void;
  onSaga: () => void;
  onProgress: () => void;
}

/** How soon a cut-short answer is asked for again. */
const PARTIAL_RETRY_MS = 30_000;

/** Lines shown before "show more": few on a phone, where the card sits between the code and the fire. */
const MAX_LINES = 6;
const MAX_LINES_PHONE = 3;

type Mark = Tone | "play" | "boss" | "found" | "built" | "lost";

/** The saga's slot icons, and a few for what only the catch-up tells. */
function Icon({ mark }: { mark: Mark }) {
  const common = { width: 16, height: 16, viewBox: "0 0 20 20", fill: "none", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (mark) {
    case "play":
      // An hourglass: time at the fire.
      return (
        <svg {...common} stroke="#f3b867">
          <path d="M5 2.5h10M5 17.5h10M6 2.5c0 4 4 5 4 7.5S6 13.5 6 17.5M14 2.5c0 4-4 5-4 7.5s4 3.5 4 7.5" />
          <path d="M8 16h4" />
        </svg>
      );
    case "boss":
      // A horned skull: a trophy.
      return (
        <svg {...common} stroke="#ecc212">
          <path d="M4 3c0 3 1.5 4.5 3 5M16 3c0 3-1.5 4.5-3 5M6 10a4 4 0 018 0v3l-1.5 1v2.5h-5V14L6 13z" />
          <path d="M8.5 11.5h.01M11.5 11.5h.01" />
        </svg>
      );
    case "found":
      // A compass rose.
      return (
        <svg {...common} stroke="#8cbce6">
          <path d="M10 2l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" />
        </svg>
      );
    case "built":
      // A roof on two posts.
      return (
        <svg {...common} stroke="#f3b867">
          <path d="M2.5 9.5L10 3l7.5 6.5M5 8v9h10V8M8.5 17v-4h3v4" />
        </svg>
      );
    case "lost":
      return <Glyph tone="leave" />;
    default:
      return <Glyph tone={mark} />;
  }
}

interface Line {
  key: string;
  mark: Mark;
  text: string;
  /** The text starts with this player's name: it becomes the profile link. */
  player?: string;
  open?: () => void;
  tone?: string;
}

const km2 = (i: I18n, m2: number) => i.number(m2 / 1_000_000, m2 < 1_000_000 ? 2 : 1);

function lineOf(i: I18n, item: CatchupItem, links: CatchupLinks): Line {
  const { t, tn, lookup, duration } = i;
  switch (item.kind) {
    case "player": {
      const p = item.player;
      const played = t(p.online ? "catchup.playerNow" : "catchup.player", { name: p.name, duration: duration(p.playtimeMs) });
      const text = p.deaths > 0 ? `${played} · ${tn("catchup.deaths", p.deaths)}` : played;
      return { key: `p:${p.name}`, mark: "play", text, player: p.name };
    }
    case "boss":
      return { key: `b:${item.key}`, mark: "boss", text: t("catchup.boss", { boss: lookup(`boss.${item.key}`) ?? item.key }), open: links.onProgress, tone: "text-gold" };
    case "place": {
      const name = locationName(item.place.name, item.place.kind, lookup);
      return { key: `l:${item.place.name}@${item.place.x},${item.place.z}`, mark: "found", text: t("catchup.place", { place: name }), open: () => links.onMap(item.place) };
    }
    case "places":
    case "bases":
    case "portals": {
      return { key: item.kind, mark: item.kind === "places" ? "found" : "built", text: tn(`catchup.${item.kind}`, item.n), open: () => links.onMap(item.at) };
    }
    case "ships":
    case "carts":
      return { key: item.kind, mark: "built", text: tn(`catchup.${item.kind}`, item.n), open: () => links.onMap() };
    case "shipsLost":
    case "cartsLost":
      return { key: item.kind, mark: "lost", text: tn(`catchup.${item.kind}`, item.n), open: () => links.onMap(), tone: "text-ash" };
    case "explored":
      return { key: "explored", mark: "found", text: t("catchup.explored", { km: km2(i, item.m2) }), open: () => links.onMap() };
    case "raids":
      return { key: "raids", mark: "raid", text: tn("catchup.raids", item.n), open: links.onSaga };
    case "update":
      return { key: `u:${item.version}`, mark: "server", text: t("catchup.update", { version: gameVersion(item.version) }), open: links.onSaga };
    case "restarts":
      return { key: "restarts", mark: "server", text: tn("catchup.restarts", item.n), open: links.onSaga };
    case "restores":
      return { key: "restores", mark: "action", text: tn("catchup.restores", item.n), open: links.onSaga };
    case "backups":
      return { key: "backups", mark: "save", text: tn("catchup.backups", item.n), open: links.onSaga };
    case "settings":
      return { key: "settings", mark: "settings", text: tn("catchup.settings", item.n), open: links.onSaga };
  }
}

/**
 * "18:40" today, "yesterday", else "14 October": when the window starts.
 * Not `dayLabel`: its weekday reads wrong after "since" in Polish ("od wtorek").
 */
function whenText(i: I18n, iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const n = new Date(now);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(n) - start(d)) / 86_400_000);
  if (days <= 0) return i.clock(iso);
  if (days === 1) return i.t("day.yesterday").toLocaleLowerCase(i.intl);
  return d.toLocaleDateString(i.intl, { day: "numeric", month: "long" });
}

/** The row's look: the saga's message-feed line, as a button when it leads somewhere. */
function Row({ line }: { line: Line }) {
  const body: ReactNode = (
    <>
      <span className="slot grid h-7 w-7 shrink-0 place-items-center" data-mark={line.mark}>
        <Icon mark={line.mark} />
      </span>
      <span className={`on-world flex-1 text-sm font-bold leading-snug ${line.tone ?? "text-bone"}`}>
        {line.player && line.text.startsWith(line.player) ? (
          <>
            <PlayerName name={line.player} />
            {line.text.slice(line.player.length)}
          </>
        ) : (
          line.text
        )}
      </span>
    </>
  );
  if (!line.open) return <div className="flex items-center gap-2.5 py-1 coarse:min-h-11">{body}</div>;
  return (
    <button type="button" onClick={line.open} className="press-soft -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2.5 rounded-[2px] px-1 py-1 text-left hover:bg-black/25 coarse:min-h-11">
      {body}
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden className="shrink-0 text-ash">
        <path d="M4.5 2.5L8 6l-3.5 3.5" />
      </svg>
    </button>
  );
}

/**
 * "Since you were last here": who played and for how long, what was found,
 * built or lost, and what the server went through, since this browser last
 * marked the card read (or the last week). Read, it folds to one quiet line
 * until something new happens. `pulse` changes when the events or the save
 * do, and asks again.
 */
export function Catchup({ pulse, links, className = "" }: { pulse: string; links: CatchupLinks; className?: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const reduced = useReducedMotion();
  const phone = useMedia(PHONE);
  const [seen, setSeen] = useState<Seen | null>(readSeen);
  const [all, setAll] = useState(false);
  // The answer, with the `since` it was asked for: one for an older window is not shown.
  const [answer, setAnswer] = useState<{ since: string | null; data: ApiCatchup } | null>(null);
  const since = seen?.at ?? null;

  // Asked again while the server's window stops short (its agent link down or still replaying).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    getCatchup(since, ctl.signal).then(
      (data) => setAnswer({ since, data }),
      // Offline or signed out: the card stays as it was; the app handles a lost session.
      () => {},
    );
    return () => ctl.abort();
  }, [since, pulse, tick]);

  const data = answer && answer.since === since ? answer.data : null;
  // Re-armed on every try, so a failed one does not end the asking.
  useEffect(() => {
    if (!data?.partial) return;
    const timer = setTimeout(() => setTick((n) => n + 1), PARTIAL_RETRY_MS);
    return () => clearTimeout(timer);
  }, [data, tick]);
  // The stored world no longer applies (another world, a restore): take the new one now.
  useEffect(() => {
    const next = data && rebaseOf(data, seen);
    if (!next) return;
    writeSeen(next);
    setSeen(next);
  }, [data, seen]);

  const items = useMemo(() => (data ? catchupItems(data, seen) : []), [data, seen]);
  const lines = useMemo(() => items.map((it) => lineOf(i18n, it, links)), [items, i18n, links]);

  const read = useCallback(() => {
    if (!data) return;
    const next = seenOf(data, seen);
    writeSeen(next);
    setSeen(next);
    setAll(false);
    // Folds at once; the next answer for the new window replaces this.
    setAnswer({ since: next.at, data: { ...data, since: next.at, clamped: false, partial: false, players: [], raids: 0, backups: 0, restores: 0, restarts: 0, updates: [], settings: 0 } });
  }, [data, seen]);

  // Nothing until the first answer: no flash of "nothing new".
  if (!data) return null;
  // A long list: the first lines, the rest one tap away.
  const max = phone ? MAX_LINES_PHONE : MAX_LINES;
  // A phone shows `max` at most; wider screens show one more rather than a "Show 1 more" as tall as it.
  const hidden = all || lines.length <= max + (phone ? 0 : 1) ? 0 : lines.length - max;
  const shown = hidden > 0 ? lines.slice(0, max) : lines;
  const spring = { type: "spring", bounce: 0, visualDuration: 0.35 } as const;
  return (
    <div className={className}>
      <AnimatePresence initial={false} mode="wait">
        {lines.length > 0 ? (
          <motion.div
            key="card"
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={spring}
            className="overflow-hidden"
          >
            <Plank title={t("catchup.title")} id="catchup" aside={data.clamped ? t("catchup.week") : t("catchup.since", { when: whenText(i18n, data.since) })}>
              {/* Two columns on wide screens: the lines are short. */}
              <ul className="space-y-0.5 lg:grid lg:grid-cols-2 lg:gap-x-10 lg:space-y-0">
                {shown.map((line) => (
                  <li key={line.key}>
                    <Row line={line} />
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center justify-end gap-2">
                {hidden > 0 && (
                  <button type="button" onClick={() => setAll(true)} className="press min-h-11 px-3 text-sm font-bold text-ash hover:text-bone">
                    {t("catchup.more", { n: hidden })}
                  </button>
                )}
                <button type="button" onClick={read} className="plaque press min-h-11 px-5 text-sm font-bold">
                  {t("catchup.read")}
                </button>
              </div>
            </Plank>
          </motion.div>
        ) : (
          <motion.p key="quiet" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="on-world text-center text-sm text-ash">
            {data.clamped ? t("catchup.noneWeek") : t("catchup.none", { when: whenText(i18n, data.since) })}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
