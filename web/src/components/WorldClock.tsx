import { memo } from "react";
import { useI18n } from "../i18n";
import type { WorldClock as Clock } from "../types";

/**
 * The in-game day with a sun or moon, and "world asleep" when nobody is on:
 * a dedicated server's world does not move without players. Agents without
 * a clock (older than 0.5.0) get the day alone.
 */
export const WorldClock = memo(function WorldClock({ clock, day }: { clock?: Clock | null; day?: number | null }) {
  const { t } = useI18n();
  const d = clock?.day ?? day;
  if (d === undefined || d === null) return null;
  const asleep = clock ? !clock.advancing : false;
  const phase = clock ? (clock.daylight ? t("clock.daytime") : t("clock.night")) : null;
  const title = clock ? (asleep ? t("clock.asleepHint") : t("clock.awakeHint")) : t("world.dayHint");
  return (
    <div title={title}>
      <dt className="text-xs text-ash">{t("clock.label")}</dt>
      <dd className="flex items-center gap-1.5 whitespace-nowrap font-bold text-bone">
        {clock && <PhaseGlyph fraction={clock.dayFraction} daylight={clock.daylight} asleep={asleep} />}
        <span>{t("clock.day", { n: d })}</span>
        {phase && <span className="sr-only">, {phase}</span>}
        {asleep && <span className="text-xs font-normal text-select-hi">{t("clock.asleep")}</span>}
      </dd>
    </div>
  );
});

/** A sun by day and a crescent by night; dimmed while the world sleeps. */
function PhaseGlyph({ fraction, daylight, asleep }: { fraction: number; daylight: boolean; asleep: boolean }) {
  // The body rides an arc across the small sky box as the day goes on.
  const t = daylight ? (fraction - 0.25) / 0.5 : ((fraction + 0.25) % 1) / 0.5;
  const x = 3 + Math.max(0, Math.min(1, t)) * 14;
  const y = 12 - Math.sin(Math.max(0, Math.min(1, t)) * Math.PI) * 7;
  return (
    <svg width="20" height="16" viewBox="0 0 20 16" aria-hidden className={asleep ? "opacity-55" : ""}>
      <path d="M1 14.5h18" stroke="#6b5745" strokeWidth="1" strokeLinecap="round" />
      {daylight ? (
        <g transform={`translate(${x} ${y})`}>
          <circle r="2.6" fill="#f3b867" />
          <path d="M0-4.6v-1M0 4.6v1M-4.6 0h-1M4.6 0h1M-3.3-3.3l-.7-.7M3.3 3.3l.7.7M-3.3 3.3l-.7.7M3.3-3.3l.7-.7" stroke="#f3b867" strokeWidth="1" strokeLinecap="round" />
        </g>
      ) : (
        <path transform={`translate(${x} ${y})`} d="M1.5-3.4A3.6 3.6 0 1 0 1.5 3.4A2.8 2.8 0 1 1 1.5-3.4z" fill="#8cbce6" />
      )}
    </svg>
  );
}
