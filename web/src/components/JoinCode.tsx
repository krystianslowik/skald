import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { COARSE, useMedia } from "../lib/useMedia";

interface Spark {
  id: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  s: number;
}

let sparkId = 0;

/** Each digit starts as cold carved wood and catches fire after the one before it. */
function Digit({ ch, index, reduced }: { ch: string; index: number; reduced: boolean }) {
  return (
    <span className="relative inline-block" aria-hidden>
      <span className="digit digit-cold block">{ch}</span>
      <motion.span
        className="digit digit-lit absolute inset-0 block"
        initial={reduced ? false : { opacity: 0, filter: "brightness(2.2)" }}
        animate={{ opacity: 1, filter: "brightness(1)" }}
        transition={{ delay: 0.15 + index * 0.16, opacity: { delay: 0.15 + index * 0.16, duration: 0.35 }, filter: { delay: 0.3 + index * 0.16, duration: 0.9 } }}
      >
        {ch}
      </motion.span>
      {!reduced && (
        <motion.span
          className="pointer-events-none absolute -inset-2 rounded-full"
          style={{ background: "radial-gradient(circle, rgba(236,194,18,0.4), transparent 65%)" }}
          initial={{ opacity: 0, scale: 0.4 }}
          animate={{ opacity: [0, 1, 0], scale: [0.4, 1.3, 1.6] }}
          transition={{ delay: 0.12 + index * 0.16, duration: 0.7 }}
        />
      )}
    </span>
  );
}

export const JoinCode = memo(function JoinCode({ code, codeAt, status, now }: { code: string; codeAt: string | null; status: string; now: number }) {
  const { t, ago } = useI18n();
  const reduced = useReducedMotion() ?? false;
  // A finger taps; a mouse clicks.
  const coarse = useMedia(COARSE);
  const [sparks, setSparks] = useState<Spark[]>([]);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLButtonElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = /^\d{6}$/.test(code);

  const copy = async (e: React.MouseEvent | React.KeyboardEvent) => {
    if (!ready) return;
    try {
      await navigator.clipboard?.writeText(code);
    } catch {
      // clipboard denied: the code is still on screen
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1800);
    if (reduced) return;
    const rect = box.current?.getBoundingClientRect();
    const isMouse = "clientX" in e && e.clientX > 0;
    const x = rect ? (isMouse ? (e as React.MouseEvent).clientX - rect.left : rect.width / 2) : 0;
    const y = rect ? (isMouse ? (e as React.MouseEvent).clientY - rect.top : rect.height / 2) : 0;
    const burst = Array.from({ length: 18 }, () => {
      const a = Math.random() * Math.PI * 2;
      const d = 40 + Math.random() * 90;
      return { id: ++sparkId, x, y, dx: Math.cos(a) * d, dy: Math.sin(a) * d - 30, s: 2 + Math.random() * 3 };
    });
    setSparks((s) => [...s, ...burst]);
    setTimeout(() => setSparks((s) => s.filter((p) => !burst.includes(p))), 1000);
  };

  return (
    <div className="flex flex-col items-center text-center">
      <p className="on-world text-sm font-bold uppercase tracking-[0.16em] text-flame sm:text-base">{t("joinCode.title")}</p>
      <button
        ref={box}
        type="button"
        onClick={copy}
        disabled={!ready}
        aria-label={ready ? t("joinCode.aria", { digits: code.split("").join(" ") }) : t("joinCode.notReady")}
        className="press-soft group relative mt-2 select-none rounded-[3px] px-3 py-2 sm:px-6"
      >
        {ready ? (
          <span className="type-display flex gap-[0.05em] text-[clamp(3.4rem,13vw,8rem)] sm:gap-[0.07em]">
            {code.split("").map((ch, i) => (
              // Keyed by place and value: a new code re-ignites only the digits that changed.
              <Digit key={`${i}-${ch}`} ch={ch} index={i} reduced={reduced} />
            ))}
          </span>
        ) : (
          <span className="type-display flex gap-[0.05em] text-[clamp(3.4rem,13vw,8rem)] sm:gap-[0.07em]" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className="digit digit-cold">
                ·
              </span>
            ))}
          </span>
        )}
        <span className="pointer-events-none absolute inset-0 overflow-visible">
          <AnimatePresence>
            {sparks.map((p) => (
              <motion.span
                key={p.id}
                className="absolute rounded-full"
                style={{ left: p.x, top: p.y, width: p.s, height: p.s, background: "#ffe58a", boxShadow: "0 0 8px 2px rgba(214,140,24,0.8)" }}
                initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
                animate={{ x: p.dx, y: p.dy + 40, opacity: 0, scale: 0.3 }}
                transition={{ duration: 0.9, ease: [0.15, 0.7, 0.4, 1] }}
              />
            ))}
          </AnimatePresence>
        </span>
      </button>
      <div className="on-world mt-2 h-6 text-sm" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          {copied ? (
            <motion.span key="c" className="text-flame" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>
              {t("joinCode.copied")}
            </motion.span>
          ) : (
            <motion.span key="h" className="text-ash" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {ready ? t(coarse ? "joinCode.hintTouch" : "joinCode.hint", { ago: ago(codeAt, now) }) : status === "running" ? t("joinCode.waitPlayfab") : t("joinCode.starting")}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
});
