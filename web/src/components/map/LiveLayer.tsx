import { useReducedMotion } from "motion/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type RefObject } from "react";
import { Glide, useLivePositions } from "../../lib/live";
import { useI18n } from "../../i18n";
import { PlatformGlyph } from "../PlatformGlyph";
import type { MapCanvasHandle } from "./MapCanvas";

export interface LiveLayerHandle {
  /** Put every marker where the current view shows its player. */
  place(): void;
}

/**
 * Players on the map, live: a marker per player that glides between the
 * agent's 2 s samples, with the name and the platform mark. Each marker is
 * a 44 px button; a tap opens the player.
 */
export const LiveLayer = forwardRef<LiveLayerHandle, { canvas: RefObject<MapCanvasHandle | null>; onOpen?: (name: string) => void }>(function LiveLayer({ canvas, onOpen }, ref) {
  const { t } = useI18n();
  const reduced = useReducedMotion() ?? false;
  const live = useLivePositions();
  const glide = useRef(new Glide());
  const els = useRef(new Map<string, HTMLElement>());
  const frame = useRef<number | null>(null);
  const last = useRef(0);
  const players = useRef(live.players);
  players.current = live.players;

  const place = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    for (const [name, el] of els.current) {
      const at = glide.current.at(name);
      if (!at) continue;
      const [x, y] = c.project(at.x, at.z);
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    }
  }, [canvas]);

  useImperativeHandle(ref, () => ({ place }), [place]);

  // A new sample: glide towards it, frame by frame, until every marker rests.
  useEffect(() => {
    const tick = (now: number) => {
      const dt = Math.min(0.064, last.current ? (now - last.current) / 1000 : 0.016);
      last.current = now;
      const moving = glide.current.step(players.current, dt, reduced);
      place();
      frame.current = moving ? requestAnimationFrame(tick) : null;
      if (!moving) last.current = 0;
    };
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  }, [live, place, reduced]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  if (live.players.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" aria-label={t("map.live.label")} role="group">
      {live.players.map((p) => {
        const hp = p.health != null && p.maxHealth ? Math.max(0, Math.min(1, p.health / p.maxHealth)) : null;
        return (
          <div
            key={p.name}
            ref={(el) => {
              if (el) els.current.set(p.name, el);
              else els.current.delete(p.name);
            }}
            className="absolute left-0 top-0 will-change-transform"
            style={{ transform: "translate3d(-999px,-999px,0)" }}
          >
            <button
              type="button"
              onClick={() => onOpen?.(p.name)}
              aria-label={t("map.live.player", { name: p.name })}
              className="pointer-events-auto absolute -left-[22px] -top-[22px] grid h-11 w-11 place-items-center"
            >
              <span aria-hidden className="live-pulse absolute h-7 w-7 rounded-full bg-select/35" />
              <span aria-hidden className="relative grid h-[1.125rem] w-[1.125rem] place-items-center rounded-full border-2 border-[#10161d] bg-[radial-gradient(circle_at_35%_30%,#ffe58a,#f3b867_45%,#c2812f)] shadow-[0_0_10px_rgba(243,184,103,0.75)]" />
            </button>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onOpen?.(p.name)}
              className="material pointer-events-auto absolute left-0 top-3 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-[2px] px-1.5 py-0.5 text-[0.6875rem] font-bold text-bone shadow-[0_2px_8px_rgba(0,0,0,0.6)]"
            >
              <PlatformGlyph platform={p.platform} size={11} className="text-label" />
              {p.name}
              {hp !== null && (
                <span aria-hidden className="ml-0.5 h-1 w-6 overflow-hidden rounded-full bg-black/60">
                  <span className="block h-full bg-hp" style={{ width: `${hp * 100}%` }} />
                </span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
});
