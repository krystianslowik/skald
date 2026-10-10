import { motion, useReducedMotion } from "motion/react";
import { memo, useMemo, useState } from "react";
import type { PlayerStats } from "../types";
import { useI18n } from "../i18n";
import { PlayerName } from "./PlayerName";

type Key = "playtime" | "deaths";

const SETTLE = { type: "spring" as const, bounce: 0, visualDuration: 0.35 };

export const Ranking = memo(function Ranking({ players, now }: { players: PlayerStats[]; now: number }) {
  const { t, ago, duration } = useI18n();
  const reduced = useReducedMotion();
  const [by, setBy] = useState<Key>("playtime");
  const sorted = useMemo(
    () => players.toSorted((a, b) => (by === "playtime" ? b.playtimeMs - a.playtimeMs : b.deaths - a.deaths || b.playtimeMs - a.playtimeMs)),
    [players, by],
  );
  let max = 1;
  for (const p of sorted) max = Math.max(max, by === "playtime" ? p.playtimeMs : p.deaths);

  if (players.length === 0) return <p className="text-sm text-ash">{t("ranking.empty")}</p>;

  return (
    <div>
      <div role="tablist" aria-label={t("ranking.sort")} className="mb-3 inline-flex gap-1 text-xs">
        {(
          [
            ["playtime", t("ranking.playtime")],
            ["deaths", t("ranking.deaths")],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={by === k}
            onClick={() => setBy(k)}
            className="plaque press px-3 py-1 font-bold uppercase tracking-[0.06em]"
          >
            {label}
          </button>
        ))}
      </div>
      <ol className="space-y-2.5">
        {sorted.map((p, i) => {
          const v = by === "playtime" ? p.playtimeMs : p.deaths;
          return (
            <motion.li key={p.name} layout={!reduced} transition={SETTLE} className="grid grid-cols-[1.25rem_1fr_auto] items-center gap-x-3">
              <span className="text-sm font-bold text-select-hi/80">{i + 1}</span>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <PlayerName name={p.name} className="truncate text-left text-[0.9375rem] font-bold text-bone" />
                  {p.online && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gold shadow-[0_0_6px_#ecc212]" title={t("ranking.onlineNow")} />}
                </div>
                <div className={`meter mt-1 h-2 ${by === "playtime" ? "meter-stamina" : "meter-hp"}`}>
                  <motion.div
                    className="h-full"
                    style={{ background: by === "playtime" ? "linear-gradient(180deg,#e6c45a,#cea83e 45%,#8a6f1a)" : "linear-gradient(180deg,#d73b3e,#c8303a 50%,#5f1410)" }}
                    initial={{ width: 0 }}
                    animate={{ width: `${(v / max) * 100}%` }}
                    transition={{ type: "spring", bounce: 0, visualDuration: 0.5 }}
                  />
                </div>
              </div>
              <div className="text-right text-sm tabular-nums">
                <div className="font-bold text-bone">{by === "playtime" ? duration(p.playtimeMs) : p.deaths}</div>
                <div className="text-[0.6875rem] text-ash">{p.online ? <span className="text-flame">{t("ranking.atFire")}</span> : ago(p.lastSeen, now)}</div>
              </div>
            </motion.li>
          );
        })}
      </ol>
    </div>
  );
});
