import { useReducedMotion } from "motion/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useI18n } from "../../i18n";
import { clampView, fitView, interestBounds, pick, screenToWorld, WORLD_RADIUS, worldToScreen, zoomAt, type LayerId, type Marker, type View } from "../../lib/mapgeo";
import { inertiaStep, releaseVelocity, REST_SPEED, springStep } from "../../lib/mapmotion";
import { MapRenderer } from "../../lib/maprender";
import type { ApiMap } from "../../types";

export interface MapCanvasHandle {
  /** Glide (or jump, with reduced motion) to a world point, zooming in to at least `minScale`. */
  flyTo(x: number, z: number, minScale?: number): void;
  zoomBy(factor: number): void;
  fit(): void;
}

/** Pointer travel before a press becomes a pan, so taps stay taps. */
const SLOP = 5;

/**
 * The interactive map surface: pan with one pointer (1:1, then momentum),
 * zoom with the wheel or a pinch around the fingers, arrow keys and +/-.
 * View changes never re-render React; they schedule one canvas frame.
 */
export const MapCanvas = forwardRef<
  MapCanvasHandle,
  {
    map: ApiMap;
    mask: Uint8Array | null;
    markers: readonly Marker[];
    layers: Record<LayerId, boolean>;
    selected: Marker | null;
    onSelect: (m: Marker | null) => void;
    /** Receives the selected mark's screen position after every frame (null when off screen). */
    onAnchor?: (p: { x: number; y: number } | null) => void;
    /** Shows the world coordinates under the pointer. */
    onPointerWorld?: (p: { x: number; z: number } | null) => void;
    interactive?: boolean;
    className?: string;
  }
>(function MapCanvas({ map, mask, markers, layers, selected, onSelect, onAnchor, onPointerWorld, interactive = true, className = "relative" }, ref) {
  const { t } = useI18n();
  const reduced = useReducedMotion() ?? false;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const view = useRef<View>({ cx: 0, cz: 0, scale: 0.02, w: 1, h: 1 });
  const fitted = useRef(false);
  const hovered = useRef<string | null>(null);
  const frame = useRef<number | null>(null);
  // Motion in flight: a fling's velocity (px/s) or a spring's target.
  const fling = useRef<{ vx: number; vy: number } | null>(null);
  const glide = useRef<{ cx: number; cz: number; ls: number; v: [number, number, number] } | null>(null);
  const last = useRef(0);
  const props = useRef({ markers, layers, selected, onAnchor });
  props.current = { markers, layers, selected, onAnchor };

  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draw = useCallback((quality: "fast" | "full" = "fast") => {
    const r = renderer.current;
    if (!r) return;
    const p = props.current;
    r.draw({ view: view.current, layers: p.layers, markers: p.markers, selected: p.selected?.id ?? null, hovered: hovered.current }, quality);
    // Once nothing has moved for a moment, redraw the map itself at full detail.
    if (idle.current) clearTimeout(idle.current);
    if (quality === "fast") idle.current = setTimeout(() => draw("full"), 140);
    if (p.onAnchor) {
      const sel = p.selected;
      if (!sel) p.onAnchor(null);
      else {
        const [x, y] = worldToScreen(view.current, sel.x, sel.z);
        const v = view.current;
        p.onAnchor(x < 0 || y < 0 || x > v.w || y > v.h ? null : { x, y });
      }
    }
  }, []);

  const tick = useCallback(
    (now: number) => {
      frame.current = null;
      const dt = Math.min(64, last.current ? now - last.current : 16);
      last.current = now;
      let moving = false;
      const f = fling.current;
      if (f) {
        const sx = inertiaStep(f.vx, dt);
        const sy = inertiaStep(f.vy, dt);
        const v = view.current;
        view.current = clampView({ ...v, cx: v.cx - sx.d / v.scale, cz: v.cz + sy.d / v.scale });
        f.vx = sx.v;
        f.vy = sy.v;
        if (Math.hypot(f.vx, f.vy) < REST_SPEED) fling.current = null;
        else moving = true;
      }
      const gl = glide.current;
      if (gl) {
        const v = view.current;
        // Each axis on its own spring; zoom springs in log space so it feels even.
        const sx = springStep(v.cx, gl.v[0], gl.cx, dt / 1000);
        const sz = springStep(v.cz, gl.v[1], gl.cz, dt / 1000);
        const ss = springStep(Math.log(v.scale), gl.v[2], gl.ls, dt / 1000);
        gl.v = [sx.v, sz.v, ss.v];
        view.current = clampView({ ...v, cx: sx.x, cz: sz.x, scale: Math.exp(ss.x) });
        const done = Math.abs(sx.x - gl.cx) * v.scale < 0.3 && Math.abs(sz.x - gl.cz) * v.scale < 0.3 && Math.abs(ss.x - gl.ls) < 0.002;
        if (done) {
          view.current = clampView({ ...view.current, cx: gl.cx, cz: gl.cz, scale: Math.exp(gl.ls) });
          glide.current = null;
        } else moving = true;
      }
      draw();
      if (moving) frame.current = requestAnimationFrame(tick);
      else last.current = 0;
    },
    [draw],
  );

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  }, [tick]);

  const stopMotion = () => {
    fling.current = null;
    glide.current = null;
  };

  const setView = useCallback(
    (v: View) => {
      view.current = clampView(v);
      schedule();
    },
    [schedule],
  );

  /** Everything people made or marked, or the whole world when there is nothing yet. */
  const fitFor = useCallback(
    (w: number, h: number) => {
      const b = interestBounds(map);
      return b ? fitView(w, h, b[0] - 300, b[1] - 300, b[2] + 300, b[3] + 300) : fitView(w, h, -WORLD_RADIUS, -WORLD_RADIUS, WORLD_RADIUS, WORLD_RADIUS, 0);
    },
    [map],
  );
  const fit = useCallback(() => fitFor(view.current.w, view.current.h), [fitFor]);

  const glideTo = useCallback(
    (target: View) => {
      fling.current = null;
      const t = clampView(target);
      if (reduced) {
        glide.current = null;
        setView(t);
        return;
      }
      const prev = glide.current;
      // A new target keeps the current velocity: the move bends, it does not restart.
      glide.current = { cx: t.cx, cz: t.cz, ls: Math.log(t.scale), v: prev?.v ?? [0, 0, 0] };
      schedule();
    },
    [reduced, schedule, setView],
  );

  useImperativeHandle(
    ref,
    () => ({
      flyTo(x, z, minScale) {
        glideTo({ ...view.current, cx: x, cz: z, scale: Math.max(view.current.scale, minScale ?? 0) });
      },
      zoomBy(factor) {
        const base = glide.current ? { ...view.current, cx: glide.current.cx, cz: glide.current.cz, scale: Math.exp(glide.current.ls) } : view.current;
        glideTo({ ...base, scale: base.scale * factor });
      },
      fit() {
        glideTo(fit());
      },
    }),
    [glideTo, fit],
  );

  // Renderer and data.
  useEffect(() => {
    if (!canvas.current) return;
    renderer.current ??= new MapRenderer(canvas.current);
    renderer.current.setData(map, mask);
    schedule();
  }, [map, mask, schedule]);

  // Anything drawn that is not the view.
  useEffect(() => {
    schedule();
  }, [markers, layers, selected, schedule]);

  // Size: follow the box; the first size fits the view to what people made.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const apply = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      renderer.current?.resize(w, h, dpr);
      const v = view.current;
      if (!fitted.current && w > 1 && h > 1) {
        fitted.current = true;
        view.current = fitFor(w, h);
      } else {
        view.current = clampView({ ...v, w, h });
      }
      schedule();
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitFor, schedule]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (idle.current) clearTimeout(idle.current);
    },
    [],
  );

  // Pointers: one pans, two pinch. Wheel zooms around the cursor.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !interactive) return;
    const pts = new Map<number, { x: number; y: number }>();
    let samples: { x: number; y: number; t: number }[] = [];
    let moved = false;
    let downAt: { x: number; y: number } | null = null;
    let pinch: { d: number; mx: number; my: number } | null = null;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pinchState = () => {
      const [a, b] = [...pts.values()];
      if (!a || !b) return null;
      return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };

    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      el.setPointerCapture(e.pointerId);
      // A touch stops the map where it is.
      stopMotion();
      const p = local(e);
      pts.set(e.pointerId, p);
      samples = [{ ...p, t: e.timeStamp }];
      if (pts.size === 1) {
        moved = false;
        downAt = p;
      } else {
        moved = true;
        pinch = pinchState();
      }
    };
    const move = (e: PointerEvent) => {
      const p = local(e);
      if (!pts.has(e.pointerId)) {
        // Hover: coordinates and the mark under the mouse.
        onPointerWorld?.(((w) => ({ x: Math.round(w[0]), z: Math.round(w[1]) }))(screenToWorld(view.current, p.x, p.y)));
        const hit = renderer.current ? pick(renderer.current.visible, p.x, p.y) : null;
        const id = hit?.id ?? null;
        el.style.cursor = id ? "pointer" : "grab";
        if (id !== hovered.current) {
          hovered.current = id;
          schedule();
        }
        return;
      }
      const prev = pts.get(e.pointerId)!;
      pts.set(e.pointerId, p);
      if (pts.size >= 2) {
        const now = pinchState();
        if (now && pinch && pinch.d > 0) {
          // Scale around the old midpoint, then follow the midpoint's travel.
          let v = zoomAt(view.current, pinch.mx, pinch.my, now.d / pinch.d);
          v = clampView({ ...v, cx: v.cx - (now.mx - pinch.mx) / v.scale, cz: v.cz + (now.my - pinch.my) / v.scale });
          setView(v);
        }
        pinch = now;
        return;
      }
      if (!moved && downAt && Math.hypot(p.x - downAt.x, p.y - downAt.y) < SLOP) return;
      if (!moved) {
        moved = true;
        el.style.cursor = "grabbing";
      }
      const v = view.current;
      setView({ ...v, cx: v.cx - (p.x - prev.x) / v.scale, cz: v.cz + (p.y - prev.y) / v.scale });
      samples.push({ ...p, t: e.timeStamp });
      if (samples.length > 12) samples.shift();
      onPointerWorld?.(((w) => ({ x: Math.round(w[0]), z: Math.round(w[1]) }))(screenToWorld(view.current, p.x, p.y)));
    };
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e);
      pts.delete(e.pointerId);
      if (pts.size === 1) {
        // Back from a pinch to a pan: restart the pan from the remaining finger.
        pinch = null;
        samples = [];
        return;
      }
      if (pts.size > 0) return;
      el.style.cursor = "grab";
      if (e.type === "pointercancel") return;
      if (!moved) {
        const hit = renderer.current ? pick(renderer.current.visible, p.x, p.y, e.pointerType === "touch" ? 24 : 16) : null;
        onSelect(hit);
        return;
      }
      const [vx, vy] = releaseVelocity(samples);
      if (!reduced && Math.hypot(vx, vy) > 120) {
        fling.current = { vx, vy };
        schedule();
      }
    };
    const leave = () => {
      onPointerWorld?.(null);
      if (hovered.current) {
        hovered.current = null;
        schedule();
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      stopMotion();
      const p = local(e);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      // Trackpad pinches arrive as ctrl+wheel with small deltas.
      const k = e.ctrlKey ? 0.01 : 0.0018;
      setView(zoomAt(view.current, p.x, p.y, Math.exp(-e.deltaY * unit * k)));
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("wheel", wheel);
    };
  }, [interactive, onPointerWorld, onSelect, reduced, schedule, setView]);

  const onKey = (e: ReactKeyboardEvent) => {
    const v = view.current;
    const step = 90 / v.scale;
    const pan: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (pan[e.key]) {
      e.preventDefault();
      const [dx, dz] = pan[e.key]!;
      glideTo({ ...v, cx: (glide.current?.cx ?? v.cx) + dx, cz: (glide.current?.cz ?? v.cz) + dz });
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      glideTo({ ...v, scale: v.scale * 1.6 });
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      glideTo({ ...v, scale: v.scale / 1.6 });
    } else if (e.key === "0") {
      e.preventDefault();
      glideTo(fit());
    }
  };

  return (
    <div ref={wrap} className={`overflow-hidden ${className}`}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={t("map.canvas")}
        tabIndex={interactive ? 0 : -1}
        onKeyDown={interactive ? onKey : undefined}
        className={`absolute inset-0 h-full w-full ${interactive ? "cursor-grab touch-none select-none" : ""}`}
      />
    </div>
  );
});
