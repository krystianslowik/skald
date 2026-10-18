import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo } from "react";
import type { Player } from "../types";
import { useI18n } from "../i18n";
import { PlatformGlyph } from "./PlatformGlyph";
import { PlayerName } from "./PlayerName";
import { Shield } from "./Shield";
import { Elapsed } from "./RelativeTime";

/** Players at the fire: they step out of the dark as shields and leave as smoke. */
export const Hearth = memo(function Hearth({ players }: { players: Player[] }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const empty = players.length === 0;
  return (
    // Sized by who is there: a row of shields, or one quiet line when nobody is.
    <div className={`flex flex-wrap justify-center gap-x-3 gap-y-5 ${empty ? "min-h-24 content-center" : "content-start pt-1"}`}>
      <AnimatePresence mode="popLayout">
        {players.map((p) => (
          <motion.figure
            key={p.name}
            layout={!reduced}
            className="flex w-23 flex-col items-center text-center"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.85, filter: "brightness(0) blur(4px)" }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: "brightness(1) blur(0px)" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -34, scale: 1.08, filter: "grayscale(1) blur(10px) brightness(1.6)" }}
            transition={{ type: "spring", bounce: 0, visualDuration: 0.4, opacity: { duration: 0.5 }, filter: { duration: 0.8 } }}
          >
            <span className="slot grid h-21 w-21 place-items-center">
              <Shield name={p.name} size={68} />
            </span>
            <figcaption className="mt-1.5 w-full">
              <span className="flex w-full items-center justify-center gap-1">
                <PlatformGlyph platform={p.platform} className="text-label" />
                <PlayerName name={p.name} truncate className="block min-w-0 text-[0.9375rem] font-bold text-bone" />
              </span>
              <span className="block text-xs text-flame/90"><Elapsed since={p.since} /></span>
            </figcaption>
          </motion.figure>
        ))}
      </AnimatePresence>
      {empty && (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex max-w-[34ch] items-center gap-3 text-sm leading-relaxed text-ash">
          <svg width="30" height="30" viewBox="0 0 30 30" fill="none" strokeLinecap="round" aria-hidden className="shrink-0">
            {/* A cold fire: the logs and one ember. */}
            <path d="M5 24l18-6M25 24L7 18" stroke="#6b5745" strokeWidth="3" />
            <circle cx="15" cy="19.5" r="1.6" fill="#c2812f" opacity="0.8" />
          </svg>
          <span>{t("hearth.empty")}</span>
        </motion.p>
      )}
    </div>
  );
});
