import { memo, type ReactNode } from "react";
import { LocaleToggle, useI18n } from "../i18n";
import { SoundToggle, useLogout } from "./Header";
import type { LogoutResult } from "../lib/api";
import { Plank } from "./Plank";
import { preloadSettingsSheet, SettingsGlyph } from "./SettingsGlyph";
import { SkaldVersion } from "./SkaldVersion";
import { useEmbers } from "../lib/embers";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 border-b border-iron/25 py-2 last:border-0">
      <span className="text-bone">{label}</span>
      {children}
    </div>
  );
}

/** The rising embers behind the page: pretty, but they cost battery. */
function EmbersSwitch() {
  const { t } = useI18n();
  const { on, toggle } = useEmbers();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={t("embers.label")}
      title={on ? t("embers.on") : t("embers.off")}
      onClick={toggle}
      className={`press relative h-8 w-14 shrink-0 rounded-full border transition-colors coarse:h-11 coarse:w-18 ${on ? "border-select-hi/70 bg-select/50" : "border-iron/60 bg-black/40"}`}
    >
      <span className={`absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full bg-bone shadow-sm transition-[left] coarse:h-8 coarse:w-8 ${on ? "left-[calc(100%-1.75rem)] coarse:left-[calc(100%-2.25rem)]" : "left-1"}`} />
    </button>
  );
}

/**
 * The phone's Settings tab opens with what the desktop header carries: the
 * server settings, language, the campfire sound and logging out, plus the
 * embers switch.
 */
export const Preferences = memo(function Preferences({
  onServerSettings,
  onLogout,
  webVersion,
  agentVersion,
}: {
  onServerSettings?: () => void;
  onLogout: () => Promise<LogoutResult>;
  webVersion?: string;
  agentVersion?: string;
}) {
  const { t } = useI18n();
  const { logout, busy } = useLogout(onLogout);
  return (
    <Plank title={t("tab.settings")} id="prefs">
      {onServerSettings && (
        <button
          type="button"
          onClick={onServerSettings}
          onPointerDown={preloadSettingsSheet}
          aria-haspopup="dialog"
          className="plaque press mb-2 flex min-h-12 w-full items-center gap-3 px-4 text-left font-bold"
        >
          <SettingsGlyph size={20} className="text-current" />
          <span className="flex-1">{t("settings.open")}</span>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 3l5 5-5 5" />
          </svg>
        </button>
      )}
      <Row label={t("lang.label")}>
        <LocaleToggle />
      </Row>
      <Row label={t("sound.label")}>
        <SoundToggle />
      </Row>
      <Row label={t("embers.label")}>
        <EmbersSwitch />
      </Row>
      <button type="button" onClick={() => void logout()} aria-busy={busy} className="plaque press mt-3 min-h-12 w-full font-bold">
        {t("header.logout")}
      </button>
      {webVersion && <SkaldVersion web={webVersion} agent={agentVersion} className="mt-4 text-center" />}
    </Plank>
  );
});
