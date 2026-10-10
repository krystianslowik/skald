import { animate, motion, useMotionValue, useReducedMotion, useTransform, type AnimationPlaybackControls } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { dragOffset, FLICK_VELOCITY, shouldDismiss, travelFor, velocityFrom, VELOCITY_WINDOW_MS, type Sample } from "../lib/sheet";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Phones get a bottom sheet (swipe down), wider screens a side sheet (drag right). */
const BOTTOM_SHEET = "(max-width: 639px)";
/** Pointer travel before a press on the handle becomes a drag, so taps (the close button) stay taps. */
const DRAG_SLOP = 6;
/** Critically damped: settles without overshoot. */
export const SETTLE = { type: "spring" as const, bounce: 0, visualDuration: 0.35 };
const FADE = { duration: 0.2, ease: "easeOut" as const };

/**
 * A wooden board that slides in: a bottom sheet on phones and a side sheet on
 * wider screens. It enters and leaves along the same edge, and can be dragged
 * away by its header (1:1, with momentum) or closed with Escape, the close
 * button (`header` gets the close function) or the scrim. Every close is
 * interruptible: grab the sheet while it is leaving and it follows the pointer
 * again. Focus goes to the element marked `data-autofocus` and stays inside.
 */
export function Sheet({
  labelledBy,
  onClose,
  header,
  children,
  footer,
  width = "sm:w-[28.75rem]",
}: {
  labelledBy: string;
  onClose: () => void;
  header: (close: () => void) => ReactNode;
  children: ReactNode;
  /** Pinned under the scrolling body (a sticky action bar). */
  footer?: ReactNode;
  /** Width of the side sheet on wider screens. */
  width?: string;
}) {
  const reduced = useReducedMotion() ?? false;
  const panel = useRef<HTMLDivElement>(null);
  const [vertical] = useState(() => typeof window !== "undefined" && (window.matchMedia?.(BOTTOM_SHEET).matches ?? false));

  // Offset along the dismiss axis in px: 0 open, `size` gone, negative past the open edge.
  const offset = useMotionValue(typeof window === "undefined" ? 10_000 : Math.max(window.innerWidth, window.innerHeight));
  const fade = useMotionValue(reduced ? 0 : 1);
  const size = useRef(1);
  const motionAnim = useRef<AnimationPlaybackControls | null>(null);
  const fadeAnim = useRef<AnimationPlaybackControls | null>(null);
  const closing = useRef(false);
  const dragged = useRef(false);
  const done = useRef(onClose);
  done.current = onClose;
  const scrim = useTransform(() => fade.get() * (1 - Math.min(1, Math.max(0, offset.get() / size.current))));

  const measure = () => {
    const el = panel.current;
    const s = vertical ? el?.offsetHeight : el?.offsetWidth;
    size.current = s || (vertical ? window.innerHeight : window.innerWidth) || 1;
    return size.current;
  };

  const stop = () => {
    motionAnim.current?.stop();
    fadeAnim.current?.stop();
  };

  /** Spring to open or closed from wherever the sheet is now, carrying the release velocity. */
  const settle = (to: "open" | "closed", velocity = 0) => {
    stop();
    closing.current = to === "closed";
    const finish = () => {
      if (closing.current) done.current();
    };
    if (reduced) {
      // No slides: cross-fade out, or ease back into place after a drag.
      if (to === "closed") fadeAnim.current = animate(fade, 0, { ...FADE, onComplete: finish });
      else motionAnim.current = animate(offset, 0, FADE);
      return;
    }
    // A flick that throws the sheet back open earns a little bounce; everything else lands softly.
    const bounce = to === "open" && Math.abs(velocity) >= FLICK_VELOCITY ? 0.2 : 0;
    motionAnim.current = animate(offset, to === "open" ? 0 : size.current, { ...SETTLE, bounce, velocity, onComplete: finish });
  };
  const requestClose = () => {
    if (!closing.current) settle("closed");
  };

  useLayoutEffect(() => {
    const s = measure();
    if (reduced) {
      offset.jump(0);
      fadeAnim.current = animate(fade, 1, FADE);
    } else {
      offset.jump(s);
      settle("open");
    }
    return stop;
    // Entry runs once per mount; `settle` only reads refs and motion values.
  }, []);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  /** Drag by the header (or the side grip): tracks 1:1, hands its velocity to the settling spring. */
  const grab = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const coord = (ev: { clientX: number; clientY: number }) => (vertical ? ev.clientY : ev.clientX);
    const start = coord(e);
    stop();
    // Grabbed while leaving: it is ours again.
    const wasClosing = closing.current;
    closing.current = false;
    if (reduced && wasClosing) fade.jump(1);
    measure();
    const base = travelFor(offset.get(), size.current);
    const samples: Sample[] = [];
    let active = false;
    dragged.current = false;

    const move = (ev: PointerEvent) => {
      const d = coord(ev) - start;
      if (!active) {
        if (Math.abs(d) < DRAG_SLOP) return;
        active = true;
        dragged.current = true;
      }
      const travel = base + d;
      offset.set(dragOffset(travel, size.current));
      samples.push({ p: travel, t: ev.timeStamp });
      while (samples.length > 2 && samples[samples.length - 1]!.t - samples[0]!.t > VELOCITY_WINDOW_MS * 2) samples.shift();
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!active) {
        // A press that never moved: resume whatever was happening.
        if (wasClosing) settle("closed");
        else if (offset.get() !== 0) settle("open");
        return;
      }
      if (ev.type === "pointercancel") return settle("open");
      const v = velocityFrom(samples);
      settle(shouldDismiss(offset.get(), v, size.current) ? "closed" : "open", v);
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", end, { passive: true });
    window.addEventListener("pointercancel", end, { passive: true });
  };

  // Keep Tab inside the dialog.
  const trap = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50">
      <motion.div aria-hidden className="sheet-scrim absolute inset-0" style={{ opacity: scrim }} onClick={requestClose} />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onKeyDown={trap}
        style={vertical ? { y: offset, opacity: fade } : { x: offset, opacity: fade }}
        className={`plank plank-smooth absolute inset-x-0 bottom-0 top-[max(1.5rem,env(safe-area-inset-top))] flex flex-col overflow-hidden rounded-b-none rounded-t-[4px] border-t-2 border-[#160d07] will-change-transform sm:inset-y-0 sm:left-auto sm:right-0 sm:top-0 sm:rounded-l-[4px] sm:rounded-r-none sm:border-l-2 sm:border-t-0 ${width}`}
      >
        {/* Side grip (wider screens): the sheet's left edge can be dragged right. */}
        <div aria-hidden onPointerDown={grab} className="absolute inset-y-0 left-0 z-10 hidden w-4 cursor-grab touch-none select-none active:cursor-grabbing sm:block">
          <span className="absolute left-1.5 top-1/2 h-10 w-1 -translate-y-1/2 rounded-full bg-iron/70" />
        </div>
        <header
          onPointerDown={grab}
          onClickCapture={(e) => {
            // The release of a drag is not a click on whatever it ended over.
            if (dragged.current) {
              dragged.current = false;
              e.stopPropagation();
              e.preventDefault();
            }
          }}
          className="shrink-0 cursor-grab touch-none select-none px-5 pb-4 pt-3 active:cursor-grabbing sm:px-7 sm:pt-6"
        >
          <span aria-hidden className="mx-auto mb-3 block h-1 w-10 rounded-full bg-iron/80 sm:hidden" />
          {header(requestClose)}
          <div aria-hidden className="plank-rule mt-4" />
        </header>

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-10 sm:px-7">{children}</div>
        {footer}
      </motion.div>
    </div>
  );
}

/** The round close plaque with its Esc chip, shared by every sheet. */
export function SheetClose({ label, escLabel, onClose }: { label: string; escLabel: string; onClose: () => void }) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5 self-start">
      <button data-autofocus type="button" onClick={onClose} aria-label={label} className="plaque press grid h-9 w-9 place-items-center">
        <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      </button>
      {/* Keyboard hint, like the game's key chips; phones close by swiping instead. */}
      <span aria-hidden className="key-chip hidden sm:inline-flex">
        {escLabel}
      </span>
    </div>
  );
}
