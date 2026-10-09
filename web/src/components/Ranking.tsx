import { motion } from "motion/react";
import { useState } from "react";
import type { PlayerStats } from "../types";
import { useI18n } from "../i18n";
import { PlayerName } from "./Profile";

type Key = "playtime" | "deaths";

export function Ranking({ players, now }: { players: PlayerStats[]; now: number }) {
  const { t, ago, duration } = useI18n();
  const [by, setBy] = useState<Key>("playtime");
  const sorted = [...players].sort((a, b) => (by === "playtime" ? b.playtimeMs - a.playtimeMs : b.deaths - a.deaths || b.playtimeMs - a.playtimeMs));
  const max = Math.max(1, ...sorted.map((p) => (by === "playtime" ? p.playtimeMs : p.deaths)));

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
            className={`rounded px-3 py-1 transition-colors ${by === k ? "bg-ember/15 text-flame" : "text-ash hover:text-bone"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <ol className="space-y-2.5">
        {sorted.map((p, i) => {
          const v = by === "playtime" ? p.playtimeMs : p.deaths;
          return (
            <motion.li key={p.name} layout transition={{ type: "spring", stiffness: 260, damping: 28 }} className="grid grid-cols-[1.25rem_1fr_auto] items-center gap-x-3">
              <span className="font-display text-sm text-ash">{i + 1}</span>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <PlayerName name={p.name} className="truncate text-left font-display text-[15px] font-semibold text-bone" />
                  {p.online && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember shadow-[0_0_6px_#ff7a1a]" title={t("ranking.onlineNow")} />}
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/40">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: by === "playtime" ? "linear-gradient(90deg,#b8430c,#ff7a1a,#ffb347)" : "linear-gradient(90deg,#5e1a10,#c2412d)" }}
                    initial={{ width: 0 }}
                    animate={{ width: `${(v / max) * 100}%` }}
                    transition={{ type: "spring", stiffness: 90, damping: 20 }}
                  />
                </div>
              </div>
              <div className="text-right text-sm tabular-nums">
                <div className="text-bone">{by === "playtime" ? duration(p.playtimeMs) : p.deaths}</div>
                <div className="text-[11px] text-ash">{p.online ? t("ranking.atFire") : ago(p.lastSeen, now)}</div>
              </div>
            </motion.li>
          );
        })}
      </ol>
    </div>
  );
}
