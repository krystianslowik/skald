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
    phase.kind === "holding"
      ? t("rune.holding")
      : phase.kind === "sent"
        ? t("rune.sent")
        : phase.kind === "done"
          ? phase.message
          : disabled
            ? t("rune.sleeping")
            : `${t("key.hold")} ${t("rune.hold")}`;
  // Holding or burning: the slot is the selected one, in the game's blue.
  const active = phase.kind === "holding" || phase.kind === "sent";
  const statusTone = phase.kind === "done" ? (phase.ok ? "text-flame" : "text-blood") : active ? "text-bone" : "text-label/80";

  // One row per rune, the whole row the thing to hold: the carved rune on the
  // left lights stroke by stroke and a line of fire runs along the bottom.
  return (
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
      className={`press group relative flex min-h-16 w-full touch-none select-none items-center gap-3.5 overflow-hidden px-3 py-2.5 text-left transition-[background,box-shadow,opacity] enabled:hover:shadow-[inset_0_2px_7px_rgba(0,0,0,0.65),inset_0_0_0_1px_rgba(243,184,103,0.55)] disabled:cursor-not-allowed disabled:opacity-40 ${active ? "slot-selected" : "slot"}`}
    >
      <svg viewBox="0 0 40 62" width="26" height="40" aria-hidden className="shrink-0 overflow-visible">
        <path d={def.path} fill="none" stroke="#120c08" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
        <path d={def.path} fill="none" stroke="#6a4f38" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
        <motion.path
          d={def.path}
          fill="none"
          stroke="url(#rune-fire)"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ pathLength: progress, opacity: glow, filter: "drop-shadow(0 0 3px #d68a1a) drop-shadow(0 0 8px rgba(236,194,18,0.5))" }}
        />
      </svg>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[0.9375rem] font-bold leading-tight text-bone">{t(def.title)}</span>
          <span className="text-[0.6875rem] text-flame/80" title={t("rune.name", { rune: def.rune })}>
            <span aria-hidden className="mr-0.5 font-rune">
              {def.glyph}
            </span>
            {def.rune}
          </span>
        </span>
        <span className="mt-0.5 block text-xs leading-snug text-ash">{t(def.hint)}</span>
        {/* Phones: the status under the hint, where it has the width. */}
        <span aria-live="polite" className={`mt-1 block text-xs font-bold sm:hidden ${statusTone}`}>
          {status}
        </span>
      </span>
      <span aria-live="polite" className={`hidden max-w-[9rem] shrink-0 text-right text-xs font-bold leading-tight sm:block ${statusTone}`}>
        {status}
      </span>
      <motion.span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left bg-[linear-gradient(90deg,#e08a1c,#ffe58a)]" style={{ scaleX: progress, opacity: glow }} />
      <AnimatePresence>
        {phase.kind === "sent" && !reduced && (
          <motion.span
            className="pointer-events-none absolute inset-0 rounded-[inherit]"
            style={{ boxShadow: "inset 0 0 18px rgba(140,188,230,0.35)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0.4, 1, 0.6] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.2, repeat: Infinity, repeatType: "mirror" }}
          />
        )}
      </AnimatePresence>
    </button>
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
    <div className="flex flex-1 flex-col">
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id="rune-fire" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#e08a1c" />
            <stop offset="100%" stopColor="#ffe58a" />
          </linearGradient>
        </defs>
      </svg>
      {/* Beside the treasury on wide screens the rows share its height evenly. */}
      <div className="grid flex-1 auto-rows-fr gap-2.5">
        {RUNES.map((r) => (
          <Rune key={r.name} def={r} disabled={!online} onFire={fire} />
        ))}
      </div>
      {lastAction && (
        <p className="mt-4 border-t border-iron/40 pt-3 text-xs text-ash">
          {t("rune.last")}: {actionTitle(i18n, String(lastAction.data.name))},{" "}
          <span className={lastAction.data.ok ? "text-flame" : "text-blood"}>
            {actionStatus(i18n, Boolean(lastAction.data.ok), String(lastAction.data.message ?? ""))}
          </span>
        </p>
      )}
    </div>
  );
});
