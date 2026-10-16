import { versionMismatch } from "@server/version";
import { useI18n } from "../i18n";

/**
 * "Skald 2026.10.0" in small print, a calm note when the agent and the panel
 * were released apart, and a newer release when the update check found one.
 */
export function SkaldVersion({ web, agent, update, className = "" }: { web: string; agent?: string; update?: { version: string; url: string } | null; className?: string }) {
  const { t } = useI18n();
  const mismatch = versionMismatch(agent, web);
  return (
    <div className={`text-xs text-ash ${className}`}>
      <p>{t("version.label", { v: web })}</p>
      {mismatch && (
        <p role="status" className="mt-1 text-bone/90">
          {t("version.mismatch", { agent: mismatch.agent, web: mismatch.web })}
        </p>
      )}
      {update && (
        <p className="mt-1">
          <a href={update.url} target="_blank" rel="noopener noreferrer" className="font-bold text-flame underline decoration-flame/40 underline-offset-4 hover:text-gold">
            {t("version.update", { v: update.version })}
          </a>
        </p>
      )}
    </div>
  );
}
