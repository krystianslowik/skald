import { animate, motion, useMotionValue, useReducedMotion, useTransform, type AnimationPlaybackControls } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Badge, DailyPlay, PlayerProfile } from "../types";
import { getPlayer } from "../lib/api";
import { dragOffset, FLICK_VELOCITY, shouldDismiss, travelFor, velocityFrom, VELOCITY_WINDOW_MS, type Sample } from "../lib/sheet";
import { useI18n } from "../i18n";
import { Shield } from "./Shield";

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Phones get a bottom sheet (swipe down), wider screens a side sheet (drag right). */
const BOTTOM_SHEET = "(max-width: 639px)";
/** Pointer travel before a press on the handle becomes a drag, so taps (the close button) stay taps. */
const DRAG_SLOP = 6;
/** Critically damped: settles without overshoot. */
const SETTLE = { type: "spring" as const, bounce: 0, visualDuration: 0.35 };
const FADE = { duration: 0.2, ease: "easeOut" as const };

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

/**
 * A warrior's stats, last 30 days and badges. A bottom sheet on phones and a
 * side sheet on wider screens; it enters and leaves along the same edge, and
 * can be dragged away by its header (1:1, with momentum) or closed with
 * Escape, the close button or the scrim. Every close is interruptible: grab
 * the sheet while it is leaving and it follows the pointer again.
 */
export default function ProfileSheet({ name, now, onClose }: { name: string; now: number; onClose: () => void }) {
  const { t, ago } = useI18n();
  const reduced = useReducedMotion() ?? false;
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [vertical] = useState(() => typeof window !== "undefined" && (window.matchMedia?.(BOTTOM_SHEET).matches ?? false));

  // Offset along the dismiss axis in px: 0 open, `size` gone, negative past the open edge.
  const offset = useMotionValue(typeof window === "undefined" ? 10_000 : Math.max(window.innerWidth, window.innerHeight));
  const fade = useMotionValue(reduced ? 0 : 1);
  const size = useRef(1);
  const motionAnim = useRef<AnimationPlaybackControls | null>(null);
  const fadeAnim = useRef<AnimationPlaybackControls | null>(null);
  const closing = useRef(false);
  const dragged = useRef(false);
  const done = useRef(onClose);
  done.current = onClose;
  const scrim = useTransform(() => fade.get() * (1 - Math.min(1, Math.max(0, offset.get() / size.current))));

  const measure = () => {
    const el = panel.current;
    const s = vertical ? el?.offsetHeight : el?.offsetWidth;
    size.current = s || (vertical ? window.innerHeight : window.innerWidth) || 1;
    return size.current;
  };

  const stop = () => {
    motionAnim.current?.stop();
    fadeAnim.current?.stop();
  };

  /** Spring to open or closed from wherever the sheet is now, carrying the release velocity. */
  const settle = (to: "open" | "closed", velocity = 0) => {
    stop();
    closing.current = to === "closed";
    const finish = () => {
      if (closing.current) done.current();
    };
    if (reduced) {
      // No slides: cross-fade out, or ease back into place after a drag.
      if (to === "closed") fadeAnim.current = animate(fade, 0, { ...FADE, onComplete: finish });
      else motionAnim.current = animate(offset, 0, FADE);
      return;
    }
    // A flick that throws the sheet back open earns a little bounce; everything else lands softly.
    const bounce = to === "open" && Math.abs(velocity) >= FLICK_VELOCITY ? 0.2 : 0;
    motionAnim.current = animate(offset, to === "open" ? 0 : size.current, { ...SETTLE, bounce, velocity, onComplete: finish });
  };
  const requestClose = () => {
    if (!closing.current) settle("closed");
  };

  useLayoutEffect(() => {
    const s = measure();
    if (reduced) {
      offset.jump(0);
      fadeAnim.current = animate(fade, 1, FADE);
    } else {
      offset.jump(s);
      settle("open");
    }
    return stop;
    // Entry runs once per mount; `settle` only reads refs and motion values.
  }, []);

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
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  /** Drag by the header (or the side grip): tracks 1:1, hands its velocity to the settling spring. */
  const grab = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const coord = (ev: { clientX: number; clientY: number }) => (vertical ? ev.clientY : ev.clientX);
    const start = coord(e);
    stop();
    // Grabbed while leaving: it is ours again.
    const wasClosing = closing.current;
    closing.current = false;
    if (reduced && wasClosing) fade.jump(1);
    measure();
    const base = travelFor(offset.get(), size.current);
    const samples: Sample[] = [];
    let active = false;
    dragged.current = false;

    const move = (ev: PointerEvent) => {
      const d = coord(ev) - start;
      if (!active) {
        if (Math.abs(d) < DRAG_SLOP) return;
        active = true;
        dragged.current = true;
      }
      const travel = base + d;
      offset.set(dragOffset(travel, size.current));
      samples.push({ p: travel, t: ev.timeStamp });
      while (samples.length > 2 && samples[samples.length - 1]!.t - samples[0]!.t > VELOCITY_WINDOW_MS * 2) samples.shift();
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!active) {
        // A press that never moved: resume whatever was happening.
        if (wasClosing) settle("closed");
        else if (offset.get() !== 0) settle("open");
        return;
      }
      if (ev.type === "pointercancel") return settle("open");
      const v = velocityFrom(samples);
      settle(shouldDismiss(offset.get(), v, size.current) ? "closed" : "open", v);
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", end, { passive: true });
    window.addEventListener("pointercancel", end, { passive: true });
  };

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

  return (
    <div className="fixed inset-0 z-50">
      <motion.div aria-hidden className="sheet-scrim absolute inset-0" style={{ opacity: scrim }} onClick={requestClose} />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-h"
        onKeyDown={trap}
        style={vertical ? { y: offset, opacity: fade } : { x: offset, opacity: fade }}
        className="plank absolute inset-x-0 bottom-0 top-[max(1.5rem,env(safe-area-inset-top))] flex flex-col overflow-hidden rounded-b-none rounded-t-xl border-t border-ember/20 will-change-transform sm:inset-y-0 sm:left-auto sm:right-0 sm:top-0 sm:w-[28.75rem] sm:rounded-l-lg sm:rounded-r-none sm:border-l sm:border-t-0"
      >
        {/* Side grip (wider screens): the sheet's left edge can be dragged right. */}
        <div aria-hidden onPointerDown={grab} className="absolute inset-y-0 left-0 z-10 hidden w-4 cursor-grab touch-none select-none active:cursor-grabbing sm:block">
          <span className="absolute left-1.5 top-1/2 h-10 w-1 -translate-y-1/2 rounded-full bg-iron/40" />
        </div>
        <header
          onPointerDown={grab}
          onClickCapture={(e) => {
            // The release of a drag is not a click on whatever it ended over.
            if (dragged.current) {
              dragged.current = false;
              e.stopPropagation();
              e.preventDefault();
            }
          }}
          className="shrink-0 cursor-grab touch-none select-none px-5 pb-4 pt-3 active:cursor-grabbing sm:px-7 sm:pt-6"
        >
          <span aria-hidden className="mx-auto mb-3 block h-1 w-10 rounded-full bg-iron/50 sm:hidden" />
          <div className="flex items-center gap-4 pl-2">
            <Shield name={name} size={64} />
            <div className="min-w-0 flex-1">
              <p className="type-kicker font-display text-xs text-ash">{t("profile.kicker")}</p>
              <h2 id="profile-h" className="type-title truncate font-display text-2xl font-semibold text-bone">
                {name}
              </h2>
              <p className="text-xs text-ash">
                {profile ? (profile.online ? <span className="text-flame">{t("profile.atFireNow")}</span> : t("profile.lastSeen", { ago: ago(profile.lastSeen, now) })) : " "}
              </p>
            </div>
            <button
              ref={closeBtn}
              type="button"
              onClick={requestClose}
              aria-label={t("profile.close")}
              className="press grid h-9 w-9 shrink-0 place-items-center self-start rounded-md border border-iron/50 text-ash transition-colors hover:border-ember/60 hover:text-flame"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                <path d="M3 3l10 10M13 3L3 13" />
              </svg>
            </button>
          </div>
        </header>

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-10 sm:px-7">
          {failed && <p className="mt-4 text-sm text-ash">{t("profile.failed")}</p>}
          {!profile && !failed && <p className="mt-4 font-display text-sm tracking-wide text-ash">{t("profile.loading")}</p>}
          {profile && (
            <motion.div initial={{ opacity: 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} transition={SETTLE}>
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
        </div>
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
    <dl className="mt-1 grid grid-cols-2 gap-px overflow-hidden rounded-md bg-iron/20 ring-1 ring-black/40">
      {rows.map(([label, value, sub]) => (
        <div key={label} className="bg-wood-dark/90 px-3.5 py-3">
          <dt className="text-[0.6875rem] uppercase tracking-wider text-ash">{label}</dt>
          <dd className="mt-0.5 font-display text-lg font-semibold tabular-nums text-bone">{value}</dd>
          {sub && <dd className="text-[0.6875rem] text-ash">{sub}</dd>}
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
    return <div className="grid h-[5.25rem] place-items-center rounded-md border border-dashed border-iron/40 text-xs text-ash">{t("profile.dailyEmpty")}</div>;
  }
  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-[5.25rem] w-full"
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
                  transition={{ ...SETTLE, delay: reduced ? 0 : i * 0.012 }}
                />
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex justify-between text-[0.625rem] text-ash/80" aria-hidden>
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
    <ul className="grid grid-cols-1 gap-2 min-[25rem]:grid-cols-2">
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
              <p className="text-[0.6875rem] leading-snug text-ash">{lookup(`badge.${b.id}.description`) ?? ""}</p>
              <p className={`mt-0.5 text-[0.6875rem] ${earned ? "text-flame/90" : "text-ash/80"}`}>{earned ? t("profile.earned", { date: f.date.format(new Date(b.earnedAt!)) }) : t("profile.locked")}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
