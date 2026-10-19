import { memo, useCallback, useRef, useState } from "react";
import type { ApiState, SettingsSummary } from "../types";
import { useCampfireSound } from "../lib/campfire";
import { useEmbers } from "../lib/embers";
import { gameVersion } from "../lib/format";
import { LocaleToggle, useI18n, type TextKey } from "../i18n";
import { Flame, type FlameLevel } from "./Flame";
import { preloadSettingsSheet, SettingsGlyph } from "./SettingsGlyph";
import { WorldClock } from "./WorldClock";
import { Elapsed } from "./RelativeTime";
import { preloadAdmin, useAdmin } from "./admin/AdminContext";
import { AdminGlyph } from "./admin/glyphs";
import { preload } from "../lib/chunks";
import type { LogoutResult } from "../lib/api";
import type { WorldClock as Clock } from "../types";
import { dropPushOnLogout } from "../lib/push";
import { NotifyButton } from "./Notifications";

/**
 * The Log out button's press: the panel leaves only once the server ended the
 * session (App does that); otherwise a toast says it did not, and a press again retries.
 */
export function useLogout(onLogout: () => Promise<LogoutResult>) {
  const { t } = useI18n();
  const toast = useAdmin()?.toast;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const logout = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      // While the session still lets it tell the server: a signed-out device gets no more news.
      await dropPushOnLogout();
      const r = await onLogout();
      if (r !== "ok") {
        const reason = r === "refused" ? t("login.refused") : r === "offline" ? t("logout.offline") : t("logout.failed");
        toast?.(false, t("logout.notDone", { reason }));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [onLogout, t, toast]);
  return { logout, busy };
}

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
  onLogout,
  settings,
  onSettings,
  onCancelArmed,
  clock,
  day,
  onMap,
  compact = false,
}: {
  server: ApiState["server"];
  online: boolean;
  onLogout: () => Promise<LogoutResult>;
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
  /** Phones: one line of status, one row of facts, and the buttons live in the tab bar and the Settings tab. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const { logout, busy: loggingOut } = useLogout(onLogout);
  const level = flameLevel(s, online);
  const since = s?.serverStartedAt && s.status === "running" ? s.serverStartedAt : null;
  return (
    <header className={compact ? "flex flex-col gap-3" : "flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-6"}>
      <div className={`flex min-w-0 items-center lg:flex-1 ${compact ? "gap-3" : "gap-4"}`}>
        <Flame level={level} size={compact ? 34 : 44} className="shrink-0 drop-shadow-[0_0_14px_rgba(214,96,24,0.45)]" />
        <div className="min-w-0">
          <p aria-hidden className="truncate font-rune text-xs tracking-[0.3em] text-flame/45">{toRunes(s?.name || "Valheim")}</p>
          <h1 className={`on-world truncate font-bold uppercase tracking-[0.08em] text-flame ${compact ? "text-xl leading-tight" : "text-2xl sm:text-[1.875rem]"}`}>{s?.name || "Valheim"}</h1>
          <p className={`on-world mt-0.5 text-sm text-ash ${compact ? "truncate" : ""}`}>
            {/* The world's name is on its own board below; a phone keeps the status to one line. */}
            {!compact && (
              <>
                {t("header.world")} <span className="text-bone">{s?.world || t("header.worldUnknown")}</span>
                <span className="mx-2 text-iron">/</span>
              </>
            )}
            <span className={level === "alive" ? "text-flame" : level === "ash" ? "text-ash" : "text-ember"}>{t(`flame.${level}`)}</span>
            <span className="text-ash">, {online ? t(SERVER_STATUS[s?.status ?? "unknown"] ?? "status.unknown") : t("header.noLink")}</span>
          </p>
          {settings?.enabled && (settings.pending || settings.armed) && onSettings && (
            <SettingsChips armed={settings.armed} onOpen={() => onSettings(true)} onCancel={onCancelArmed} />
          )}
        </div>
      </div>
      <dl
        className={`on-world flex items-center text-sm ${
          compact ? "flex-nowrap justify-between gap-x-3 border-t border-iron/30 pt-2.5" : "flex-wrap gap-x-5 gap-y-3 border-t border-iron/30 pt-3 lg:flex-nowrap lg:gap-6 lg:border-0 lg:pt-0"
        }`}
      >
        <div>
          <dt className="text-xs text-ash">{t("header.version")}</dt>
          <dd className="font-bold text-bone">{gameVersion(s?.version)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ash">{t("header.burning")}</dt>
          <dd className="whitespace-nowrap font-bold text-bone">{since ? <Elapsed since={since} /> : t("header.notBurning")}</dd>
        </div>
        <WorldClock clock={clock} day={day} />
        {!compact && (
          <div className="ml-auto flex items-center gap-2 sm:gap-3 lg:ml-0">
            {onMap && (
              <button
                type="button"
                onClick={onMap}
                onPointerEnter={preloadMap}
                onFocus={preloadMap}
                aria-haspopup="dialog"
                aria-label={t("map.open")}
                title={t("map.open")}
                className="plaque press grid h-8 w-8 place-items-center coarse:h-11 coarse:w-11"
              >
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
                  <path d="M2 5l5-2 6 2 5-2v12l-5 2-6-2-5 2zM7 3v12M13 5v12" />
                </svg>
              </button>
            )}
            <AdminButton />
            {settings?.enabled && onSettings && (
              <button
                type="button"
                onClick={() => onSettings(false)}
                onPointerEnter={preloadSettingsSheet}
                onFocus={preloadSettingsSheet}
                aria-haspopup="dialog"
                aria-label={t("settings.open")}
                title={t("settings.open")}
                className="plaque press grid h-8 w-8 place-items-center coarse:h-11 coarse:w-11"
              >
                <SettingsGlyph size={18} className="text-current" />
              </button>
            )}
            <NotifyButton />
            <SoundToggle />
            <EmbersToggle />
            <LocaleToggle />
            <button
              type="button"
              onClick={() => void logout()}
              aria-busy={loggingOut}
              className="plaque press whitespace-nowrap px-3 py-1.5 text-xs font-bold"
            >
              {t("header.logout")}
            </button>
          </div>
        )}
      </dl>
    </header>
  );
});

/** Opens the admin sheet, labelled like the phone's Admin board. A dot says the bridge cannot act. */
function AdminButton() {
  const { t } = useI18n();
  const admin = useAdmin();
  if (!admin?.present) return null;
  return (
    <button
      type="button"
      onClick={() => admin.open({ kind: "panel" })}
      onPointerEnter={preloadAdmin}
      onFocus={preloadAdmin}
      aria-haspopup="dialog"
      className="plaque press relative flex h-8 items-center gap-1.5 whitespace-nowrap pl-2 pr-3 text-xs font-bold coarse:h-11 coarse:pl-3 coarse:pr-4"
    >
      <AdminGlyph size={16} />
      {t("admin.open")}
      {admin.bridgeOn && admin.blocker && <span aria-hidden className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-ember" />}
    </button>
  );
}

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
        className={`press tap inline-flex items-center gap-1.5 rounded-[2px] border px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-[0.06em] ${
          armed ? "border-white/25 bg-[linear-gradient(180deg,#7aaedc,#5e97cc_60%,#4c82b5)] text-[#10161d]" : "border-ember/60 bg-black/30 text-flame"
        }`}
      >
        {armed && <span aria-hidden className="armed-pulse h-2 w-2 rounded-full bg-white/80" />}
        {armed ? t("settings.armedChip") : t("settings.pendingChip")}
      </button>
      {armed && onCancel && (
        <button type="button" onClick={onCancel} aria-label={t("settings.cancelArmed")} title={t("settings.cancelArmed")} className="plaque press tap grid h-6 w-6 place-items-center">
          <svg width="11" height="11" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** Optional crackling-fire ambience; off until someone asks for it. */
export function SoundToggle() {
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
      className="plaque press grid h-8 w-8 place-items-center coarse:h-11 coarse:w-11"
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

/** The rising embers behind the page, next to the sound (phones have the switch in Settings). */
export function EmbersToggle() {
  const { t } = useI18n();
  const { on, toggle } = useEmbers();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      aria-label={t("embers.label")}
      title={on ? t("embers.on") : t("embers.off")}
      className="plaque press grid h-8 w-8 place-items-center coarse:h-11 coarse:w-11"
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M6 16.5c-1.3-1.6-.6-3.4.6-4.6.3 1 .9 1.6 1.6 1.8-.4-2.4.8-4.4 2.6-5.6-.2 2.2.9 3.4 2 4.6 1 1.1 1.2 2.6.4 3.8" />
        {on ? (
          <>
            <circle cx="5" cy="6" r="0.9" fill="currentColor" stroke="none" />
            <circle cx="14.5" cy="4" r="0.9" fill="currentColor" stroke="none" />
            <circle cx="9.5" cy="3" r="0.7" fill="currentColor" stroke="none" />
          </>
        ) : (
          <path d="M3 3l14 14" />
        )}
      </svg>
    </button>
  );
}

/** Warms the map's chunk before the click lands. */
export const preloadMap = () => preload(() => import("./map/MapView"));

export function OfflineBanner() {
  const { t } = useI18n();
  return (
    <div role="status" className="material sticky top-0 z-30 border-b border-ember/40 px-4 py-2.5 text-center text-sm">
      <span className="font-bold uppercase tracking-[0.08em] text-flame">{t("offline.title")}</span>{" "}
      <span className="text-bone/90">{t("offline.body")}</span>
    </div>
  );
}
