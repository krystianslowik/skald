import { preload } from "../lib/chunks";

/** Three carved sliders: the mark for server settings and for a custom world. */
export const SETTINGS_PATH = "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4";

export function SettingsGlyph({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`text-flame ${className}`}>
      <path d={SETTINGS_PATH} />
    </svg>
  );
}

/** Starts fetching the settings sheet's code before the click lands. */
export const preloadSettingsSheet = () => preload(() => import("./SettingsSheet"));
