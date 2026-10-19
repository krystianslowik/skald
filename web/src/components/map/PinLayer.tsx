import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, type RefObject } from "react";
import type { WebPin } from "@server/pintypes";
import { useI18n, type TextKey } from "../../i18n";
import { isDone, PIN_ICON_MARK } from "../../lib/webpins";
import type { MapCanvasHandle } from "./MapCanvas";
import { MapIcon } from "./MapIcon";

export interface PinLayerHandle {
  /** Put every pin where the current view shows it (hidden when off screen). */
  place(): void;
  /** The pin whose head is at this canvas point, as last placed; null when none. */
  pick(x: number, y: number, touch: boolean): WebPin | null;
}

/** The ring around a pin says its state at a glance. */
export const STATE_RING: Record<WebPin["state"], string> = {
  new: "border-flame",
  claimed: "border-select-hi",
  cleared: "border-iron",
  depleted: "border-iron",
};

/** The head of a pin sits this far above its point, on a stalk. */
const HEAD_ABOVE = 18;
/** How close to the head a pointer must land to pick it. */
const PICK_MOUSE = 16;
const PICK_TOUCH = 24;
/** Pins this far outside the map still get placed, so one sliding in is already there. */
const MARGIN = 60;

const PinButton = memo(function PinButton({ pin, on, onOpen, setEl }: { pin: WebPin; on: boolean; onOpen: (pin: WebPin) => void; setEl: (id: string, el: HTMLElement | null) => void }) {
  const { t } = useI18n();
  const done = isDone(pin);
  return (
    <div ref={(el) => setEl(pin.id, el)} className="absolute left-0 top-0" style={{ transform: "translate3d(-999px,-999px,0)", visibility: "hidden" }}>
      {/* No pointer events: taps reach the map, which picks the pin (so a pan or a pinch from a pin moves the map). Keyboard users press it. */}
      <button
        type="button"
        data-pin={pin.id}
        onClick={() => onOpen(pin)}
        aria-label={t("pins.open", { note: pin.note || t(`pins.icon.${pin.icon}` as TextKey), state: t(`pins.state.${pin.state}` as TextKey) })}
        aria-pressed={on}
        className="pointer-events-none absolute left-[-22px] top-[-40px] grid h-11 w-11 place-items-center focus-visible:outline-2 focus-visible:outline-bone"
      >
        <span aria-hidden className={`absolute left-1/2 top-[30px] h-2.5 w-0.5 -translate-x-1/2 ${done ? "bg-iron" : "bg-[#10161d]"}`} />
        <span
          aria-hidden
          className={`relative grid h-7.5 w-7.5 place-items-center rounded-full border-[2.5px] bg-[#e6d7b4] shadow-[0_2px_6px_rgba(0,0,0,0.6)] transition-transform ${STATE_RING[pin.state]} ${done ? "opacity-60 saturate-50" : ""} ${on ? "scale-125 ring-2 ring-bone" : ""}`}
        >
          <MapIcon icon={PIN_ICON_MARK[pin.icon]} size={22} />
          {done && (
            <span className="absolute -right-1.5 -top-1.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-iron text-bone">
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 4.2l1.7 1.6L6.5 2.2" />
              </svg>
            </span>
          )}
          {pin.state === "claimed" && <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-[#10161d] bg-select-hi" />}
        </span>
      </button>
    </div>
  );
});

/**
 * Web pins on the map: a DOM layer over the canvas (like the live players),
 * so it looks the same over the WebGL and the Canvas2D renderer. Each pin is
 * a mark on a stalk; done pins are faded with a tick. The canvas does the
 * picking (`pick`), so gestures that start on a pin still move the map.
 */
export const PinLayer = forwardRef<PinLayerHandle, { canvas: RefObject<MapCanvasHandle | null>; pins: readonly WebPin[]; selected: string | null; onOpen: (pin: WebPin) => void }>(function PinLayer(
  { canvas, pins, selected, onOpen },
  ref,
) {
  const { t } = useI18n();
  const els = useRef(new Map<string, HTMLElement>());
  const group = useRef<HTMLDivElement>(null);
  const byId = useRef(new Map<string, WebPin>());
  byId.current = new Map(pins.map((p) => [p.id, p]));
  /** Where each pin was placed last, in canvas px; only those on screen. */
  const placed = useRef(new Map<string, [number, number]>());
  /** What was last written to each element, so a frame writes only what moved. */
  const written = useRef(new WeakMap<HTMLElement, string>());

  const setEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) els.current.set(id, el);
    else els.current.delete(id);
  }, []);

  const place = useCallback(() => {
    const c = canvas.current;
    const box = group.current;
    if (!c || !box) return;
    const W = box.clientWidth;
    const H = box.clientHeight;
    placed.current.clear();
    // Reads first, then writes, so a frame lays out once.
    const writes: [HTMLElement, string][] = [];
    for (const [id, el] of els.current) {
      const p = byId.current.get(id);
      if (!p) continue;
      const [x, y] = c.project(p.x, p.z);
      const on = x > -MARGIN && y > -MARGIN && x < W + MARGIN && y < H + MARGIN;
      if (on) placed.current.set(id, [x, y]);
      writes.push([el, on ? `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)` : "off"]);
    }
    for (const [el, w] of writes) {
      if (written.current.get(el) === w) continue;
      written.current.set(el, w);
      if (w === "off") el.style.visibility = "hidden";
      else {
        el.style.transform = w;
        el.style.visibility = "visible";
      }
    }
  }, [canvas]);

  const pick = useCallback((x: number, y: number, touch: boolean) => {
    const reach = touch ? PICK_TOUCH : PICK_MOUSE;
    let best: WebPin | null = null;
    let bestD = reach;
    for (const [id, [px, py]] of placed.current) {
      const d = Math.hypot(x - px, y - (py - HEAD_ABOVE));
      if (d <= bestD) {
        bestD = d;
        best = byId.current.get(id) ?? null;
      }
    }
    return best;
  }, []);

  useImperativeHandle(ref, () => ({ place, pick }), [place, pick]);
  // New or moved pins take their places at once, not at the next pan.
  useEffect(() => place(), [pins, place]);

  if (pins.length === 0) return null;
  return (
    <div ref={group} className="pointer-events-none absolute inset-0 z-4 overflow-hidden" role="group" aria-label={t("pins.layer")}>
      {pins.map((p) => (
        <PinButton key={p.id} pin={p} on={p.id === selected} onOpen={onOpen} setEl={setEl} />
      ))}
    </div>
  );
});
