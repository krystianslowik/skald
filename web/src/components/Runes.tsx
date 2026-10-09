import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionName, AgentEvent } from "../types";
import { runAction } from "../lib/api";
import { useI18n, type TextKey } from "../i18n";
import { actionStatus, actionTitle } from "./Saga";

const HOLD_MS = 1500;

interface RuneDef {
  name: ActionName;
  title: TextKey;
  rune: string;
  hint: TextKey;
  path: string;
}

// Elder Futhark strokes, drawn on a 40x60 box.
const RUNES: RuneDef[] = [
  { name: "backup", title: "rune.backup.title", rune: "Algiz", hint: "rune.backup.hint", path: "M20 56V6M20 24L8 8M20 24L32 8" },
  { name: "update", title: "rune.update.title", rune: "Jera", hint: "rune.update.hint", path: "M16 10L6 22L16 34M24 26L34 38L24 50" },
  { name: "restart", title: "rune.restart.title", rune: "Raido", hint: "rune.restart.hint", path: "M10 56V6L28 16L10 28L30 56" },
];

type Phase = { kind: "idle" } | { kind: "holding" } | { kind: "sent" } | { kind: "done"; ok: boolean; message: string };

function Rune({ def, disabled, onFire }: { def: RuneDef; disabled: boolean; onFire: () => Promise<{ ok: boolean; message: string }> }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [progress, setProgress] = useState(0);
  const raf = useRef(0);
  const started = useRef(0);
  const firing = useRef(false);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    if (!firing.current) {
      setPhase((p) => (p.kind === "holding" ? { kind: "idle" } : p));
      setProgress(0);
    }
  }, []);

  const fire = useCallback(async () => {
    firing.current = true;
    setPhase({ kind: "sent" });
    const r = await onFire();
    setPhase({ kind: "done", ok: r.ok, message: r.message });
    firing.current = false;
    setTimeout(() => {
      setProgress(0);
      setPhase({ kind: "idle" });
    }, 4000);
  }, [onFire]);

  const begin = useCallback(() => {
    if (disabled || firing.current || phase.kind === "sent") return;
    started.current = performance.now();
    setPhase({ kind: "holding" });
    const tick = () => {
      const p = Math.min(1, (performance.now() - started.current) / HOLD_MS);
      setProgress(p);
      if (p >= 1) void fire();
      else raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [disabled, fire, phase.kind]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const lit = phase.kind === "sent" || (phase.kind === "done" && phase.ok);
  const status =
    phase.kind === "holding"
      ? t("rune.holding")
      : phase.kind === "sent"
        ? t("rune.sent")
        : phase.kind === "done"
          ? phase.message
          : disabled
            ? t("rune.sleeping")
            : t("rune.hold");

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
        className="group relative grid h-[120px] w-[96px] touch-none select-none place-items-center rounded-[48%_48%_44%_44%/40%_40%_60%_60%] border border-iron/50 bg-[radial-gradient(circle_at_50%_30%,#3a2a1d,#1d140e)] shadow-[inset_0_2px_0_rgba(255,179,71,0.08),inset_0_-6px_14px_rgba(0,0,0,0.6),0_10px_24px_-10px_#000] transition-[border-color,opacity] enabled:hover:border-ember/50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <svg viewBox="0 0 40 62" width="46" height="70" aria-hidden className="overflow-visible">
          <path d={def.path} fill="none" stroke="#120c08" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
          <path d={def.path} fill="none" stroke="#4a3626" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <motion.path
            d={def.path}
            fill="none"
            stroke="url(#rune-fire)"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: "drop-shadow(0 0 4px #ff7a1a) drop-shadow(0 0 10px rgba(255,122,26,0.6))" }}
            initial={false}
            animate={{ pathLength: lit ? 1 : progress, opacity: lit || progress > 0 ? 1 : 0 }}
            transition={phase.kind === "holding" || reduced ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 20 }}
          />
        </svg>
        <AnimatePresence>
          {phase.kind === "sent" && !reduced && (
            <motion.span
              className="pointer-events-none absolute inset-0 rounded-[inherit]"
              style={{ boxShadow: "0 0 40px 6px rgba(255,122,26,0.55), inset 0 0 24px rgba(255,179,71,0.5)" }}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.4, 1, 0.6] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.2, repeat: Infinity, repeatType: "mirror" }}
            />
          )}
        </AnimatePresence>
      </button>
      <h3 className="mt-3 font-display text-[15px] font-semibold text-bone">{t(def.title)}</h3>
      <p className="text-[11px] text-ash/80">{t("rune.name", { rune: def.rune })}</p>
      <p className="mt-1 max-w-[18ch] text-xs leading-snug text-ash">{t(def.hint)}</p>
      <p
        aria-live="polite"
        className={`mt-1.5 min-h-[1.25rem] text-xs ${phase.kind === "done" ? (phase.ok ? "text-flame" : "text-[#e3a091]") : "text-ash/70"}`}
      >
        {status}
      </p>
    </div>
  );
}

/** Runes of power: actions behind a deliberate press-and-hold (pointer or Space/Enter). */
export function Runes({ online, lastAction }: { online: boolean; lastAction: AgentEvent | null }) {
  const i18n = useI18n();
  const { t } = i18n;
  const fire = (name: ActionName) => async () => {
    try {
      const r = await runAction(name);
      if (r.status === 409) return { ok: false, message: t("rune.busy") };
      if (r.status === 503 || r.status === 502) return { ok: false, message: t("rune.offline") };
      return { ok: r.body.ok, message: r.body.ok ? t("rune.accepted") : r.body.message || t("rune.failed") };
    } catch {
      return { ok: false, message: t("rune.failed") };
    }
  };
  return (
    <div>
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id="rune-fire" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#ff7a1a" />
            <stop offset="100%" stopColor="#ffe2b0" />
          </linearGradient>
        </defs>
      </svg>
      <div className="grid grid-cols-3 gap-3">
        {RUNES.map((r) => (
          <Rune key={r.name} def={r} disabled={!online} onFire={fire(r.name)} />
        ))}
      </div>
      {lastAction && (
        <p className="mt-4 border-t border-iron/25 pt-3 text-center text-xs text-ash">
          {t("rune.last")}: {actionTitle(i18n, String(lastAction.data.name))},{" "}
          <span className={lastAction.data.ok ? "text-flame" : "text-[#e3a091]"}>
            {actionStatus(i18n, Boolean(lastAction.data.ok), String(lastAction.data.message ?? ""))}
          </span>
        </p>
      )}
    </div>
  );
}
