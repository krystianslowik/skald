import { memo } from "react";
import type { ApiState, SettingsSummary } from "../types";
import { useCampfireSound } from "../lib/campfire";
import { gameVersion } from "../lib/format";
import { LocaleToggle, useI18n, type TextKey } from "../i18n";
import { Flame, type FlameLevel } from "./Flame";
import { preloadSettingsSheet, SettingsGlyph } from "./SettingsGlyph";
import { WorldClock } from "./WorldClock";
import type { WorldClock as Clock } from "../types";

export function flameLevel(s: ApiState["server"] | null, online: boolean): FlameLevel {
  if (!s || !online) return "embers";
  if (s.status === "running") return "alive";
  if (s.status === "starting" || s.status === "stopping") return "embers";
  return "ash";
}

const SERVER_STATUS: Record<string, TextKey> = {
  starting: "status.starting",
  running: "status.running",
  stopping: "status.stopping",
  stopped: "status.stopped",
  unknown: "status.unknown",
};

// Elder Futhark letters for a Latin name: a decorative echo only, never the readable name.
const FUTHARK: Record<string, string> = {
  a: "ᚨ", b: "ᛒ", c: "ᚲ", d: "ᛞ", e: "ᛖ", f: "ᚠ", g: "ᚷ", h: "ᚺ", i: "ᛁ", j: "ᛃ", k: "ᚲ", l: "ᛚ", m: "ᛗ",
  n: "ᚾ", o: "ᛟ", p: "ᛈ", q: "ᚲ", r: "ᚱ", s: "ᛊ", t: "ᛏ", u: "ᚢ", v: "ᚹ", w: "ᚹ", x: "ᚲᛊ", y: "ᛃ", z: "ᛉ", " ": "᛫",
};
const toRunes = (s: string) =>
  [...s.toLowerCase().normalize("NFD")].map((c) => FUTHARK[c] ?? "").join("");

export const Header = memo(function Header({
  server: s,
  online,
  now,
  onLogout,
  settings,
  onSettings,
  onCancelArmed,
  clock,
  day,
  onMap,
}: {
  server: ApiState["server"];
  online: boolean;
  now: number;
  onLogout: () => void;
  /** Present when the agent can change server settings. */
  settings?: SettingsSummary | null;
  /** Opens the settings sheet; `footer` lands on the apply choice. */
  onSettings?: (footer: boolean) => void;
  onCancelArmed?: () => void;
  /** The world clock; without it the header shows the save's day alone. */
  clock?: Clock | null;
  day?: number | null;
  /** Opens the world map. */
  onMap?: () => void;
}) {
  const { t, duration } = useI18n();
  const level = flameLevel(s, online);
  const up = s?.serverStartedAt && s.status === "running" ? duration(now - Date.parse(s.serverStartedAt)) : null;
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
      <div className="flex min-w-0 items-center gap-4 sm:flex-1">
        <Flame level={level} size={44} className="shrink-0 drop-shadow-[0_0_14px_rgba(214,96,24,0.45)]" />
        <div className="min-w-0">
          <p aria-hidden className="truncate font-rune text-xs tracking-[0.3em] text-flame/45">{toRunes(s?.name || "Valheim")}</p>
          <h1 className="on-world truncate text-2xl font-bold uppercase tracking-[0.08em] text-flame sm:text-[1.875rem]">{s?.name || "Valheim"}</h1>
          <p className="on-world mt-0.5 text-sm text-ash">
            {t("header.world")} <span className="text-bone">{s?.world || t("header.worldUnknown")}</span>
            <span className="mx-2 text-iron">/</span>
            <span className={level === "alive" ? "text-flame" : level === "ash" ? "text-ash" : "text-ember"}>{t(`flame.${level}`)}</span>
            <span className="text-ash">, {online ? t(SERVER_STATUS[s?.status ?? "unknown"] ?? "status.unknown") : t("header.noLink")}</span>
          </p>
          {settings?.enabled && (settings.pending || settings.armed) && onSettings && (
            <SettingsChips armed={settings.armed} onOpen={() => onSettings(true)} onCancel={onCancelArmed} />
          )}
        </div>
      </div>
      <dl className="on-world flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-iron/30 pt-3 text-sm sm:flex-nowrap sm:gap-6 sm:border-0 sm:pt-0">
        <div>
          <dt className="text-xs text-ash">{t("header.version")}</dt>
          <dd className="font-bold text-bone">{gameVersion(s?.version)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ash">{t("header.burning")}</dt>
          <dd className="whitespace-nowrap font-bold text-bone">{up ?? t("header.notBurning")}</dd>
        </div>
        <WorldClock clock={clock} day={day} />
        <div className="ml-auto flex items-center gap-2 sm:ml-0 sm:gap-3">
          {onMap && (
            <button
              type="button"
              onClick={onMap}
              onPointerEnter={preloadMap}
              onFocus={preloadMap}
              aria-haspopup="dialog"
              aria-label={t("map.open")}
              title={t("map.open")}
              className="plaque press grid h-8 w-8 place-items-center"
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
                <path d="M2 5l5-2 6 2 5-2v12l-5 2-6-2-5 2zM7 3v12M13 5v12" />
              </svg>
            </button>
          )}
          {settings?.enabled && onSettings && (
            <button
              type="button"
              onClick={() => onSettings(false)}
              onPointerEnter={preloadSettingsSheet}
              onFocus={preloadSettingsSheet}
              aria-haspopup="dialog"
              aria-label={t("settings.open")}
              title={t("settings.open")}
              className="plaque press grid h-8 w-8 place-items-center"
            >
              <SettingsGlyph size={18} className="text-current" />
            </button>
          )}
          <SoundToggle />
          <LocaleToggle />
          <button
            type="button"
            onClick={onLogout}
            className="plaque press whitespace-nowrap px-3 py-1.5 text-xs font-bold"
          >
            {t("header.logout")}
          </button>
        </div>
      </dl>
    </header>
  );
});

/**
 * Saved settings waiting for a restart, and an armed apply-when-empty with
 * its cancel. The chip opens the settings sheet on its apply choice.
 */
function SettingsChips({ armed, onOpen, onCancel }: { armed: boolean; onOpen: () => void; onCancel?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={onOpen}
        onPointerEnter={preloadSettingsSheet}
        aria-label={t("settings.pendingChipAria")}
        className={`press inline-flex items-center gap-1.5 rounded-[2px] border px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-[0.06em] ${
          armed ? "border-white/25 bg-[linear-gradient(180deg,#7aaedc,#5e97cc_60%,#4c82b5)] text-[#10161d]" : "border-ember/60 bg-black/30 text-flame"
        }`}
      >
        {armed && <span aria-hidden className="armed-pulse h-2 w-2 rounded-full bg-white/80" />}
        {armed ? t("settings.armedChip") : t("settings.pendingChip")}
      </button>
      {armed && onCancel && (
        <button type="button" onClick={onCancel} aria-label={t("settings.cancelArmed")} title={t("settings.cancelArmed")} className="plaque press grid h-6 w-6 place-items-center">
          <svg width="11" height="11" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** Optional crackling-fire ambience; off until someone asks for it. */
function SoundToggle() {
  const { t } = useI18n();
  const { on, supported, toggle } = useCampfireSound();
  if (!supported) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      aria-label={t("sound.label")}
      title={on ? t("sound.on") : t("sound.off")}
      className="plaque press grid h-8 w-8 place-items-center"
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 8h3l4-3.5v11L6 12H3z" />
        {on ? (
          <>
            <path d="M13 7.5c1 1.4 1 3.6 0 5" />
            <path d="M15.5 5.5c2 2.6 2 6.4 0 9" />
          </>
        ) : (
          <path d="M13.5 8l4 4M17.5 8l-4 4" />
        )}
      </svg>
    </button>
  );
}

/** Warms the map's chunk before the click lands. */
export const preloadMap = () => void import("./map/MapView");

export function OfflineBanner() {
  const { t } = useI18n();
  return (
    <div role="status" className="material sticky top-0 z-30 border-b border-ember/40 px-4 py-2.5 text-center text-sm">
      <span className="font-bold uppercase tracking-[0.08em] text-flame">{t("offline.title")}</span>{" "}
      <span className="text-bone/90">{t("offline.body")}</span>
    </div>
  );
}
