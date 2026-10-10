import { memo, useRef, useState } from "react";
import type { WorldMeta } from "../types";
import { useI18n } from "../i18n";
import { mapUrl, type BossProgress } from "../lib/world";

/** World: in-game day, seed and a link to the world map. */
export const World = memo(function World({ meta, now }: { meta: WorldMeta | null; now: number }) {
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
        <div className="on-world text-4xl font-bold uppercase leading-none tracking-[0.06em] text-flame">{t("world.day", { n: meta.day })}</div>
      </div>
      <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <dt className="text-xs text-ash">{t("world.seed")}</dt>
          <dd className="flex items-center gap-2">
            <span className="truncate font-mono font-bold text-bone">{meta.seedName}</span>
            <button
              type="button"
              onClick={copy}
              aria-label={t("world.copySeed", { seed: meta.seedName })}
              className="plaque press px-2 py-0.5 text-[0.6875rem] font-bold"
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
            className="inline-flex items-center gap-1.5 text-sm font-bold text-flame underline decoration-flame/40 underline-offset-4 transition-colors hover:text-gold hover:decoration-gold"
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
});

// Own line-art marks, one per boss, on a 32x32 box. Not the game's trophy art.
const BOSS_MARKS: Record<string, string> = {
  defeated_eikthyr: "M16 27v-9M13 27h6M16 18c-3-1-5-4-5-8M11 10L8 6M11 13H6M16 18c3-1 5-4 5-8M21 10l3-4M21 13h5M14 20a2 2 0 0 0 4 0",
  defeated_gdking: "M16 28V11M16 16l-6-6M10 10V6M16 14l6-7M22 7h3M16 21l-5-3M16 20l5-2M10 28l6-3 6 3",
  defeated_bonemass: "M8 19a8 8 0 0 1 16 0v4l-3 3H11l-3-3zM12.5 19h.01M19.5 19h.01M14 24v2M18 24v2M10 11l-2-3M22 11l2-3",
  defeated_dragon: "M16 12L4 18l6 1-3 5 9-6 9 6-3-5 6-1zM16 12V6l2 2M16 18v8",
  defeated_goblinking: "M9 10l2 6h10l2-6-4 3-3-5-3 5zM11 16v6l2 3h6l2-3v-6M13.5 20h.01M18.5 20h.01",
  defeated_queen: "M16 6a3 3 0 0 1 0 6 3 3 0 0 1 0-6M16 12c-3 0-4 4-4 8s2 7 4 7 4-3 4-7-1-8-4-8M12 16l-5-3M12 20l-6 1M12 24l-4 3M20 16l5-3M20 20l6 1M20 24l4 3",
  defeated_fader: "M16 4c3 5 9 8 9 14a9 9 0 0 1-18 0c0-6 6-9 9-14zM11 19c3-3 7-3 10 0-3 3-7 3-10 0zM16 19h.01",
};

/** Progress: the boss path as a trophy strip. `defeated: null` means not yet known. */
export const Progress = memo(function Progress({ bosses }: { bosses: readonly BossProgress[] }) {
  const { t, lookup } = useI18n();
  const [shown, setShown] = useState<number | null>(null);
  const unknown = bosses.every((b) => b.defeated === null);
  // The next boss to face: the first one not yet defeated, once progress is known.
  const next = unknown ? -1 : bosses.findIndex((b) => b.defeated === false);
  const status = (b: BossProgress) => (b.defeated === null ? t("progress.unknown") : b.defeated ? t("progress.defeated") : t("progress.waiting"));
  const focus = shown ?? (next > 0 ? next - 1 : next === -1 && !unknown && bosses.length > 0 ? bosses.length - 1 : null);
  const read = focus === null ? null : bosses[focus];
  return (
    <div>
      <ol className="grid grid-cols-7 gap-1.5 sm:gap-2">
        {bosses.map((b, i) => {
          const name = lookup(`boss.${b.key}`) ?? b.key;
          return (
            <li
              key={b.key}
              tabIndex={0}
              onPointerEnter={() => setShown(i)}
              onPointerLeave={() => setShown(null)}
              onFocus={() => setShown(i)}
              onBlur={() => setShown(null)}
              className={`slot relative grid aspect-square place-items-center transition-[box-shadow,opacity] ${b.defeated === null ? "opacity-60" : ""} ${shown === i ? "ring-1 ring-flame/70" : ""}`}
            >
              <span aria-hidden className="absolute left-1 top-0.5 text-[0.625rem] font-bold leading-none text-select-hi/80">
                {i + 1}
              </span>
              {b.defeated !== null && (
                <svg
                  viewBox="0 0 32 32"
                  aria-hidden
                  className={`h-[62%] w-[62%] ${b.defeated ? "drop-shadow-[0_0_6px_rgba(243,184,103,0.45)]" : "opacity-35"}`}
                  fill="none"
                  stroke={b.defeated ? "#f3b867" : "#b3a596"}
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={BOSS_MARKS[b.key] ?? "M16 4l12 12-12 12L4 16z"} />
                </svg>
              )}
              {i === next && <span aria-hidden className="absolute inset-x-1.5 bottom-1 h-[3px] rounded-[1px] bg-[#2d2e30]"><span className="block h-full w-full rounded-[1px] bg-[#c3044a]" /></span>}
              <span className="sr-only">
                {name}, <span>{status(b)}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <div aria-hidden className="mt-3 flex min-h-[2.75rem] flex-col items-center justify-center text-center">
        {read && (
          <>
            <span className="boss-title text-xl">{lookup(`boss.${read.key}`) ?? read.key}</span>
            <span className="text-xs text-ash">{status(read)}</span>
          </>
        )}
        {!read && !unknown && <span className="text-xs text-ash">{t("progress.hint")}</span>}
      </div>
      {unknown && <p className="text-xs text-ash">{t("progress.note")}</p>}
    </div>
  );
});
