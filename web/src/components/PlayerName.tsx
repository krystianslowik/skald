import { createContext, useContext } from "react";
import { useI18n } from "../i18n";

/** Opens a warrior's profile; null where names should stay plain text. */
const OpenProfile = createContext<((name: string, opener: HTMLElement) => void) | null>(null);
export const ProfileProvider = OpenProfile.Provider;

/** Starts fetching the profile sheet's code before the click lands. */
export const preloadProfileSheet = () => import("./ProfileSheet");

/** A player's name that opens their profile sheet. */
export function PlayerName({ name, className = "" }: { name: string; className?: string }) {
  const { t } = useI18n();
  const open = useContext(OpenProfile);
  if (!open) return <span className={className}>{name}</span>;
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
      {name}
    </button>
  );
}
