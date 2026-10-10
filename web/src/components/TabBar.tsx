import { motion } from "motion/react";
import { memo } from "react";
import { useI18n, type TextKey } from "../i18n";
import type { Tab } from "../lib/useRoute";
import { SETTINGS_PATH } from "./SettingsGlyph";

const ICONS: Record<Tab, string> = {
  fire: "M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-4.2 4-6.3 4.5-10.8 2.6 1.9 4 4.3 3.8 7 1.4-.6 2.3-1.8 2.6-3.3 1.4 1.6 2.1 3.5 2.1 5.4 0 4.2-2.7 7.9-6.5 7.9zM12 21c-1.7 0-2.8-1.2-2.8-2.7 0-1.8 1.6-2.6 2.2-4.6 1.5 1 3.4 2.6 3.4 4.6 0 1.5-1.1 2.7-2.8 2.7z",
  map: "M3 6.5l5.5-2.5 7 2.5 5.5-2.5v13.5l-5.5 2.5-7-2.5-5.5 2.5zM8.5 4v13.5M15.5 6.5v13.5",
  saga: "M7 4h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8.5M7 4a2 2 0 0 0-2 2v1.5h4V6a2 2 0 0 0-2-2zM9 7.5V19a2 2 0 0 1-2 2h1.5M12 9h4M12 12h4M12 15h2.5",
  settings: SETTINGS_PATH,
};

const LABELS: Record<Tab, TextKey> = { fire: "tab.fire", map: "tab.map", saga: "tab.saga", settings: "tab.settings" };

/**
 * The phone's bottom bar: four places within a thumb's reach. The current one
 * lights in the game's selection blue, and the light slides to the next on a
 * spring. Sits over the home indicator's safe area.
 */
export const TabBar = memo(function TabBar({ tab, tabs, onTab }: { tab: Tab; tabs: readonly Tab[]; onTab: (t: Tab) => void }) {
  const { t } = useI18n();
  return (
    <nav
      aria-label={t("tabs.label")}
      className="tabbar fixed inset-x-0 bottom-0 z-40 border-t border-black/60 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      <ul className="mx-auto flex h-[3.75rem] max-w-lg">
        {tabs.map((id) => {
          const on = id === tab;
          return (
            <li key={id} className="flex-1">
              <a
                href={id === "fire" ? "#" : `#${id}`}
                aria-current={on ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  if (!on) navigator.vibrate?.(6);
                  onTab(id);
                }}
                className={`tab relative flex h-full flex-col items-center justify-center gap-1 text-[0.6875rem] font-bold tracking-[0.04em] ${on ? "text-select-hi" : "text-ash"}`}
              >
                {on && (
                  <motion.span
                    layoutId="tab-light"
                    aria-hidden
                    className="absolute top-1.5 h-8 w-14 rounded-full bg-[radial-gradient(closest-side,rgba(94,151,204,0.38),rgba(94,151,204,0.12)_70%,transparent)]"
                    transition={{ type: "spring", bounce: 0, visualDuration: 0.3 }}
                  />
                )}
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={on ? 1.9 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="relative">
                  <path d={ICONS[id]} />
                </svg>
                <span className="relative">{t(LABELS[id])}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
});
