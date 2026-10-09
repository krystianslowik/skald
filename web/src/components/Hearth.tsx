import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Player } from "../types";
import { useI18n } from "../i18n";
import { PlayerName } from "./Profile";
import { Shield } from "./Shield";

/** Players at the fire: they step out of the dark as shields and leave as smoke. */
export function Hearth({ players, now }: { players: Player[]; now: number }) {
  const { t, duration } = useI18n();
  const reduced = useReducedMotion();
  return (
    <div className="flex min-h-[180px] flex-wrap content-start justify-center gap-x-5 gap-y-6 pt-1">
      <AnimatePresence mode="popLayout">
        {players.map((p) => (
          <motion.figure
            key={p.name}
            layout
            className="flex w-[92px] flex-col items-center text-center"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.85, filter: "brightness(0) blur(4px)" }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: "brightness(1) blur(0px)" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -34, scale: 1.08, filter: "grayscale(1) blur(10px) brightness(1.6)" }}
            transition={{ type: "spring", stiffness: 140, damping: 18, mass: 0.9, opacity: { duration: 0.6 }, filter: { duration: 0.9 } }}
          >
            <Shield name={p.name} size={84} />
            <figcaption className="mt-2 w-full">
              <PlayerName name={p.name} className="block w-full truncate font-display text-[15px] font-semibold text-bone" />
              <span className="block text-xs text-ash">{duration(now - Date.parse(p.since))}</span>
            </figcaption>
          </motion.figure>
        ))}
      </AnimatePresence>
      {players.length === 0 && (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-[26ch] self-center text-sm leading-relaxed text-ash">
          {t("hearth.empty")}
        </motion.p>
      )}
    </div>
  );
}
