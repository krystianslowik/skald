import { useRef, useState } from "react";
import type { WorldMeta } from "../types";
import { useI18n } from "../i18n";
import { mapUrl, type BossProgress } from "../lib/world";

/** World: in-game day, seed and a link to the world map. */
export function World({ meta, now }: { meta: WorldMeta | null; now: number }) {
  const { t, ago } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!meta) return <p className="text-sm text-ash">{t("world.unreadable")}</p>;

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(meta.seedName);
    } catch {
      // clipboard denied: the seed is still on screen
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-8">
      <div className="shrink-0" title={t("world.dayHint")}>
        <div className="text-xs text-ash">{t("world.gameTime")}</div>
        <div className="font-deco text-4xl leading-tight text-flame">{t("world.day", { n: meta.day })}</div>
      </div>
      <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <dt className="text-xs text-ash">{t("world.seed")}</dt>
          <dd className="flex items-center gap-2">
            <span className="truncate font-mono text-bone">{meta.seedName}</span>
            <button
              type="button"
              onClick={copy}
              aria-label={t("world.copySeed", { seed: meta.seedName })}
              className="rounded border border-iron/50 px-2 py-0.5 text-[11px] text-ash transition-colors hover:border-ember/60 hover:text-flame"
            >
              {copied ? t("world.copied") : t("world.copy")}
            </button>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ash">{t("world.savedOnDisk")}</dt>
          <dd className="text-bone">{ago(meta.savedAt, now)}</dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <a
            href={mapUrl(meta.seedName)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-flame underline decoration-ember/40 underline-offset-4 transition-colors hover:decoration-flame"
          >
            {t("world.map")}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
              <path d="M4 2h6v6M10 2L3 9" />
            </svg>
          </a>
        </div>
      </dl>
    </div>
  );
}

/** Progress: the boss path. `defeated: null` means not yet known. */
export function Progress({ bosses }: { bosses: readonly BossProgress[] }) {
  const { t, lookup } = useI18n();
  const unknown = bosses.every((b) => b.defeated === null);
  return (
    <div>
      <ol className="space-y-1">
        {bosses.map((b, i) => (
          <li key={b.key} className="flex items-center gap-3 rounded-md px-2 py-1 text-sm">
            <span className="w-5 shrink-0 text-right font-display text-xs text-iron">{i + 1}</span>
            <span className={`flex-1 ${b.defeated ? "text-flame" : "text-bone/80"}`}>{lookup(`boss.${b.key}`) ?? b.key}</span>
            <span className={`text-xs ${b.defeated ? "text-flame" : b.defeated === false ? "text-bone/60" : "text-ash"}`}>
              {b.defeated === null ? t("progress.unknown") : b.defeated ? t("progress.defeated") : t("progress.waiting")}
            </span>
          </li>
        ))}
      </ol>
      {unknown && <p className="mt-3 text-xs text-ash">{t("progress.note")}</p>}
    </div>
  );
}
