import type { Platform } from "../types";
import { useI18n } from "../i18n";

// Own line art on a 24x24 box, no brand marks: a controller for the
// consoles, a monitor for PC.
const CONTROLLER = "M7 8h10a4 4 0 0 1 4 4.5l-.6 4a2.6 2.6 0 0 1-4.6 1.3L14.5 16h-5l-1.3 1.8a2.6 2.6 0 0 1-4.6-1.3l-.6-4A4 4 0 0 1 7 8zM7.5 11v3M6 12.5h3M15.5 12h.01M17.5 14h.01";
const MONITOR = "M3.5 5h17v11h-17zM9 20h6M12 16v4";

/** A small platform mark with its name as the accessible label; nothing when unknown. */
export function PlatformGlyph({ platform, size = 14, className = "" }: { platform?: Platform | null; size?: number; className?: string }) {
  const { t } = useI18n();
  if (!platform || platform === "unknown") return null;
  const label = t(`platform.${platform}`);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={label}
      className={`inline-block shrink-0 ${className}`}
    >
      <title>{label}</title>
      <path d={platform === "steam" ? MONITOR : CONTROLLER} />
    </svg>
  );
}
