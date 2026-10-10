import { motion, useReducedMotion, useSpring, useTransform } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { crackle } from "../../lib/campfire";
import { useI18n } from "../../i18n";

/** How long a destructive admin action must be held (the Runes hold 1.5 s). */
export const HOLD_MS = 1200;

/**
 * Press and hold: a ring fills around the button for `ms`; letting go early
 * springs it back from where it was. Keyboard: hold Space or Enter. For
 * kick, ban, stopping a raid and removing a boss key.
 */
export function HoldButton({
  onConfirm,
  children,
  disabled = false,
  danger = true,
  ms = HOLD_MS,
  className = "",
  label,
}: {
  onConfirm: () => void;
  children: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  ms?: number;
  className?: string;
  /** Accessible name; the visible text plus the "hold" hint otherwise. */
  label?: string;
}) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const progress = useSpring(0, reduced ? { bounce: 0, visualDuration: 0.12 } : { bounce: 0, visualDuration: 0.3 });
  const dash = useTransform(progress, (v) => v);
  const raf = useRef(0);
  const start = useRef(0);
  const [holding, setHolding] = useState(false);
  const fired = useRef(false);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    setHolding(false);
    if (!fired.current) progress.set(0);
  }, [progress]);

  const begin = useCallback(() => {
    if (disabled) return;
    fired.current = false;
    start.current = performance.now() - progress.get() * ms;
    setHolding(true);
    navigator.vibrate?.(8);
    const tick = () => {
      const p = Math.min(1, (performance.now() - start.current) / ms);
      progress.jump(p);
      if (p >= 1) {
        fired.current = true;
        setHolding(false);
        crackle();
        navigator.vibrate?.([12, 40, 18]);
        onConfirm();
        setTimeout(() => {
          fired.current = false;
          progress.set(0);
        }, 600);
      } else raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [disabled, ms, onConfirm, progress]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      title={t("admin.holdHint")}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        begin();
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") stop();
      }}
      onContextMenu={(e) => e.preventDefault()}
      className={`press relative flex min-h-11 touch-none select-none items-center justify-center gap-2 overflow-hidden rounded-[3px] border px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 ${
        danger ? "border-blood/50 bg-[linear-gradient(180deg,rgba(120,30,24,0.55),rgba(70,16,12,0.7))] text-bone" : "plaque"
      } ${holding ? "slot-selected" : ""} ${className}`}
    >
      {/* The fill grows left to right while held. */}
      <motion.span
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 left-0 w-full origin-left ${danger ? "bg-blood/45" : "bg-select/40"}`}
        style={{ scaleX: dash }}
      />
      <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden className="relative shrink-0">
        <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
        <motion.circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" transform="rotate(-90 10 10)" style={{ pathLength: progress }} />
      </svg>
      <span className="relative">{children}</span>
      <span aria-hidden className="key-chip relative ml-1 hidden sm:inline-flex">
        {t("key.hold")}
      </span>
    </button>
  );
}
