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
      <div role="tablist" aria-label={t("ranking.sort")} className="mb-3 inline-flex rounded-md border border-iron/40 p-0.5 text-xs">
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
            className={`press rounded px-3 py-1 transition-colors ${by === k ? "bg-ember/15 text-flame" : "text-ash hover:text-bone"}`}
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
              <span className="font-display text-sm text-ash">{i + 1}</span>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <PlayerName name={p.name} className="truncate text-left font-display text-[0.9375rem] font-semibold text-bone" />
                  {p.online && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember shadow-[0_0_6px_#ff7a1a]" title={t("ranking.onlineNow")} />}
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/40">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: by === "playtime" ? "linear-gradient(90deg,#b8430c,#ff7a1a,#ffb347)" : "linear-gradient(90deg,#5e1a10,#c2412d)" }}
                    initial={{ width: 0 }}
                    animate={{ width: `${(v / max) * 100}%` }}
                    transition={{ type: "spring", bounce: 0, visualDuration: 0.5 }}
                  />
                </div>
              </div>
              <div className="text-right text-sm tabular-nums">
                <div className="text-bone">{by === "playtime" ? duration(p.playtimeMs) : p.deaths}</div>
                <div className="text-[0.6875rem] text-ash">{p.online ? t("ranking.atFire") : ago(p.lastSeen, now)}</div>
              </div>
            </motion.li>
          );
        })}
      </ol>
    </div>
  );
});
