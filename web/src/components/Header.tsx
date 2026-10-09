import { memo } from "react";
import type { ApiState } from "../types";
import { useCampfireSound } from "../lib/campfire";
import { gameVersion } from "../lib/format";
import { LocaleToggle, useI18n, type TextKey } from "../i18n";
import { Flame, type FlameLevel } from "./Flame";

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

export const Header = memo(function Header({ server: s, online, now, onLogout }: { server: ApiState["server"]; online: boolean; now: number; onLogout: () => void }) {
  const { t, duration } = useI18n();
  const level = flameLevel(s, online);
  const up = s?.serverStartedAt && s.status === "running" ? duration(now - Date.parse(s.serverStartedAt)) : null;
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
      <div className="flex min-w-0 items-center gap-4 sm:flex-1">
        <Flame level={level} size={44} className="shrink-0 drop-shadow-[0_0_14px_rgba(255,122,26,0.45)]" />
        <div className="min-w-0">
          <h1 className="type-title truncate font-display text-2xl font-semibold text-bone sm:text-3xl">{s?.name || "Valheim"}</h1>
          <p className="mt-0.5 text-sm text-ash">
            {t("header.world")} <span className="text-bone/90">{s?.world || t("header.worldUnknown")}</span>
            <span className="mx-2 text-iron">/</span>
            <span className={level === "alive" ? "text-flame" : level === "ash" ? "text-ash" : "text-ember"}>{t(`flame.${level}`)}</span>
            <span className="text-ash">, {online ? t(SERVER_STATUS[s?.status ?? "unknown"] ?? "status.unknown") : t("header.noLink")}</span>
          </p>
        </div>
      </div>
      <dl className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-iron/20 pt-3 text-sm sm:flex-nowrap sm:gap-6 sm:border-0 sm:pt-0">
        <div>
          <dt className="text-xs text-ash">{t("header.version")}</dt>
          <dd className="font-medium text-bone">{gameVersion(s?.version)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ash">{t("header.burning")}</dt>
          <dd className="whitespace-nowrap font-medium text-bone">{up ?? t("header.notBurning")}</dd>
        </div>
        <div className="ml-auto flex items-center gap-2 sm:ml-0 sm:gap-3">
          <SoundToggle />
          <LocaleToggle />
          <button
            type="button"
            onClick={onLogout}
            className="press whitespace-nowrap rounded-md border border-iron/50 px-3 py-1.5 text-xs text-ash transition-colors hover:border-ember/60 hover:text-flame"
          >
            {t("header.logout")}
          </button>
        </div>
      </dl>
    </header>
  );
});

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
      className={`press grid h-8 w-8 place-items-center rounded-md border transition-colors ${
        on ? "border-ember/60 bg-ember/10 text-flame" : "border-iron/50 text-ash hover:border-ember/60 hover:text-flame"
      }`}
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

export function OfflineBanner() {
  const { t } = useI18n();
  return (
    <div role="status" className="material sticky top-0 z-30 border-b border-ember/30 px-4 py-2.5 text-center text-sm">
      <span className="font-display font-semibold tracking-wide text-ember">{t("offline.title")}</span>{" "}
      <span className="text-bone/80">{t("offline.body")}</span>
    </div>
  );
}
