import { motion, useReducedMotion } from "motion/react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Badge, DailyPlay, PlayerProfile } from "../types";
import { getPlayer } from "../lib/api";
import { useI18n } from "../i18n";
import { Shield } from "./Shield";

/** Opens a warrior's profile; null where names should stay plain text. */
const OpenProfile = createContext<((name: string, opener: HTMLElement) => void) | null>(null);
export const ProfileProvider = OpenProfile.Provider;

/** A player's name that opens their profile sheet. */
export function PlayerName({ name, className = "" }: { name: string; className?: string }) {
  const { t } = useI18n();
  const open = useContext(OpenProfile);
  if (!open) return <span className={className}>{name}</span>;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      title={t("profile.open", { name })}
      onClick={(e) => open(name, e.currentTarget)}
      className={`max-w-full cursor-pointer decoration-ember/60 underline-offset-4 transition-colors hover:text-flame hover:underline ${className}`}
    >
      {name}
    </button>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Intl formatters for the active language, built once per language. */
function useFormats() {
  const { intl } = useI18n();
  return useMemo(() => {
    const dayFmt = new Intl.DateTimeFormat(intl, { day: "numeric", month: "short", timeZone: "UTC" });
    return {
      date: new Intl.DateTimeFormat(intl, { dateStyle: "long" }),
      shortDate: new Intl.DateTimeFormat(intl, { dateStyle: "medium" }),
      /** `YYYY-MM-DD` calendar day (already in the server's zone) -> "9 Oct". */
      dayLabel: (day: string) => dayFmt.format(new Date(`${day}T12:00:00Z`)),
    };
  }, [intl]);
}

/** Slide-in sheet (full screen on phones) with a warrior's stats, last 30 days and badges. */
export function ProfileSheet({ name, now, onClose }: { name: string; now: number; onClose: () => void }) {
  const { t, ago } = useI18n();
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setProfile(null);
    setFailed(false);
    getPlayer(name)
      .then((p) => live && setProfile(p))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [name]);

  useEffect(() => {
    closeBtn.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Keep Tab inside the dialog.
  const trap = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const spring = { type: "spring" as const, stiffness: 260, damping: 32, mass: 0.9 };
  return (
    <div className="fixed inset-0 z-50">
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        onClick={onClose}
      />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-h"
        onKeyDown={trap}
        className="plank scroll-quiet absolute inset-0 overflow-y-auto overscroll-contain rounded-none border-l border-ember/20 px-5 pb-10 pt-6 sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[460px] sm:rounded-l-lg sm:px-7"
        initial={reduced ? { opacity: 0 } : { x: "100%" }}
        animate={reduced ? { opacity: 1 } : { x: 0 }}
        exit={reduced ? { opacity: 0 } : { x: "100%" }}
        transition={reduced ? { duration: 0.2 } : spring}
      >
        <header className="flex items-center gap-4 pl-2">
          <Shield name={name} size={64} />
          <div className="min-w-0 flex-1">
            <p className="font-display text-xs tracking-[0.18em] text-ash">{t("profile.kicker")}</p>
            <h2 id="profile-h" className="truncate font-display text-2xl font-semibold text-bone">
              {name}
            </h2>
            <p className="text-xs text-ash">
              {profile ? (profile.online ? <span className="text-flame">{t("profile.atFireNow")}</span> : t("profile.lastSeen", { ago: ago(profile.lastSeen, now) })) : "\u00a0"}
            </p>
          </div>
          <button
            ref={closeBtn}
            type="button"
            onClick={onClose}
            aria-label={t("profile.close")}
            className="grid h-9 w-9 shrink-0 place-items-center self-start rounded-md border border-iron/50 text-ash transition-colors hover:border-ember/60 hover:text-flame"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </header>

        {failed && <p className="mt-8 text-sm text-ash">{t("profile.failed")}</p>}
        {!profile && !failed && <p className="mt-8 font-display text-sm tracking-wide text-ash">{t("profile.loading")}</p>}
        {profile && (
          <motion.div initial={{ opacity: 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 200, damping: 26 }}>
            <Stats p={profile} now={now} />
            <section aria-labelledby="profile-days-h" className="mt-7">
              <h3 id="profile-days-h" className="plank-title mb-3 text-base">
                {t("profile.last30")}
              </h3>
              <DailyBars days={profile.daily} />
            </section>
            <section aria-labelledby="profile-badges-h" className="mt-7">
              <h3 id="profile-badges-h" className="plank-title mb-3 flex items-baseline justify-between text-base">
                <span>{t("profile.badges")}</span>
                <span className="font-sans text-xs font-normal tracking-normal text-ash">
                  {t("profile.badgeCount", { earned: profile.badges.filter((b) => b.earnedAt).length, total: profile.badges.length })}
                </span>
              </h3>
              <Badges badges={profile.badges} />
            </section>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}

function Stats({ p, now }: { p: PlayerProfile; now: number }) {
  const { t, tn, number, duration, ago } = useI18n();
  const f = useFormats();
  const rows: [string, string, string?][] = [
    [t("profile.playtime"), duration(p.playtimeMs)],
    [t("profile.sessions"), String(p.sessions), t("profile.longest", { value: duration(p.longestSessionMs) })],
    [t("profile.deaths"), `${p.deaths}`, t("profile.perHour", { n: number(p.deathsPerHour, 2) })],
    [t("profile.streak"), tn("profile.days", p.currentStreak), t("profile.longest", { value: tn("profile.days", p.longestStreak) })],
    [t("profile.lastSeenLabel"), p.online ? t("profile.now") : ago(p.lastSeen, now)],
    [t("profile.firstSeen"), f.shortDate.format(new Date(p.firstSeen))],
  ];
  return (
    <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-md bg-iron/20 ring-1 ring-black/40">
      {rows.map(([label, value, sub]) => (
        <div key={label} className="bg-wood-dark/90 px-3.5 py-3">
          <dt className="text-[11px] uppercase tracking-wider text-ash">{label}</dt>
          <dd className="mt-0.5 font-display text-lg font-semibold tabular-nums text-bone">{value}</dd>
          {sub && <dd className="text-[11px] text-ash">{sub}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** Daily playtime bars, oldest left; hover or focus a bar for its value. */
function DailyBars({ days }: { days: DailyPlay[] }) {
  const { t, tn, duration } = useI18n();
  const { dayLabel: dayLabelOf } = useFormats();
  const reduced = useReducedMotion();
  const max = Math.max(...days.map((d) => d.ms), 1);
  const total = days.reduce((a, d) => a + d.ms, 0);
  const played = days.filter((d) => d.ms > 0).length;
  const W = 300;
  const H = 84;
  const slot = W / Math.max(1, days.length);
  if (total === 0) {
    return <div className="grid h-[84px] place-items-center rounded-md border border-dashed border-iron/40 text-xs text-ash">{t("profile.dailyEmpty")}</div>;
  }
  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-[84px] w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={t("profile.dailyAria", { days: tn("profile.days", played), total: duration(total) })}
      >
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="rgba(155,143,132,0.25)" vectorEffect="non-scaling-stroke" />
        {days.map((d, i) => {
          const h = d.ms > 0 ? Math.max(2, (d.ms / max) * (H - 6)) : 0;
          const today = i === days.length - 1;
          return (
            <g key={d.day}>
              <title>{`${dayLabelOf(d.day)}: ${d.ms > 0 ? duration(d.ms) : t("profile.noPlay")}`}</title>
              <rect x={i * slot} y="0" width={slot} height={H} fill="transparent" />
              {h > 0 && (
                <motion.rect
                  x={i * slot + slot * 0.18}
                  y={H - h}
                  width={slot * 0.64}
                  height={h}
                  rx="1"
                  fill={today ? "#ffb347" : "#ff7a1a"}
                  fillOpacity={today ? 1 : 0.55 + 0.45 * (d.ms / max)}
                  style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
                  initial={reduced ? false : { scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={{ type: "spring", stiffness: 180, damping: 20, delay: reduced ? 0 : i * 0.012 }}
                />
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex justify-between text-[10px] text-ash/80" aria-hidden>
        <span>{dayLabelOf(days[0]!.day)}</span>
        <span>{dayLabelOf(days[Math.floor(days.length / 2)]!.day)}</span>
        <span>{t("profile.today")}</span>
      </figcaption>
    </figure>
  );
}

// Rune-like glyphs, one per badge id, on a 24x24 box.
const GLYPHS: Record<string, string> = {
  first_blood: "M12 3c3 5 6 8 6 12a6 6 0 0 1-12 0c0-4 3-7 6-12z",
  hearth_10: "M12 3c2 4 5 6 5 10a5 5 0 0 1-10 0c0-3 2-5 3-8 1 2 2 3 2 3M5 21h14",
  hearth_50: "M12 2c2 4 5 6 5 10a5 5 0 0 1-10 0c0-3 2-5 3-8M4 20h16M7 23h10",
  night_owl: "M16 4a8 8 0 1 0 4 12 7 7 0 0 1-4-12zM6 5v2M5 6h2",
  unbroken: "M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5zM12 7v9M8.5 10.5h7",
  raid_veteran: "M4 20L15 9M15 9l1-5 4 4-5 1M8 16l-2-2M20 20L9 9M9 9L8 4 4 8l5 1M16 16l2-2",
  streak_7: "M4 18l4-12 4 8 4-8 4 12M3 21h18",
};

function Badges({ badges }: { badges: Badge[] }) {
  const { t, lookup } = useI18n();
  const f = useFormats();
  return (
    <ul className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
      {badges.map((b) => {
        const earned = b.earnedAt !== null;
        return (
          <li
            key={b.id}
            className={`flex items-start gap-3 rounded-md px-3 py-2.5 ring-1 ${earned ? "bg-ember/[0.07] ring-ember/30" : "bg-black/15 opacity-45 grayscale ring-iron/25"}`}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={earned ? "#ffb347" : "#9b8f84"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0">
              <path d={GLYPHS[b.id] ?? "M12 2l10 10-10 10L2 12z"} />
            </svg>
            <div className="min-w-0">
              <p className={`font-display text-sm font-semibold ${earned ? "text-bone" : "text-ash"}`}>{lookup(`badge.${b.id}.label`) ?? b.id}</p>
              <p className="text-[11px] leading-snug text-ash">{lookup(`badge.${b.id}.description`) ?? ""}</p>
              <p className={`mt-0.5 text-[11px] ${earned ? "text-flame/90" : "text-ash/80"}`}>{earned ? t("profile.earned", { date: f.date.format(new Date(b.earnedAt!)) }) : t("profile.locked")}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
