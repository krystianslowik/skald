import { memo, type ReactNode } from "react";
import { LocaleToggle, useI18n } from "../i18n";
import { SoundToggle } from "./Header";
import { Plank } from "./Plank";
import { preloadSettingsSheet, SettingsGlyph } from "./SettingsGlyph";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 border-b border-iron/25 py-2 last:border-0">
      <span className="text-bone">{label}</span>
      {children}
    </div>
  );
}

/**
 * The phone's Settings tab opens with what the desktop header carries: the
 * server settings, language, the campfire sound and logging out.
 */
export const Preferences = memo(function Preferences({ onServerSettings, onLogout }: { onServerSettings?: () => void; onLogout: () => void }) {
  const { t } = useI18n();
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
      <button type="button" onClick={onLogout} className="plaque press mt-3 min-h-12 w-full font-bold">
        {t("header.logout")}
      </button>
    </Plank>
  );
});
