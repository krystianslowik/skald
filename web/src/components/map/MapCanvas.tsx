import { useReducedMotion } from "motion/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useI18n } from "../../i18n";
import {
  clampView,
  exploredBounds,
  fitBounds,
  interestBounds,
  markerBounds,
  MAX_SCALE,
  pickItem,
  screenToWorld,
  WORLD_RADIUS,
  worldToScreen,
  zoomAt,
  type Insets,
  type LayerId,
  type Marker,
  type View,
} from "../../lib/mapgeo";
import { useIconSheet } from "../../lib/itemicons";
import { COARSE, useMedia } from "../../lib/useMedia";
import { inertiaStep, releaseVelocity, REST_SPEED, springStep } from "../../lib/mapmotion";
import { MapRenderer, type Relief } from "../../lib/maprender";
import { PieceLoader } from "../../lib/pieceload";
import { PLAN_MIN_SCALE, viewBox, type StoreyInfo, type StoreyPick } from "../../lib/planrender";
import type { ApiMap } from "../../types";

export interface MapCanvasHandle {
  /** Glide (or jump, with reduced motion) to a world point, zooming in to at least `minScale`. */
  flyTo(x: number, z: number, minScale?: number): void;
  /** Glide just enough to show a world point above the bottom `hidden` px (a sheet), or not at all. */
  reveal(x: number, z: number, hidden: number): void;
  zoomBy(factor: number): void;
  /** The explored area, or what people built, or the whole world. */
  fit(): void;
  /** Screen position (px in the canvas box) of a world point, for overlays. */
  project(x: number, z: number): [number, number];
  /** The base and storey a point (a chest) stands on, once its floor plan has loaded. */
  storeyAt(x: number, z: number, y: number | undefined): StoreyPick | null;
}

/** Pointer travel before a press becomes a pan, so taps stay taps. */
const SLOP = 5;
/** A second tap within this time and distance is a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
/** Two fingers down and up within this time, barely moving, are a two-finger tap. */
const TWO_TAP_MS = 300;
/** A finger held this long without moving is a long press. */
const LONG_PRESS_MS = 520;
/** The view is remembered for the browser session (per tab). */
const VIEW_KEY = "skald.map.view";
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

function storedView(): Pick<View, "cx" | "cz" | "scale"> | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "null") as Partial<View> | null;
    if (v && [v.cx, v.cz, v.scale].every((n) => typeof n === "number" && Number.isFinite(n)) && v.scale! > 0) return { cx: v.cx!, cz: v.cz!, scale: v.scale! };
  } catch {
    // storage blocked or garbage: fit instead
  }
  return null;
}

function storeView(v: View): void {
  try {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify({ cx: Math.round(v.cx), cz: Math.round(v.cz), scale: +v.scale.toFixed(5) }));
  } catch {
    // not remembered; fine
  }
}

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
    /** Mark ids drawn out of their clusters with a ring. */
    highlighted?: ReadonlySet<string>;
    /** The world generator's terrain, drawn under everything when the relief layer is on. */
    relief?: Relief | null;
    /** The storey picked in the floor switcher. */
    storey?: StoreyPick | null;
    /** The base the floor switcher is for, whenever it changes (null: no switcher), and when floor plans arrive. */
    onStoreys?: (info: StoreyInfo | null) => void;
    onSelect: (m: Marker | null) => void;
    /** A tap on a cluster that cannot be zoomed apart any further (marks a few metres apart). */
    onGroup?: (members: readonly Marker[]) => void;
    /** Remember the view for this browser session and start from it next time. */
    remember?: boolean;
    /** Screen space kept clear of the fitted area (controls over the map). */
    insets?: Insets;
    /** Receives the selected mark's screen position after every frame (null when off screen). */
    onAnchor?: (p: { x: number; y: number } | null) => void;
    /** Shows the world coordinates under the pointer. */
    onPointerWorld?: (p: { x: number; z: number } | null) => void;
    /** After every drawn frame: overlays that follow the view reposition here. */
    onFrame?: () => void;
    /** A long press (or a right click) on the map, at a world point. */
    onLongPress?: (p: { x: number; z: number }) => void;
    /** A tap on empty map, at a world point (alongside `onSelect(null)`). */
    onTapWorld?: (p: { x: number; z: number }) => void;
    interactive?: boolean;
    className?: string;
  }
>(function MapCanvas({ map, mask, markers, layers, selected, highlighted, relief = null, storey = null, onStoreys, onSelect, onGroup, onAnchor, onPointerWorld, onFrame, onLongPress, onTapWorld, remember = false, insets = NO_INSETS, interactive = true, className = "relative" }, ref) {
  const { t } = useI18n();
  const reduced = useReducedMotion() ?? false;
  const coarse = useMedia(COARSE);
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
  const props = useRef({ markers, layers, selected, highlighted, onAnchor, onFrame, coarse, reduced, remember, storey, onStoreys, generation: map.meta.generation });
  props.current = { markers, layers, selected, highlighted, onAnchor, onFrame, coarse, reduced, remember, storey, onStoreys, generation: map.meta.generation };
  const loader = useRef<PieceLoader | null>(null);
  const reported = useRef<string | null>(null);

  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draw = useCallback((quality: "fast" | "full" = "fast") => {
    const r = renderer.current;
    if (!r) return;
    const p = props.current;
    const v = view.current;
    // Fingers need wider clusters and fewer, larger labels on a small screen.
    const labels = p.coarse ? { max: Math.round(Math.max(8, Math.min(40, (v.w * v.h) / 9000))), px: 13 } : { max: 160, px: 12 };
    const animating = r.draw(
      { view: v, layers: p.layers, markers: p.markers, selected: p.selected?.id ?? null, highlighted: p.highlighted, hovered: hovered.current, cluster: p.coarse ? 30 : 24, labels, reduced: p.reduced, storey: p.storey },
      quality,
    );
    // A mark leaving its cluster keeps the frames coming.
    if (animating && frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      draw();
    });
    // Once nothing has moved for a moment, redraw the map itself at full detail.
    if (idle.current) clearTimeout(idle.current);
    if (quality === "fast") idle.current = setTimeout(() => draw("full"), 140);
    else {
      if (p.remember) storeView(v);
      // Settled: floor plans for what the cached map covers, and the floor switcher's base.
      if (p.layers.buildings && v.scale >= PLAN_MIN_SCALE) loader.current?.want(viewBox({ ...v, w: v.w * 1.5, h: v.h * 1.5 }, 8), String(p.generation));
      const info = r.storeys(v, p.layers);
      const key = info ? `${info.base}:${info.storeys}:${info.hasRoof ? 1 : 0}` : "";
      if (key !== reported.current) {
        reported.current = key;
        p.onStoreys?.(info);
      }
    }
    if (p.onAnchor) {
      const sel = p.selected;
      if (!sel) p.onAnchor(null);
      else {
        const [x, y] = worldToScreen(view.current, sel.x, sel.z);
        const v = view.current;
        p.onAnchor(x < 0 || y < 0 || x > v.w || y > v.h ? null : { x, y });
      }
    }
    p.onFrame?.();
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

  /** The explored area; without fog what people built; with nothing yet the whole world. */
  const bounds = useMemo(
    () => exploredBounds(mask, map.explored.size, map.explored.metersPerPixel) ?? interestBounds(map) ?? ([-WORLD_RADIUS, -WORLD_RADIUS, WORLD_RADIUS, WORLD_RADIUS] as const),
    [map, mask],
  );
  const fitInsets = useRef(insets);
  fitInsets.current = insets;
  const fitFor = useCallback((w: number, h: number) => fitBounds(w, h, bounds, fitInsets.current), [bounds]);
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
      reveal(x, z, hidden) {
        const v = glide.current ? { ...view.current, cx: glide.current.cx, cz: glide.current.cz, scale: Math.exp(glide.current.ls) } : view.current;
        const [sx, sy] = worldToScreen(v, x, z);
        const clear = v.h - hidden;
        if (sx > 24 && sx < v.w - 24 && sy > 24 && sy < clear - 24) return;
        // Into the middle of what the sheet leaves free.
        glideTo({ ...v, cx: x, cz: z - (v.h / 2 - clear / 2) / v.scale });
      },
      zoomBy(factor) {
        const base = glide.current ? { ...view.current, cx: glide.current.cx, cz: glide.current.cz, scale: Math.exp(glide.current.ls) } : view.current;
        glideTo({ ...base, scale: base.scale * factor });
      },
      fit() {
        glideTo(fit());
      },
      project(x, z) {
        return worldToScreen(view.current, x, z);
      },
      storeyAt(x, z, y) {
        return renderer.current?.storeyAt(x, z, y) ?? null;
      },
    }),
    [glideTo, fit],
  );

  // Renderer and data.
  useEffect(() => {
    if (!canvas.current) return;
    renderer.current ??= new MapRenderer(canvas.current);
    renderer.current.onChange = schedule;
    renderer.current.setData(map, mask);
    schedule();
  }, [map, mask, schedule]);

  useEffect(() => {
    renderer.current?.setRelief(relief);
    schedule();
  }, [relief, schedule]);

  // Floor plans: fetched as the view settles close in, drawn as they arrive.
  useEffect(() => {
    const l = (loader.current ??= new PieceLoader());
    l.onChange = () => {
      renderer.current?.setPieces(l.pieces);
      // The switcher's base may have changed with what arrived: ask again on the next settle.
      reported.current = null;
      draw("full");
    };
    return () => {
      l.onChange = null;
    };
  }, [draw]);

  // Item icons for the contents strips under containers, once the sheet has decoded.
  const iconSheet = useIconSheet();
  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    if (!iconSheet || typeof Image === "undefined") {
      r.setIcons(null);
      schedule();
      return;
    }
    let live = true;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (!live) return;
      r.setIcons({ img, sheet: iconSheet });
      schedule();
    };
    img.src = iconSheet.url;
    return () => {
      live = false;
    };
  }, [iconSheet, schedule]);

  // Anything drawn that is not the view.
  useEffect(() => {
    schedule();
  }, [markers, layers, selected, highlighted, storey, schedule]);

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
        const kept = props.current.remember ? storedView() : null;
        view.current = kept ? clampView({ ...kept, w, h }) : fitFor(w, h);
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

  /** Zoom into a cluster until it splits; a pile that never would (a portal hub) opens as a list. */
  const openCluster = useCallback(
    (members: readonly Marker[]) => {
      const v = view.current;
      const [x0, z0, x1, z1] = markerBounds(members);
      // At the closest zoom, clusters are a few metres wide: beyond that, zooming cannot help.
      const apartAtMax = Math.hypot(x1 - x0, z1 - z0) * MAX_SCALE > 40;
      if (!apartAtMax || v.scale >= MAX_SCALE * 0.95) {
        onGroup?.(members);
        return;
      }
      const fitted = fitBounds(v.w, v.h, [x0, z0, x1, z1], fitInsets.current, 0.35);
      // Far enough to split it (2x to 4x), not so far that the neighbourhood is lost.
      const scale = Math.min(MAX_SCALE, v.scale * 4, Math.max(v.scale * 2, fitted.scale));
      glideTo({ ...v, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, scale });
    },
    [glideTo, onGroup],
  );

  // Pointers: one pans, two pinch; a double tap zooms in, a two-finger tap out. Wheel zooms around the cursor.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !interactive) return;
    const pts = new Map<number, { x: number; y: number }>();
    let samples: { x: number; y: number; t: number }[] = [];
    let moved = false;
    let downAt: { x: number; y: number } | null = null;
    let pinch: { d: number; mx: number; my: number } | null = null;
    // The last tap on empty map, for a double tap.
    let lastTap: { x: number; y: number; t: number } | null = null;
    // Two fingers down together: when, where, and how far they have wandered.
    let two: { t: number; start: Map<number, { x: number; y: number }>; travel: number; mx: number; my: number } | null = null;
    // A finger resting on one spot: after LONG_PRESS_MS it is a long press, and its release is not a tap.
    let press: ReturnType<typeof setTimeout> | null = null;
    let pressed = false;
    const cancelPress = () => {
      if (press) clearTimeout(press);
      press = null;
    };
    const toWorld = (p: { x: number; y: number }) => ((w) => ({ x: Math.round(w[0]), z: Math.round(w[1]) }))(screenToWorld(view.current, p.x, p.y));
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pinchState = () => {
      const [a, b] = [...pts.values()];
      if (!a || !b) return null;
      return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    const zoomTo = (x: number, y: number, factor: number) => {
      const base = glide.current ? { ...view.current, cx: glide.current.cx, cz: glide.current.cz, scale: Math.exp(glide.current.ls) } : view.current;
      glideTo(zoomAt(base, x, y, factor));
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
        two = null;
        pressed = false;
        cancelPress();
        if (onLongPress) {
          press = setTimeout(() => {
            press = null;
            if (moved || pts.size !== 1) return;
            pressed = true;
            navigator.vibrate?.(12);
            onLongPress(toWorld(p));
          }, LONG_PRESS_MS);
        }
      } else {
        cancelPress();
        moved = true;
        pinch = pinchState();
        if (pts.size === 2 && pinch) two = { t: e.timeStamp, start: new Map(pts), travel: 0, mx: pinch.mx, my: pinch.my };
        else two = null;
      }
    };
    const move = (e: PointerEvent) => {
      const p = local(e);
      if (!pts.has(e.pointerId)) {
        // Hover: coordinates and the mark under the mouse.
        onPointerWorld?.(((w) => ({ x: Math.round(w[0]), z: Math.round(w[1]) }))(screenToWorld(view.current, p.x, p.y)));
        const hit = renderer.current ? pickItem(renderer.current.visible, p.x, p.y) : null;
        const id = hit?.m.id ?? null;
        el.style.cursor = id ? "pointer" : "grab";
        if (id !== hovered.current) {
          hovered.current = id;
          schedule();
        }
        return;
      }
      const prev = pts.get(e.pointerId)!;
      pts.set(e.pointerId, p);
      if (two) {
        const s0 = two.start.get(e.pointerId);
        if (s0) two.travel = Math.max(two.travel, Math.hypot(p.x - s0.x, p.y - s0.y));
      }
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
      cancelPress();
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
      cancelPress();
      if (pressed) {
        // The long press already answered; this release is not a tap.
        if (pts.size === 0) pressed = false;
        el.style.cursor = "grab";
        return;
      }
      if (pts.size === 1) {
        // Back from a pinch to a pan: restart the pan from the remaining finger.
        pinch = null;
        samples = [];
        return;
      }
      if (pts.size > 0) return;
      el.style.cursor = "grab";
      if (e.type === "pointercancel") return;
      if (two) {
        const t2 = two;
        two = null;
        // Two fingers that tapped together without pinching: zoom out around them.
        if (e.timeStamp - t2.t < TWO_TAP_MS && t2.travel < SLOP * 2) zoomTo(t2.mx, t2.my, 0.5);
        return;
      }
      if (!moved) {
        const touch = e.pointerType !== "mouse";
        const hit = renderer.current ? pickItem(renderer.current.visible, p.x, p.y, touch ? 28 : 16) : null;
        if (hit) {
          lastTap = null;
          if (hit.members && hit.members.length > 1) openCluster(hit.members);
          else onSelect(hit.m);
          return;
        }
        // Empty map: a second tap close by zooms in; the first one only clears the selection.
        if (lastTap && e.timeStamp - lastTap.t < DOUBLE_TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < DOUBLE_TAP_PX) {
          lastTap = null;
          zoomTo(p.x, p.y, 2);
          return;
        }
        lastTap = { ...p, t: e.timeStamp };
        onSelect(null);
        onTapWorld?.(toWorld(p));
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
    const context = (e: MouseEvent) => {
      if (!onLongPress) return;
      e.preventDefault();
      onLongPress(toWorld(local(e as PointerEvent)));
    };
    el.addEventListener("contextmenu", context);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelPress();
      el.removeEventListener("contextmenu", context);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("wheel", wheel);
    };
  }, [interactive, onPointerWorld, onSelect, onLongPress, onTapWorld, openCluster, glideTo, reduced, schedule, setView]);

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
