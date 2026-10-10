import { AnimatePresence, motion, useReducedMotion, useSpring, useTransform } from "motion/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ActionName, AgentEvent } from "../types";
import { runAction } from "../lib/api";
import { crackle } from "../lib/campfire";
import { useI18n, type TextKey } from "../i18n";
import { actionStatus, actionTitle } from "./Saga";

const HOLD_MS = 1500;

interface RuneDef {
  name: ActionName;
  title: TextKey;
  rune: string;
  /** The same letter as Unicode Elder Futhark, set in Noto Sans Runic. */
  glyph: string;
  hint: TextKey;
  path: string;
}

// Elder Futhark strokes, drawn on a 40x60 box.
const RUNES: RuneDef[] = [
  { name: "backup", title: "rune.backup.title", rune: "Algiz", glyph: "ᛉ", hint: "rune.backup.hint", path: "M20 56V6M20 24L8 8M20 24L32 8" },
  { name: "update", title: "rune.update.title", rune: "Jera", glyph: "ᛃ", hint: "rune.update.hint", path: "M16 10L6 22L16 34M24 26L34 38L24 50" },
  { name: "restart", title: "rune.restart.title", rune: "Raido", glyph: "ᚱ", hint: "rune.restart.hint", path: "M10 56V6L28 16L10 28L30 56" },
];

type Phase = { kind: "idle" } | { kind: "holding" } | { kind: "sent" } | { kind: "done"; ok: boolean; message: string };
type Fire = (name: ActionName) => Promise<{ ok: boolean; message: string }>;

/** How the lit stroke returns to cold: from wherever it is, without overshoot. */
const SPRING_BACK = { bounce: 0, visualDuration: 0.35 };
const QUICK_BACK = { bounce: 0, visualDuration: 0.12 };

const Rune = memo(function Rune({ def, disabled, onFire }: { def: RuneDef; disabled: boolean; onFire: Fire }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Hold progress lives in a spring-backed motion value: no React render per
  // frame. Holding jumps it directly (1:1 with time); letting go springs it
  // back from the exact value and velocity it had.
  const progress = useSpring(0, reduced ? QUICK_BACK : SPRING_BACK);
  const glow = useTransform(progress, (v) => (v > 0.002 ? 1 : 0));
  const raf = useRef(0);
  const started = useRef(0);
  const firing = useRef(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);

  const release = useCallback(() => progress.set(0), [progress]);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    if (!firing.current) {
      setPhase((p) => (p.kind === "holding" ? { kind: "idle" } : p));
      if (progress.get() > 0 && progress.get() < 1) release();
    }
  }, [progress, release]);

  const fire = useCallback(async () => {
    firing.current = true;
    setPhase({ kind: "sent" });
    const r = await onFire(def.name);
    setPhase({ kind: "done", ok: r.ok, message: r.message });
    firing.current = false;
    if (!r.ok) release();
    if (reset.current) clearTimeout(reset.current);
    reset.current = setTimeout(() => {
      release();
      setPhase({ kind: "idle" });
    }, 4000);
  }, [onFire, def.name, release]);

  const begin = useCallback(() => {
    if (disabled || firing.current || phase.kind === "sent") return;
    // Pressed again while cooling: continue from the current glow, not from zero.
    started.current = performance.now() - progress.get() * HOLD_MS;
    setPhase({ kind: "holding" });
    const tick = () => {
      const p = Math.min(1, (performance.now() - started.current) / HOLD_MS);
      progress.jump(p);
      if (p >= 1) {
        // Same frame as the stroke completing: the pop (if sound is on), then the request.
        crackle();
        void fire();
      } else raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [disabled, fire, phase.kind, progress]);

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      if (reset.current) clearTimeout(reset.current);
    },
    [],
  );

  const status =
    phase.kind === "holding" ? (
      t("rune.holding")
    ) : phase.kind === "sent" ? (
      t("rune.sent")
    ) : phase.kind === "done" ? (
      phase.message
    ) : disabled ? (
      t("rune.sleeping")
    ) : (
      <>
        <span className="key-chip mr-1.5">{t("key.hold")}</span>
        {t("rune.hold")}
      </>
    );
  // Holding or burning: the slot is the selected one, in the game's blue.
  const active = phase.kind === "holding" || phase.kind === "sent";

  return (
    <div className="flex flex-col items-center text-center">
      <button
        type="button"
        disabled={disabled}
        aria-label={t("rune.aria", { title: t(def.title) })}
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
        className={`press group relative grid h-24 w-24 touch-none select-none place-items-center transition-[background,box-shadow,opacity] enabled:hover:shadow-[inset_0_2px_7px_rgba(0,0,0,0.65),inset_0_0_0_1px_rgba(243,184,103,0.55)] disabled:cursor-not-allowed disabled:opacity-40 ${active ? "slot-selected" : "slot"}`}
      >
        <svg viewBox="0 0 40 62" width="40" height="62" aria-hidden className="overflow-visible">
          <path d={def.path} fill="none" stroke="#120c08" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
          <path d={def.path} fill="none" stroke="#5a4330" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <motion.path
            d={def.path}
            fill="none"
            stroke="url(#rune-fire)"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ pathLength: progress, opacity: glow, filter: "drop-shadow(0 0 3px #d68a1a) drop-shadow(0 0 8px rgba(236,194,18,0.5))" }}
          />
        </svg>
        <AnimatePresence>
          {phase.kind === "sent" && !reduced && (
            <motion.span
              className="pointer-events-none absolute inset-0 rounded-[inherit]"
              style={{ boxShadow: "0 0 26px 4px rgba(94,151,204,0.5), inset 0 0 18px rgba(255,255,255,0.35)" }}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.4, 1, 0.6] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.2, repeat: Infinity, repeatType: "mirror" }}
            />
          )}
        </AnimatePresence>
      </button>
      <h3 className="mt-2.5 text-[0.9375rem] font-bold leading-tight text-bone">{t(def.title)}</h3>
      <p className="text-[0.6875rem] text-flame/90">
        <span aria-hidden className="mr-1 font-rune">
          {def.glyph}
        </span>
        {t("rune.name", { rune: def.rune })}
      </p>
      <p className="mt-1 max-w-[18ch] text-xs leading-snug text-ash">{t(def.hint)}</p>
      <p
        aria-live="polite"
        className={`mt-2 min-h-[1.25rem] text-xs ${phase.kind === "done" ? (phase.ok ? "text-flame" : "text-blood") : "text-ash"}`}
      >
        {status}
      </p>
    </div>
  );
});

/** Runes of power: actions behind a deliberate press-and-hold (pointer or Space/Enter). */
export const Runes = memo(function Runes({ online, lastAction }: { online: boolean; lastAction: AgentEvent | null }) {
  const i18n = useI18n();
  const { t } = i18n;
  const fire = useCallback<Fire>(
    async (name) => {
      try {
        const r = await runAction(name);
        if (r.status === 409) return { ok: false, message: t("rune.busy") };
        if (r.status === 503 || r.status === 502) return { ok: false, message: t("rune.offline") };
        return { ok: r.body.ok, message: r.body.ok ? t("rune.accepted") : r.body.message || t("rune.failed") };
      } catch {
        return { ok: false, message: t("rune.failed") };
      }
    },
    [t],
  );
  return (
    <div>
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id="rune-fire" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#e08a1c" />
            <stop offset="100%" stopColor="#ffe58a" />
          </linearGradient>
        </defs>
      </svg>
      <div className="grid grid-cols-3 gap-3">
        {RUNES.map((r) => (
          <Rune key={r.name} def={r} disabled={!online} onFire={fire} />
        ))}
      </div>
      {lastAction && (
        <p className="mt-4 border-t border-iron/40 pt-3 text-center text-xs text-ash">
          {t("rune.last")}: {actionTitle(i18n, String(lastAction.data.name))},{" "}
          <span className={lastAction.data.ok ? "text-flame" : "text-blood"}>
            {actionStatus(i18n, Boolean(lastAction.data.ok), String(lastAction.data.message ?? ""))}
          </span>
        </p>
      )}
    </div>
  );
});
