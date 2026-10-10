import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import type { Badge, DailyPlay, PlayerProfile } from "../types";
import { getPlayer } from "../lib/api";
import { useI18n } from "../i18n";
import { Sheet, SheetClose, SETTLE } from "./Sheet";
import { Shield } from "./Shield";

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

/** A warrior's stats, last 30 days and badges, in a draggable sheet. */
export default function ProfileSheet({ name, now, onClose }: { name: string; now: number; onClose: () => void }) {
  const { t, ago } = useI18n();
  const reduced = useReducedMotion() ?? false;
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

  return (
    <Sheet
      labelledBy="profile-h"
      onClose={onClose}
      header={(close) => (
        <div className="flex items-center gap-4 pl-2">
          <span className="slot grid h-[4.5rem] w-[4.5rem] shrink-0 place-items-center">
            <Shield name={name} size={58} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="label-caps">{t("profile.kicker")}</p>
            <h2 id="profile-h" className="plank-title truncate text-2xl">
              {name}
            </h2>
            <p className="text-xs text-ash">
              {profile ? (profile.online ? <span className="text-flame">{t("profile.atFireNow")}</span> : t("profile.lastSeen", { ago: ago(profile.lastSeen, now) })) : " "}
            </p>
          </div>
          <SheetClose label={t("profile.close")} escLabel={t("key.esc")} onClose={close} />
        </div>
      )}
    >
      {failed && <p className="mt-4 text-sm text-ash">{t("profile.failed")}</p>}
      {!profile && !failed && <p className="mt-4 text-sm font-bold uppercase tracking-[0.08em] text-flame">{t("profile.loading")}</p>}
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
              <span className="text-xs font-normal normal-case tracking-normal text-ash">
                {t("profile.badgeCount", { earned: profile.badges.filter((b) => b.earnedAt).length, total: profile.badges.length })}
              </span>
            </h3>
            <Badges badges={profile.badges} />
          </section>
        </motion.div>
      )}
    </Sheet>
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
    <dl className="mt-1 grid grid-cols-2 gap-1.5">
      {rows.map(([label, value, sub]) => (
        <div key={label} className="slot px-3.5 py-3">
          <dt className="label-caps">{label}</dt>
          <dd className="mt-0.5 text-lg font-bold tabular-nums text-bone">{value}</dd>
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
    return <div className="slot grid h-[5.25rem] place-items-center text-xs text-ash">{t("profile.dailyEmpty")}</div>;
  }
  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="slot block h-[5.25rem] w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={t("profile.dailyAria", { days: tn("profile.days", played), total: duration(total) })}
      >
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="rgba(0,0,0,0.5)" vectorEffect="non-scaling-stroke" />
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
                  fill={today ? "#ecc212" : "#cea83e"}
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
      <figcaption className="mt-1 flex justify-between text-[0.625rem] text-ash" aria-hidden>
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
            className={`flex items-start gap-3 rounded-[3px] py-1 pr-1 ${earned ? "" : "opacity-45 grayscale"}`}
          >
            {/* An inventory slot holding the badge's mark; locked ones are dimmed. */}
            <span className="slot grid h-12 w-12 shrink-0 place-items-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={earned ? "#f3b867" : "#b3a596"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={earned ? "drop-shadow-[0_0_5px_rgba(243,184,103,0.4)]" : ""}>
                <path d={GLYPHS[b.id] ?? "M12 2l10 10-10 10L2 12z"} />
              </svg>
            </span>
            <div className="min-w-0">
              <p className={`text-sm font-bold ${earned ? "text-bone" : "text-ash"}`}>{lookup(`badge.${b.id}.label`) ?? b.id}</p>
              <p className="text-[0.6875rem] leading-snug text-ash">{lookup(`badge.${b.id}.description`) ?? ""}</p>
              <p className={`mt-0.5 text-[0.6875rem] ${earned ? "text-flame" : "text-ash"}`}>{earned ? t("profile.earned", { date: f.date.format(new Date(b.earnedAt!)) }) : t("profile.locked")}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
