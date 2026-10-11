import { animate, motion, useMotionValue, useReducedMotion, useTransform, type AnimationPlaybackControls } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { dragOffset, FLICK_VELOCITY, pickDetent, shouldDismiss, travelFor, velocityFrom, VELOCITY_WINDOW_MS, type Sample } from "../lib/sheet";

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
 *
 * `peek` (phones): the sheet first shows only as tall as its content, up to
 * half the screen, and is dragged up to full height or down to dismiss.
 * `modal={false}`: no scrim and no page lock, so what is behind stays usable
 * (the map under a mark's details).
 */
export function Sheet({
  labelledBy,
  onClose,
  header,
  children,
  footer,
  width = "sm:w-115",
  modal = true,
  peek = false,
  closeRef,
  onHeight,
  onDismiss,
}: {
  labelledBy: string;
  onClose: () => void;
  header: (close: () => void) => ReactNode;
  children: ReactNode;
  /** Pinned under the scrolling body (a sticky action bar). */
  footer?: ReactNode;
  /** Width of the side sheet on wider screens. */
  width?: string;
  modal?: boolean;
  /** Start as tall as the content (bottom sheets only), with a second detent at full height. */
  peek?: boolean;
  /** Receives the animated close, so the owner can dismiss the sheet the same way the user would. */
  closeRef?: MutableRefObject<(() => void) | null>;
  /** How much of the screen's bottom the sheet covers once it rests (px). */
  onHeight?: (px: number) => void;
  /** A close has started (`onClose` follows once the sheet is gone, unless it is grabbed back). */
  onDismiss?: () => void;
}) {
  const reduced = useReducedMotion() ?? false;
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const headerEl = useRef<HTMLElement>(null);
  const [vertical] = useState(() => typeof window !== "undefined" && (window.matchMedia?.(BOTTOM_SHEET).matches ?? false));
  const peeks = peek && vertical;
  // Peeking sheets rest at `peekAt` until dragged up to 0; `expanded` lets the body scroll.
  const peekAt = useRef(0);
  const [expanded, setExpanded] = useState(!peeks);
  const expandedRef = useRef(!peeks);
  const heightCb = useRef(onHeight);
  heightCb.current = onHeight;
  const dismissCb = useRef(onDismiss);
  dismissCb.current = onDismiss;

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
    if (peeks) {
      // The content's own height (header, body, footer), at most half the screen.
      const b = body.current;
      const inner = (b?.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
      const padBottom = b ? parseFloat(getComputedStyle(b).paddingBottom) || 0 : 0;
      const content = (headerEl.current?.offsetHeight ?? 0) + inner + padBottom;
      const tall = Math.max(140, Math.min(size.current * 0.5, content || size.current * 0.4));
      peekAt.current = Math.max(0, size.current - tall);
    }
    return size.current;
  };
  /** The offset this sheet rests at while open. */
  const restAt = () => (peeks && !expandedRef.current ? peekAt.current : 0);
  const setRest = (full: boolean) => {
    expandedRef.current = full;
    setExpanded(full);
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
    const target = to === "open" ? restAt() : size.current;
    if (to === "open") heightCb.current?.(size.current - target);
    else dismissCb.current?.();
    if (reduced) {
      // No slides: cross-fade out, or ease back into place after a drag.
      if (to === "closed") fadeAnim.current = animate(fade, 0, { ...FADE, onComplete: finish });
      else motionAnim.current = animate(offset, target, FADE);
      return;
    }
    // A flick that throws the sheet back open earns a little bounce; everything else lands softly.
    const bounce = to === "open" && Math.abs(velocity) >= FLICK_VELOCITY ? 0.2 : 0;
    motionAnim.current = animate(offset, target, { ...SETTLE, bounce, velocity, onComplete: finish });
  };
  const requestClose = () => {
    if (!closing.current) settle("closed");
  };
  if (closeRef) closeRef.current = requestClose;

  useLayoutEffect(() => {
    const s = measure();
    if (reduced) {
      offset.jump(restAt());
      heightCb.current?.(s - restAt());
      fadeAnim.current = animate(fade, 1, FADE);
    } else {
      offset.jump(s);
      settle("open");
    }
    return stop;
    // Entry runs once per mount; `settle` only reads refs and motion values.
  }, []);

  // A peeking sheet follows its content: new details, new height.
  useEffect(() => {
    if (!peeks || typeof ResizeObserver === "undefined" || !body.current?.firstElementChild) return;
    const ro = new ResizeObserver(() => {
      if (closing.current || expandedRef.current) return;
      const before = peekAt.current;
      measure();
      if (Math.abs(before - peekAt.current) > 1 && !dragged.current) settle("open");
    });
    ro.observe(body.current.firstElementChild);
    return () => ro.disconnect();
  }, [peeks]);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    const overflow = document.body.style.overflow;
    if (modal) document.body.style.overflow = "hidden";
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
      if (peeks) {
        // Three resting points: full height, the peek, gone.
        const to = pickDetent(offset.get(), v, [0, peekAt.current, size.current]);
        if (to >= size.current) return settle("closed", v);
        setRest(to === 0);
        return settle("open", v);
      }
      settle(shouldDismiss(offset.get(), v, size.current) ? "closed" : "open", v);
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", end, { passive: true });
    window.addEventListener("pointercancel", end, { passive: true });
  };

  // The release of a drag is not a click on whatever it ended over.
  const swallowDragClick = (e: { stopPropagation(): void; preventDefault(): void }) => {
    if (dragged.current) {
      dragged.current = false;
      e.stopPropagation();
      e.preventDefault();
    }
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

  // On the body, so a sheet opened inside the map tab still covers the tab bar.
  return createPortal(
    <div className={`fixed inset-0 z-50 ${modal ? "" : "pointer-events-none"}`}>
      {modal && <motion.div aria-hidden className="sheet-scrim absolute inset-0" style={{ opacity: scrim }} onClick={requestClose} />}
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal={modal ? "true" : undefined}
        aria-labelledby={labelledBy}
        onKeyDown={trap}
        style={vertical ? { y: offset, opacity: fade } : { x: offset, opacity: fade }}
        className={`plank plank-smooth pointer-events-auto absolute inset-x-0 bottom-0 top-[max(1.5rem,env(safe-area-inset-top))] flex flex-col ${peeks ? "shadow-[0_-12px_40px_rgba(0,0,0,0.55)]" : ""} overflow-hidden rounded-b-none rounded-t-[4px] border-t-2 border-[#160d07] will-change-transform sm:inset-y-0 sm:left-auto sm:right-0 sm:top-0 sm:rounded-l-[4px] sm:rounded-r-none sm:border-l-2 sm:border-t-0 ${width}`}
      >
        {/* Side grip (wider screens): the sheet's left edge can be dragged right. */}
        <div aria-hidden onPointerDown={grab} className="absolute inset-y-0 left-0 z-10 hidden w-4 cursor-grab touch-none select-none active:cursor-grabbing sm:block">
          <span className="absolute left-1.5 top-1/2 h-10 w-1 -translate-y-1/2 rounded-full bg-iron/70" />
        </div>
        <header
          ref={headerEl}
          onPointerDown={grab}
          onClickCapture={swallowDragClick}
          className="shrink-0 cursor-grab touch-none select-none px-5 pb-4 pt-3 active:cursor-grabbing sm:px-7 sm:pt-6"
        >
          <span aria-hidden className="mx-auto mb-3 block h-1 w-10 rounded-full bg-iron/80 sm:hidden" />
          {header(requestClose)}
          <div aria-hidden className="plank-rule mt-4" />
        </header>

        <div
          ref={body}
          // A peeking sheet scrolls only once it is pulled up; until then a drag on it moves the sheet.
          onPointerDown={peeks && !expanded ? grab : undefined}
          onClickCapture={swallowDragClick}
          className={`scroll-quiet min-h-0 flex-1 overscroll-contain px-5 pb-[max(2.5rem,calc(env(safe-area-inset-bottom)+1.5rem))] sm:px-7 ${expanded ? "overflow-y-auto" : "touch-none overflow-hidden"}`}
        >
          <div>{children}</div>
        </div>
        {footer}
      </motion.div>
    </div>,
    document.body,
  );
}

/** The round close plaque with its Esc chip, shared by every sheet. */
export function SheetClose({ label, escLabel, onClose }: { label: string; escLabel: string; onClose: () => void }) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5 self-start">
      <button data-autofocus type="button" onClick={onClose} aria-label={label} className="plaque press grid h-9 w-9 place-items-center coarse:h-11 coarse:w-11">
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
