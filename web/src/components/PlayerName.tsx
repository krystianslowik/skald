import { createContext, useContext } from "react";
import { useI18n } from "../i18n";
import { preload } from "../lib/chunks";

/** Opens a warrior's profile; null where names should stay plain text. */
const OpenProfile = createContext<((name: string, opener: HTMLElement) => void) | null>(null);
export const ProfileProvider = OpenProfile.Provider;

/** Starts fetching the profile sheet's code before the click lands. */
export const preloadProfileSheet = () => preload(() => import("./ProfileSheet"));

/**
 * A player's name that opens their profile sheet. `truncate` ends a long name
 * with an ellipsis on an inner span: overflow on the button itself would clip
 * its finger-sized hit area (`.tap`).
 */
export function PlayerName({ name, className = "", truncate = false }: { name: string; className?: string; truncate?: boolean }) {
  const { t } = useI18n();
  const open = useContext(OpenProfile);
  if (!open) return <span className={truncate ? `truncate ${className}` : className}>{name}</span>;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      title={t("profile.open", { name })}
      onPointerEnter={preloadProfileSheet}
      onPointerDown={preloadProfileSheet}
      onFocus={preloadProfileSheet}
      onClick={(e) => open(name, e.currentTarget)}
      className={`press-text tap max-w-full cursor-pointer decoration-flame/60 underline-offset-4 transition-colors hover:text-flame hover:underline ${className}`}
    >
      {truncate ? <span className="block truncate">{name}</span> : name}
    </button>
  );
}
