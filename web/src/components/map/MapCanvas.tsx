import { useReducedMotion } from "motion/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useI18n } from "../../i18n";
import {
  backInside,
  clampView,
  exploredBounds,
  fitBounds,
  interestBounds,
  markerBounds,
  MAX_SCALE,
  minScale,
  pastEdge,
  pastLimits,
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
import { bandCentre, bounceGlide, flingOffset, glideStep, glideTarget, inertiaStep, toGlide, REST_SPEED, rubberBand, SampleRing, unbandCentre, unrubberBand, ZOOM_DECELERATION, ZOOM_REST, zoomFlingOffset, type Glide } from "../../lib/mapmotion";
import { MapRenderer, type MapTileStats, type Relief } from "../../lib/maprender";
import type { GLStats } from "../../lib/mapgl";
import type { TilesDoc } from "../../lib/terraintiles";
import { NATURE_CHUNK, NATURE_MIN_SCALE, natureLoader, type NatureItem } from "../../lib/nature";
import { chunksFor } from "../../lib/pieces";
import { Lanes, PieceLoader, type LoaderStats } from "../../lib/pieceload";
import { PLAN_MIN_SCALE, viewBox, type StoreyInfo, type StoreyPick } from "../../lib/planrender";
import type { ApiMap } from "../../types";

/** What window.__mapStats() returns under ?mapstats. */
export interface MapStats {
  view: View;
  ahead: View | null;
  gl: GLStats | null;
  tiles: MapTileStats | null;
  overlays: { plans: LoaderStats; nature: LoaderStats };
}

declare global {
  interface Window {
    __mapStats?: () => MapStats;
  }
}

/** The perf harness hook is asked for in the address (?mapstats). */
export function mapStatsOn(search = globalThis.location?.search ?? ""): boolean {
  return new URLSearchParams(search).has("mapstats");
}

export interface MapCanvasHandle {
  /** Glide (or jump, with reduced motion) to a world point, zooming in to at least `minScale` and out to at most `maxScale`. */
  flyTo(x: number, z: number, minScale?: number, maxScale?: number): void;
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
/** Chunks of floor plans and nature arriving within this time are drawn together. */
const ARRIVAL_MS = 60;
/** Floor plans and nature for a still view are asked for at most this often (a wheel zoom is a run of still views). */
const ASK_MS = 100;
/** A view touching more nature chunks than this gets no ring of them (a wide desktop window zoomed out). */
const NATURE_RING_MAX = 30;

/**
 * Floor plans and nature, kept for the page's life and keyed by the world
 * and its save generation: a map opened again draws what it had at once. They share the
 * request slots, plans first.
 */
const lanes = new Lanes();
const planLoader = new PieceLoader(undefined, undefined, lanes);
const natureLoad = natureLoader(undefined, undefined, lanes);
/** The view is remembered for the browser session (per tab). */
const VIEW_KEY = "skald.map.view";
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The view held within the world (it may stretch a little past the edge), and the centre the finger asked for behind that. */
const edgeBand = (v: View) => bandCentre(v, WORLD_RADIUS);
const edgeUnband = (v: View) => unbandCentre(v, WORLD_RADIUS);

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
    /** The terrain tile pyramid; drawn instead of `relief` when there is one. */
    tiles?: TilesDoc | null;
    /** The storey picked in the floor switcher. */
    storey?: StoreyPick | null;
    /** The base the floor switcher is for, whenever it changes (null: no switcher), and when floor plans arrive. */
    onStoreys?: (info: StoreyInfo | null) => void;
    onSelect: (m: Marker | null) => void;
    /** A tap on a cluster that cannot be zoomed apart any further (marks a metre or two apart). */
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
    /** A tap on an ore deposit (instead of `onSelect`); null when a tap lands anywhere else. */
    onOre?: (ore: NatureItem | null) => void;
    interactive?: boolean;
    className?: string;
  }
>(function MapCanvas({ map, mask, markers, layers, selected, highlighted, relief = null, tiles = null, storey = null, onStoreys, onSelect, onGroup, onAnchor, onPointerWorld, onFrame, onLongPress, onTapWorld, onOre, remember = false, insets = NO_INSETS, interactive = true, className = "relative" }, ref) {
  const { t } = useI18n();
  const reduced = useReducedMotion() ?? false;
  const coarse = useMedia(COARSE);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** The WebGL terrain under the marks (maprender.ts decides whether to use it). */
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const view = useRef<View>({ cx: 0, cz: 0, scale: 0.02, w: 1, h: 1 });
  const fitted = useRef(false);
  const hovered = useRef<string | null>(null);
  const frame = useRef<number | null>(null);
  // Motion in flight: a fling's velocity (px/s), a pinch's zoom momentum (log scale per second, round a screen point) or a spring's target.
  const fling = useRef<{ vx: number; vy: number } | null>(null);
  const zfling = useRef<{ v: number; x: number; y: number } | null>(null);
  const glide = useRef<Glide | null>(null);
  // Where the motion in flight will land (set once the finger lifts): the renderer loads its tiles first.
  const ahead = useRef<View | null>(null);
  // Fingers (or the mouse button) are down on the map.
  const gesturing = useRef(false);
  const last = useRef(0);
  const props = useRef({ markers, layers, selected, highlighted, onAnchor, onFrame, coarse, reduced, remember, storey, onStoreys, interactive, save: `${map.meta.seed}:${map.meta.generation}` });
  props.current = { markers, layers, selected, highlighted, onAnchor, onFrame, coarse, reduced, remember, storey, onStoreys, interactive, save: `${map.meta.seed}:${map.meta.generation}` };
  const reported = useRef<string | null>(null);

  const asked = useRef({ at: -Infinity, key: "" });
  const askTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Floor plans and nature for the view, or for where the motion in flight
   * will land: asked for as soon as the fingers lift, whatever the terrain
   * is still loading or fading, and again whenever that view changes.
   */
  const askOverlays = useCallback(() => {
    const p = props.current;
    if (!p.interactive || gesturing.current) return;
    const v = ahead.current ?? view.current;
    const plans = p.layers.buildings && v.scale >= PLAN_MIN_SCALE;
    const woods = (p.layers.nature || p.layers.resources) && v.scale >= NATURE_MIN_SCALE;
    const key = `${p.save}:${plans ? 1 : 0}${woods ? 1 : 0}:${Math.round(v.cx)},${Math.round(v.cz)},${v.scale.toPrecision(4)},${v.w}x${v.h}`;
    if (key === asked.current.key) return;
    const wait = asked.current.at + ASK_MS - performance.now();
    if (wait > 0) {
      askTimer.current ??= setTimeout(() => {
        askTimer.current = null;
        askOverlays();
      }, wait);
      return;
    }
    asked.current = { at: performance.now(), key };
    // The view and a ring of chunks round it, so a short pan finds them loaded; not for nature on a view so wide the ring would double what it fetches.
    const box = viewBox(v);
    if (plans) planLoader.want(box, p.save, 1);
    else planLoader.drop();
    if (woods) natureLoad.want(box, p.save, chunksFor(box, NATURE_CHUNK).length > NATURE_RING_MAX ? 0 : 1);
    else natureLoad.drop();
  }, []);

  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draw = useCallback((quality: "fast" | "full" = "fast", t0?: number) => {
    const r = renderer.current;
    if (!r) return;
    const p = props.current;
    const v = view.current;
    // Fingers need wider clusters and fewer, larger labels on a small screen.
    const labels = p.coarse ? { max: Math.round(Math.max(8, Math.min(40, (v.w * v.h) / 9000))), px: 13 } : { max: 160, px: 12 };
    const moving = gesturing.current || fling.current !== null || zfling.current !== null || glide.current !== null;
    askOverlays();
    const animating = r.draw(
      { view: v, layers: p.layers, markers: p.markers, selected: p.selected?.id ?? null, highlighted: p.highlighted, hovered: hovered.current, cluster: p.coarse ? 30 : 24, labels, reduced: p.reduced, storey: p.storey, ahead: ahead.current, moving, t0 },
      quality,
    );
    // A mark leaving its cluster keeps the frames coming; through tick, so motion started meanwhile (a fling) is not left waiting.
    if (animating && frame.current === null) frame.current = requestAnimationFrame((now) => tickRef.current(now));
    // Once nothing has moved for a moment, redraw the map itself at full detail.
    if (idle.current) clearTimeout(idle.current);
    if (quality === "fast") idle.current = setTimeout(() => draw("full"), 140);
    else {
      if (p.remember) storeView(v);
      // Settled: the floor switcher's base.
      const info = r.storeys(v, p.layers);
      const key = info ? `${info.base}:${info.storeys}:${info.hasRoof ? 1 : 0}:${info.main}` : "";
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
  }, [askOverlays]);

  const tick = useCallback(
    (now: number) => {
      frame.current = null;
      const gap = last.current ? now - last.current : 16;
      const dt = Math.min(64, gap);
      last.current = now;
      let moving = false;
      // A glide that a fling hands over to in this frame starts with the next one: the fling has moved the map this frame already.
      let handed = false;
      const f = fling.current;
      if (f) {
        // The decay is integrated exactly, so a dropped frame costs no distance: the fling still stops where it was predicted to.
        const fdt = Math.min(250, gap);
        const sx = inertiaStep(f.vx, fdt);
        const sy = inertiaStep(f.vy, fdt);
        const v = view.current;
        const next = { ...v, cx: v.cx - sx.d / v.scale, cz: v.cz + sy.d / v.scale };
        f.vx = sx.v;
        f.vy = sy.v;
        if (pastEdge(next)) {
          // Into the world's edge: it runs on into the band as far as the fling's speed takes it, then springs back.
          fling.current = null;
          view.current = edgeBand(next);
          glide.current = bounceGlide(next, -f.vx / v.scale, f.vy / v.scale, WORLD_RADIUS);
          const back = glideTarget(next, glide.current);
          ahead.current = back;
          handed = true;
        } else {
          view.current = next;
          if (Math.hypot(f.vx, f.vy) < REST_SPEED) fling.current = null;
        }
        moving = fling.current !== null || handed;
      }
      const zf = zfling.current;
      if (zf) {
        const s = inertiaStep(zf.v, dt, ZOOM_DECELERATION);
        const before = view.current.scale;
        view.current = zoomAt(view.current, zf.x, zf.y, Math.exp(s.d));
        zf.v = s.v;
        // At rest, or stopped by a zoom limit.
        if (Math.abs(zf.v) < ZOOM_REST || (s.d !== 0 && view.current.scale === before)) zfling.current = null;
        else moving = true;
      }
      const gl = glide.current;
      if (gl && !handed) {
        // The target is inside the limits; on the way back from past one (a zoom or the edge stretched), the spring is not cut short.
        const g = glideStep(view.current, gl, dt / 1000, WORLD_RADIUS);
        if (g.done) {
          view.current = clampView(g.view);
          glide.current = null;
        } else {
          view.current = g.view;
          moving = true;
        }
      }
      if (!moving) ahead.current = null;
      draw("fast", now);
      // One frame at a time: the draw may have asked for the next one already (a mark leaving its cluster).
      if (moving) frame.current ??= requestAnimationFrame(tick);
      else last.current = 0;
    },
    [draw],
  );

  const tickRef = useRef(tick);
  tickRef.current = tick;

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  }, [tick]);

  const stopMotion = () => {
    fling.current = null;
    zfling.current = null;
    glide.current = null;
    ahead.current = null;
  };

  /** `banded`: the view is already held within the world (edgeBand) and may stretch past its edge. */
  const setView = useCallback(
    (v: View, banded = false) => {
      view.current = banded ? v : clampView(v);
      schedule();
    },
    [schedule],
  );

  /** The explored area; without fog what people built; with nothing yet the whole world. Only worked out when a fit needs it. */
  const bounds = useMemo(() => {
    let box: readonly [number, number, number, number] | null = null;
    return () => (box ??= exploredBounds(mask, map.explored.size, map.explored.metersPerPixel) ?? interestBounds(map) ?? ([-WORLD_RADIUS, -WORLD_RADIUS, WORLD_RADIUS, WORLD_RADIUS] as const));
  }, [map, mask]);
  const fitInsets = useRef(insets);
  fitInsets.current = insets;
  const fitFor = useCallback((w: number, h: number) => fitBounds(w, h, bounds(), fitInsets.current), [bounds]);
  const fit = useCallback(() => fitFor(view.current.w, view.current.h), [fitFor]);

  /** `back`: a spring back to the limits, a little quicker than a move the user asked for. */
  const glideTo = useCallback(
    (target: View, back = false) => {
      fling.current = null;
      zfling.current = null;
      const t = clampView(target);
      if (reduced) {
        glide.current = null;
        setView(t);
        return;
      }
      const prev = glide.current;
      // A new target keeps the current velocity: the move bends, it does not restart.
      glide.current = toGlide(t, prev?.v ?? [0, 0, 0], back);
      ahead.current = t;
      schedule();
    },
    [reduced, schedule, setView],
  );

  useImperativeHandle(
    ref,
    () => ({
      flyTo(x, z, minScale, maxScale) {
        glideTo({ ...view.current, cx: x, cz: z, scale: Math.max(Math.min(view.current.scale, maxScale ?? Infinity), minScale ?? 0) });
      },
      reveal(x, z, hidden) {
        const v = glide.current ? glideTarget(view.current, glide.current) : view.current;
        const [sx, sy] = worldToScreen(v, x, z);
        const clear = v.h - hidden;
        if (sx > 24 && sx < v.w - 24 && sy > 24 && sy < clear - 24) return;
        // Into the middle of what the sheet leaves free.
        glideTo({ ...v, cx: x, cz: z - (v.h / 2 - clear / 2) / v.scale });
      },
      zoomBy(factor) {
        const base = glide.current ? glideTarget(view.current, glide.current) : view.current;
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
    renderer.current ??= new MapRenderer(canvas.current, glCanvas.current);
    renderer.current.onChange = schedule;
    renderer.current.setData(map);
    schedule();
  }, [map, schedule]);

  useEffect(() => {
    renderer.current?.setRelief(relief);
    schedule();
  }, [relief, schedule]);

  useEffect(() => {
    renderer.current?.setTiles(tiles);
    schedule();
    // The tile worker and its bitmaps go with the map.
    return () => renderer.current?.setTiles(null);
  }, [tiles, schedule]);

  // Floor plans and nature: fetched once the fingers lift, close in. Chunks
  // arrive one by one, and each full redraw of the map costs a frame or more
  // on a phone: what arrives within ARRIVAL_MS is drawn together, and in the
  // middle of a move only by the move's own frames.
  const arrival = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arrived = useCallback(() => {
    if (arrival.current) return;
    arrival.current = setTimeout(() => {
      arrival.current = null;
      const r = renderer.current;
      r?.setPieces(planLoader.pieces);
      r?.setNature(natureLoad.loaded);
      if (frame.current === null) draw("full");
    }, ARRIVAL_MS);
  }, [draw]);
  useEffect(() => {
    // The dashboard's still preview draws no floor plans or nature of its own.
    if (!interactive) return;
    const plans = planLoader.subscribe(() => {
      // The switcher's base may have changed with what arrived: ask again on the next settle.
      reported.current = null;
      arrived();
    });
    const woods = natureLoad.subscribe(arrived);
    // Opened again: what was loaded before is drawn at once.
    if (planLoader.loaded.size || natureLoad.loaded.size) arrived();
    return () => {
      plans();
      woods();
    };
  }, [arrived, interactive]);

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

  // ?mapstats: a read-only window.__mapStats() for the map perf harness (#62): the view, a landing in flight and the terrain tiles' coverage. The full map's, never the dashboard preview's.
  useEffect(() => {
    if (!interactive || !mapStatsOn()) return;
    const stats = (): MapStats => {
      const r = renderer.current;
      const a = ahead.current;
      return { view: { ...view.current }, ahead: a ? { ...a } : null, gl: r?.glStats ? { ...r.glStats } : null, tiles: r?.tileStats(view.current) ?? null, overlays: { plans: planLoader.stats(), nature: natureLoad.stats() } };
    };
    window.__mapStats = stats;
    return () => {
      if (window.__mapStats === stats) delete window.__mapStats;
    };
  }, [interactive]);

  // The map is going away (not just its gesture effect re-running).
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (idle.current) clearTimeout(idle.current);
      if (arrival.current) clearTimeout(arrival.current);
      arrival.current = null;
      if (askTimer.current) clearTimeout(askTimer.current);
      askTimer.current = null;
      // What has loaded stays for the next map; nothing more is fetched or retried for this one.
      if (props.current.interactive) {
        planLoader.close();
        natureLoad.close();
      }
      asked.current = { at: -Infinity, key: "" };
      // Woods still being built, or a coast still being traced, must not draw a closed map.
      if (renderer.current) renderer.current.onChange = null;
      renderer.current?.dispose();
    };
  }, []);

  /** Zoom into a cluster until it splits; a pile that never would (a portal hub) opens as a list. */
  const openCluster = useCallback(
    (members: readonly Marker[]) => {
      const v = view.current;
      const [x0, z0, x1, z1] = markerBounds(members);
      // At the closest zoom, clusters are about a metre wide: beyond that, zooming cannot help.
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

  // A touch the map answered as a tap or long press, between its pointerup and its touchend.
  // Kept outside the gesture effect, which re-runs when the answer changes its props.
  const answered = useRef(false);

  // Pointers: one pans, two pinch; a double tap zooms in, a two-finger tap out. Wheel zooms around the cursor.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !interactive) return;
    const pts = new Map<number, { x: number; y: number }>();
    // The pan's recent pointer samples (every coalesced one) for the release velocity.
    const samples = new SampleRing();
    // The canvas box, read once per gesture: no layout read on every move.
    let rect: DOMRect | null = null;
    let moved = false;
    let downAt: { x: number; y: number } | null = null;
    let pinch: { d: number; mx: number; my: number } | null = null;
    // A pinch's zoom as the fingers ask for it (log scale, past the limits too), its recent samples, and how it ended.
    let rawZoom = 0;
    const zoomSamples = new SampleRing(16);
    let pinchEnd: { v: number; x: number; y: number; t: number } | null = null;
    // The last tap on empty map, for a double tap.
    let lastTap: { x: number; y: number; t: number } | null = null;
    // Two fingers down together: when, where, and how far they have wandered.
    let two: { t: number; start: Map<number, { x: number; y: number }>; travel: number; mx: number; my: number } | null = null;
    // A finger resting on one spot: after LONG_PRESS_MS it is a long press, and its release is not a tap.
    let press: ReturnType<typeof setTimeout> | null = null;
    let pressed = false;
    // Where a spring back to the limits that this touch stopped was heading; a tap that does not move picks it up again.
    let caught: View | null = null;
    // The map answered this touch (often by opening a sheet over itself): its touchend cancels the
    // click the browser would send next, which is hit-tested again and would land on that sheet.
    const answer = (e: PointerEvent) => {
      if (e.pointerType === "touch") answered.current = true;
    };
    const touchEnd = (e: TouchEvent) => {
      if (!answered.current || e.touches.length > 0) return;
      answered.current = false;
      if (e.cancelable) e.preventDefault();
    };
    const touchStart = () => {
      answered.current = false;
    };
    const cancelPress = () => {
      if (press) clearTimeout(press);
      press = null;
    };
    const toWorld = (p: { x: number; y: number }) => ((w) => ({ x: Math.round(w[0]), z: Math.round(w[1]) }))(screenToWorld(view.current, p.x, p.y));
    const local = (e: PointerEvent | WheelEvent) => {
      const r = (pts.size > 0 && rect) || el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pinchState = () => {
      const [a, b] = [...pts.values()];
      if (!a || !b) return null;
      return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    /** A zoom stretched past a limit springs back to it, around the fingers' point. */
    const settleZoom = (x: number, y: number) => {
      const t = backInside(view.current, x, y);
      if (t) glideTo(t, true);
    };
    /**
     * The last finger lifted: a view left past a limit (a zoom stretched, the edge, or a spring back
     * the touch stopped) springs back from rest, around (x, y). False when it is inside its limits.
     */
    const springBack = (x: number, y: number) => {
      const c = caught;
      caught = null;
      const t = backInside(view.current, x, y);
      if (!t) return false;
      // Already on its way back (a pinch let go with its zoom past a limit).
      if (glide.current) return true;
      // From rest: no glide is running, so there is no speed to keep.
      glideTo(!moved && c ? c : t, true);
      return true;
    };
    const zoomTo = (x: number, y: number, factor: number) => {
      const base = glide.current ? glideTarget(view.current, glide.current) : view.current;
      glideTo(zoomAt(base, x, y, factor));
    };

    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      el.setPointerCapture(e.pointerId);
      // A touch stops the map where it is, even on its way back from past a limit: it springs back again when the finger lifts.
      const gl = glide.current;
      if (pts.size === 0) caught = gl?.back && pastLimits(view.current) ? glideTarget(view.current, gl) : null;
      stopMotion();
      // Once per finger, not per move: the box is read when a pointer goes down.
      rect = el.getBoundingClientRect();
      const p = local(e);
      pts.set(e.pointerId, p);
      gesturing.current = true;
      samples.clear();
      samples.push(p.x, p.y, e.timeStamp);
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
        // A zoom caught past its limit goes on from the stretch the fingers would have asked for.
        rawZoom = unrubberBand(Math.log(view.current.scale), Math.log(minScale(view.current.w, view.current.h)), Math.log(MAX_SCALE));
        zoomSamples.clear();
        pinchEnd = null;
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
        el.style.cursor = id || (onOre && renderer.current?.oreAt(p.x, p.y, 4)) ? "pointer" : "grab";
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
          // Past a zoom limit the fingers stretch it a little, against a growing pull.
          const v0 = view.current;
          rawZoom += Math.log(now.d / pinch.d);
          const lo = Math.log(minScale(v0.w, v0.h));
          const hi = Math.log(MAX_SCALE);
          const s = Math.exp(reduced ? Math.min(hi, Math.max(lo, rawZoom)) : rubberBand(rawZoom, lo, hi));
          // Scale around the old midpoint, then follow the midpoint's travel; past the world's edge, as a pan does.
          const [wx, wz] = screenToWorld(v0, pinch.mx, pinch.my);
          const u = edgeUnband(v0);
          const next = { ...v0, scale: s, cx: u.cx + wx - (now.mx - v0.w / 2) / s - v0.cx, cz: u.cz + wz + (now.my - v0.h / 2) / s - v0.cz };
          view.current = reduced ? { ...clampView(next), scale: s } : edgeBand(next);
          schedule();
          zoomSamples.push(Math.log(s), 0, e.timeStamp);
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
      const dx = (p.x - prev.x) / v.scale;
      const dz = (p.y - prev.y) / v.scale;
      // A zoom springing back from its limit keeps going under a panning finger.
      const gl = glide.current;
      if (gl) {
        // Kept inside the world: a glide only ever settles on a view clampView allows.
        const t = clampView({ ...v, cx: gl.cx - dx, cz: gl.cz + dz, scale: Math.exp(gl.ls) });
        gl.cx = t.cx;
        gl.cz = t.cz;
      }
      // Past the world's edge the map follows the finger less and less; with reduced motion it just stops there.
      const u = edgeUnband(v);
      const next = { ...v, cx: u.cx - dx, cz: u.cz + dz };
      setView(reduced ? next : edgeBand(next), !reduced);
      // Every sample the browser coalesced into this event, for a steadier release velocity.
      const all = e.getCoalescedEvents?.();
      const r = rect!;
      if (all && all.length > 0) for (const c of all) samples.push(c.clientX - r.left, c.clientY - r.top, c.timeStamp);
      else samples.push(p.x, p.y, e.timeStamp);
      onPointerWorld?.(((w) => ({ x: Math.round(w[0]), z: Math.round(w[1]) }))(screenToWorld(view.current, p.x, p.y)));
    };
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e);
      pts.delete(e.pointerId);
      if (pts.size === 0) {
        gesturing.current = false;
        // A frame once the release is handled: floor plans and nature for where the view lands are asked for there.
        schedule();
      }
      cancelPress();
      if (pressed) {
        // The long press already answered; this release is not a tap.
        if (pts.size === 0) {
          pressed = false;
          if (e.type === "pointerup") answer(e);
          springBack(p.x, p.y);
        }
        el.style.cursor = "grab";
        return;
      }
      if (pts.size === 1) {
        // Back from a pinch to a pan: restart the pan from the remaining finger.
        if (pinch) {
          pinchEnd = { v: zoomSamples.velocity(e.timeStamp)[0], x: pinch.mx, y: pinch.my, t: e.timeStamp };
          settleZoom(pinch.mx, pinch.my);
        }
        pinch = null;
        samples.clear();
        return;
      }
      if (pts.size > 0) return;
      el.style.cursor = "grab";
      if (e.type === "pointercancel") {
        springBack(p.x, p.y);
        return;
      }
      if (two) {
        const t2 = two;
        two = null;
        const end = pinchEnd;
        pinchEnd = null;
        // Two fingers that tapped together without pinching: zoom out around them (back inside the limits, too).
        if (e.timeStamp - t2.t < TWO_TAP_MS && t2.travel < SLOP * 2) {
          caught = null;
          zoomTo(t2.mx, t2.my, 0.5);
          return;
        }
        // The last finger of a pinch panned past the edge, or both lifted with the zoom past a limit.
        if (springBack(p.x, p.y)) return;
        // Both lifted while zooming: the zoom runs on a little, around where the fingers were.
        if (end && !reduced && !glide.current && e.timeStamp - end.t < 150 && Math.abs(end.v) > 0.5) {
          zfling.current = { v: end.v, x: end.x, y: end.y };
          ahead.current = zoomAt(view.current, end.x, end.y, Math.exp(zoomFlingOffset(end.v)));
          schedule();
        }
        return;
      }
      if (!moved) {
        answer(e);
        // A tap that stopped a spring back lets it carry on.
        springBack(p.x, p.y);
        const touch = e.pointerType !== "mouse";
        const hit = renderer.current ? pickItem(renderer.current.visible, p.x, p.y, touch ? 28 : 16) : null;
        if (hit) {
          lastTap = null;
          onOre?.(null);
          if (hit.members && hit.members.length > 1) openCluster(hit.members);
          else onSelect(hit.m);
          return;
        }
        const ore = onOre && renderer.current ? renderer.current.oreAt(p.x, p.y, touch ? 14 : 6) : null;
        if (ore) {
          lastTap = null;
          onSelect(null);
          onOre!(ore);
          return;
        }
        onOre?.(null);
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
      const [vx, vy] = samples.velocity(e.timeStamp);
      const v = view.current;
      if (springBack(p.x, p.y)) return;
      if (!reduced && Math.hypot(vx, vy) > 120) {
        // A spring back still running inside the limits (a pinch let go to a pan) gives way to the fling.
        glide.current = null;
        fling.current = { vx, vy };
        // The fling's landing is known now: its tiles load while it runs.
        const [ox, oy] = flingOffset(vx, vy);
        ahead.current = clampView({ ...v, cx: v.cx - ox / v.scale, cz: v.cz + oy / v.scale });
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
    el.addEventListener("touchstart", touchStart, { passive: true });
    el.addEventListener("touchend", touchEnd, { passive: false });
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelPress();
      el.removeEventListener("contextmenu", context);
      el.removeEventListener("touchstart", touchStart);
      el.removeEventListener("touchend", touchEnd);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("wheel", wheel);
      // The pointers this effect tracked are forgotten with it; a view they left past a limit springs back.
      gesturing.current = false;
      if (pts.size > 0 && !glide.current && !closed.current) {
        const t = backInside(view.current, view.current.w / 2, view.current.h / 2);
        if (t) glideTo(t, true);
      }
    };
  }, [interactive, onPointerWorld, onSelect, onLongPress, onTapWorld, onOre, openCluster, glideTo, reduced, schedule, setView]);

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
      {interactive && <canvas ref={glCanvas} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />}
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
