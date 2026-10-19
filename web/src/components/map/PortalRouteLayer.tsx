import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, type RefObject } from "react";
import type { Route } from "../../lib/portalnet";
import type { MapCanvasHandle } from "./MapCanvas";

export interface PortalRouteLayerHandle {
  /** Redraw the route where the current view shows it. */
  place(): void;
}

/**
 * The route finder's route over the map, as an SVG over the canvas (so both
 * the WebGL and the 2D map show it): walking legs as a dashed amber line,
 * portal hops as a thin blue dotted line, a ring at the start and a dot at
 * the end. The map calls `place` every frame it draws.
 */
export const PortalRouteLayer = forwardRef<PortalRouteLayerHandle, { canvas: RefObject<MapCanvasHandle | null>; route: Route | null }>(function PortalRouteLayer({ canvas, route }, ref) {
  const walk = useRef<SVGPathElement>(null);
  const shadow = useRef<SVGPathElement>(null);
  const hop = useRef<SVGPathElement>(null);
  const start = useRef<SVGCircleElement>(null);
  const end = useRef<SVGCircleElement>(null);
  const current = useRef(route);
  current.current = route;

  const place = useCallback(() => {
    const c = canvas.current;
    const r = current.current;
    if (!c || !r || !walk.current || !hop.current || !start.current || !end.current) return;
    const at = (p: { x: number; z: number }) => c.project(p.x, p.z).map((v) => Math.round(v * 10) / 10).join(" ");
    let w = "";
    let h = "";
    for (const leg of r.legs) {
      const seg = `M${at(leg.from)}L${at(leg.to)}`;
      if (leg.kind === "walk") w += seg;
      else h += seg;
    }
    walk.current.setAttribute("d", w);
    shadow.current?.setAttribute("d", w);
    hop.current.setAttribute("d", h);
    const first = r.legs[0]!.from;
    const last = r.legs[r.legs.length - 1]!.to;
    const [sx, sy] = c.project(first.x, first.z);
    const [ex, ey] = c.project(last.x, last.z);
    start.current.setAttribute("cx", String(sx));
    start.current.setAttribute("cy", String(sy));
    end.current.setAttribute("cx", String(ex));
    end.current.setAttribute("cy", String(ey));
  }, [canvas]);

  useImperativeHandle(ref, () => ({ place }), [place]);
  // A new route draws at once, not only on the next map frame.
  useLayoutEffect(() => place(), [route, place]);

  if (!route || route.legs.length === 0) return null;
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 z-5 h-full w-full overflow-hidden">
      <path ref={hop} fill="none" stroke="#5e97cc" strokeOpacity="0.9" strokeWidth="2" strokeDasharray="1 6" strokeLinecap="round" />
      <path ref={shadow} fill="none" stroke="#10161d" strokeOpacity="0.55" strokeWidth="6" strokeLinecap="round" />
      <path ref={walk} fill="none" stroke="#f3b867" strokeWidth="3" strokeDasharray="10 7" strokeLinecap="round" />
      <circle ref={start} r="7" fill="#10161d" fillOpacity="0.4" stroke="#f3b867" strokeWidth="3" />
      <circle ref={end} r="6" fill="#f3b867" stroke="#10161d" strokeWidth="2" />
    </svg>
  );
});
