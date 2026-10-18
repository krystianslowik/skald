import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { buildMarkers, decodeRLE, DEFAULT_LAYERS, FOCUS_MAX_SCALE, layerCounts, LAYERS, mainBase, markerStores, type Insets, type LayerId, type Marker } from "../../lib/mapgeo";
import type { NatureItem } from "../../lib/nature";
import type { StoreyInfo, StoreyPick } from "../../lib/planrender";
import { COARSE, PHONE, useMedia } from "../../lib/useMedia";
import { useTerrain } from "../../lib/useTerrain";
import { useTerrainTiles } from "../../lib/terraintiles";
import { useWorldMap } from "../../lib/useWorldMap";
import { Sheet, SheetClose } from "../Sheet";
import { useAdmin } from "../admin/AdminContext";
import { LiveLayer, type LiveLayerHandle } from "./LiveLayer";
import { MapCanvas, type MapCanvasHandle } from "./MapCanvas";
import { DetailsBody, DetailsHead, MapDetails, markerTitle } from "./MapDetails";
import { MapLayers } from "./MapLayers";
import { OrePopover } from "./OrePopover";
import { StoreySwitcher } from "./StoreySwitcher";

const LAYERS_KEY = "skald.map.layers";
/** Storeys picked in the floor switcher, by base, for as long as the page lives. */
const chosenStoreys = new Map<string, number>();

/**
 * Containers to pick out on the map (where an item is kept): every one gets a
 * ring, `open` is selected and flown to. A new `key` repeats the move.
 */
export interface MapFocus {
  ids: readonly string[];
  open: string;
  /** What they have in common, for the chip ("Iron: 3 places"). */
  label: string;
  key: number;
}

function storedLayers(): Record<LayerId, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? "null") as Partial<Record<LayerId, boolean>> | null;
    if (raw && typeof raw === "object") {
      const out = { ...DEFAULT_LAYERS };
      for (const l of LAYERS) if (typeof raw[l] === "boolean") out[l] = raw[l]!;
      return out;
    }
  } catch {
    // storage blocked or garbage: defaults
  }
  return { ...DEFAULT_LAYERS };
}

/**
 * The full-screen world map: the save's map on parchment, with the world's
 * terrain under it when there is any. Opened from the header or the
 * dashboard's map board; Escape, the close button or Back closes it. On
 * phones it is the Map tab: it stops above the tab bar and has no back button.
 */
export default function MapView({
  saveKey,
  onClose,
  asTab = false,
  embedded = false,
  focus = null,
  onFocusClear,
}: {
  saveKey: string;
  onClose: () => void;
  asTab?: boolean;
  /** In the page's flow, filling its box: a tab's board, not an overlay (the Atlas prototype). */
  embedded?: boolean;
  focus?: MapFocus | null;
  onFocusClear?: () => void;
}) {
  const { t } = useI18n();
  const [load, retry] = useWorldMap(saveKey);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (embedded) return;
    closeRef.current?.focus({ preventScroll: true });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [embedded]);

  const map = load.status === "ready" ? load.map : null;

  return (
    <motion.div
      role={embedded ? "region" : "dialog"}
      aria-modal={embedded ? undefined : "true"}
      aria-labelledby="worldmap-h"
      className={embedded ? "relative flex h-full flex-col overflow-hidden rounded-[3px] bg-coal" : `fixed inset-x-0 top-0 flex flex-col bg-coal ${asTab ? "z-30 h-[calc(100dvh-var(--tabbar-h))]" : "z-50 h-dvh"}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <header className="plank plank-smooth relative z-20 flex shrink-0 items-center gap-3 rounded-none py-2 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))] sm:gap-5 sm:pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(1.25rem,env(safe-area-inset-right))]">
        <button ref={closeRef} type="button" onClick={onClose} aria-label={t("map.close")} title={t("map.close")} className={`plaque press grid h-9 w-9 shrink-0 place-items-center coarse:h-11 coarse:w-11 ${asTab || embedded ? "hidden" : ""}`}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10 3L5 8l5 5" />
          </svg>
        </button>
        <h2 id="worldmap-h" className="plank-title min-w-0 truncate text-base sm:text-lg">
          {t("map.title")}
        </h2>
      </header>

      <div className="relative min-h-0 flex-1">
        {map ? (
          <SaveMap map={map} stale={load.status === "ready" && load.stale} focus={focus} onFocusClear={onFocusClear} />
        ) : (
          <MapMessage load={load.status} onRetry={retry} />
        )}
      </div>
      {!embedded && <EscapeCloses onClose={onClose} />}
    </motion.div>
  );
}

function EscapeCloses({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An open popover or the layers sheet takes Escape first.
      // Any sheet over the map (layers, details, an admin sheet) takes Escape first.
      if (e.key === "Escape" && !e.defaultPrevented && document.querySelectorAll('[role="dialog"]').length <= 1) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return null;
}

function MapMessage({ load, onRetry }: { load: string; onRetry: () => void }) {
  const { t } = useI18n();
  const text = load === "loading" ? t("map.loading") : load === "off" ? t("map.off") : load === "notReady" ? t("map.notReady") : t("map.failed");
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-sm">
        <p className={load === "loading" ? "text-lg font-bold text-flame" : "text-bone"}>{text}</p>
        {(load === "failed" || load === "notReady") && (
          <button type="button" onClick={onRetry} className="plaque press mt-4 px-4 py-2 text-sm font-bold">
            {t("map.retry")}
          </button>
        )}
      </div>
    </div>
  );
}

/** A mark, or a pile of marks too close to zoom apart, that the details are about; `level` picks a chest of a stack. */
type Selection = { m: Marker; group?: readonly Marker[]; level?: number };

function SaveMap({
  map,
  stale,
  focus,
  onFocusClear,
}: {
  map: import("../../types").ApiMap;
  stale: boolean;
  focus: MapFocus | null;
  onFocusClear?: () => void;
}) {
  const { t, tn, lookup, number } = useI18n();
  const coarse = useMedia(COARSE);
  // Phones get the details as a bottom sheet; wider screens a popover on the mark.
  const phone = useMedia(PHONE);
  const canvas = useRef<MapCanvasHandle>(null);
  const live = useRef<LiveLayerHandle>(null);
  const admin = useAdmin();
  const [layers, setLayers] = useState(storedLayers);
  const [sel, setSel] = useState<Selection | null>(null);
  // A tapped ore deposit, and the box that follows it over the map.
  const [ore, setOre] = useState<NatureItem | null>(null);
  const oreBox = useRef<HTMLDivElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  const coords = useRef<HTMLSpanElement>(null);
  const closeSheet = useRef<(() => void) | null>(null);
  const sheetHeight = useRef(0);
  // The details sheet is on its way out; a new pick meanwhile gets a fresh sheet.
  const leaving = useRef(false);
  const [sheetEpoch, setSheetEpoch] = useState(0);

  const terrain = useTerrain(`${map.meta.seed}:${map.meta.generation}`);
  const relief = terrain.status === "ready" ? terrain.relief : null;
  const tiles = useTerrainTiles(`${map.meta.seed}:${map.meta.generation}`);
  const markers = useMemo(() => buildMarkers(map, lookup), [map, lookup]);
  const mask = useMemo(() => (map.explored.available ? decodeRLE(map.explored.rle, map.explored.size) : null), [map]);
  const counts = useMemo(() => layerCounts(markers, map), [markers, map]);
  const home = useMemo(() => mainBase(markers), [markers]);
  const selected = sel?.m ?? null;
  // Marks of the focused containers, by container id (every chest of a stack is its stack's mark).
  const focusMarks = useMemo(() => {
    if (!focus) return null;
    const want = new Set(focus.ids);
    const byStore = new Map<string, Marker>();
    for (const m of markers) for (const c of markerStores(m)) if (want.has(c.id)) byStore.set(c.id, m);
    return byStore;
  }, [focus, markers]);

  // The floor switcher: the base it is for (from the canvas) and the storey picked there.
  const [storeys, setStoreys] = useState<StoreyInfo | null>(null);
  const [storey, setStorey] = useState<StoreyPick | null>(null);
  // A chest shown from the stores whose storey is known once its floor plan arrives.
  const wantStorey = useRef<{ x: number; z: number; y?: number } | null>(null);
  const settleStorey = useCallback(() => {
    const w = wantStorey.current;
    const st = w ? canvas.current?.storeyAt(w.x, w.z, w.y) : null;
    if (!st) return;
    wantStorey.current = null;
    setStorey(st);
  }, []);
  const onStoreys = useCallback(
    (info: StoreyInfo | null) => {
      setStoreys(info);
      // A base whose storey was picked before opens on that storey again; any other on its main one.
      const kept = info ? chosenStoreys.get(info.base) : undefined;
      if (info && kept !== undefined) setStorey((s) => (s?.base === info.base ? s : { base: info.base, level: kept }));
      settleStorey();
    },
    [settleStorey],
  );
  const highlighted = useMemo(() => (focusMarks ? new Set([...focusMarks.values()].map((m) => m.id)) : undefined), [focusMarks]);

  // Keep the selection when a new save arrives, by id.
  useEffect(() => {
    setSel((s) => {
      if (!s) return null;
      const m = markers.find((x) => x.id === s.m.id);
      if (!m) return null;
      return s.group ? { m, group: s.group.map((g) => markers.find((x) => x.id === g.id)).filter((x): x is Marker => !!x) } : { m, level: s.level };
    });
  }, [markers]);

  const toggle = useCallback((l: LayerId) => {
    setLayers((prev) => {
      const next = { ...prev, [l]: !prev[l] };
      try {
        localStorage.setItem(LAYERS_KEY, JSON.stringify(next));
      } catch {
        // not remembered; fine
      }
      return next;
    });
    setSel((s) => (s && s.m.layer === l ? null : s));
  }, []);

  const choose = useCallback((next: Selection) => {
    if (leaving.current) {
      leaving.current = false;
      setSheetEpoch((e) => e + 1);
    }
    setSel(next);
  }, []);
  const onSheetDismiss = useCallback(() => {
    leaving.current = true;
  }, []);
  const onSheetClosed = useCallback(() => {
    if (!leaving.current) return;
    leaving.current = false;
    setSel(null);
  }, []);

  /** Bring a mark into view: above the sheet on phones, centred on wider screens. */
  const show = useCallback(
    (m: Marker) => {
      if (phone) canvas.current?.reveal(m.x, m.z, sheetHeight.current);
      else canvas.current?.flyTo(m.x, m.z);
    },
    [phone],
  );

  // A focus request (from the village stores): its layers on, the container open, the map on it.
  const focusDone = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || !focusMarks || focusDone.current === focus.key) return;
    focusDone.current = focus.key;
    const target = focusMarks.get(focus.open);
    const need = new Set([...focusMarks.values()].map((m) => m.layer));
    setLayers((prev) => (LAYERS.some((l) => need.has(l) && !prev[l]) ? Object.fromEntries(LAYERS.map((l) => [l, prev[l] || need.has(l)])) as Record<LayerId, boolean> : prev));
    if (!target) return;
    const stores = markerStores(target);
    const level = Math.max(0, stores.findIndex((c) => c.id === focus.open));
    const chest = stores[level];
    choose(stores.length > 1 ? { m: target, level } : { m: target });
    // Its storey: now if the floor plan is here, else when it arrives.
    wantStorey.current = chest ? { x: chest.x, z: chest.z, y: chest.y } : null;
    settleStorey();
    canvas.current?.flyTo(target.x, target.z, 0.9, FOCUS_MAX_SCALE);
  }, [focus, focusMarks, choose, settleStorey]);

  const pickResult = useCallback(
    (m: Marker, level?: number) => {
      setPanelOpen(false);
      choose(level === undefined ? { m } : { m, level });
      const chest = markerStores(m)[level ?? 0];
      if (chest && m.data.type === "storage") {
        wantStorey.current = { x: chest.x, z: chest.z, y: chest.y };
        settleStorey();
      }
      canvas.current?.flyTo(m.x, m.z, 0.35, FOCUS_MAX_SCALE);
    },
    [choose, settleStorey],
  );

  const onSelect = useCallback(
    (m: Marker | null) => {
      if (m) return choose({ m });
      // A tap on empty map lets the sheet slide away the way a swipe would.
      if (phone && closeSheet.current) closeSheet.current();
      else setSel(null);
    },
    [phone, choose],
  );
  const onGroup = useCallback((group: readonly Marker[]) => choose({ m: group[0]!, group }), [choose]);
  const pickFromGroup = useCallback((m: Marker) => choose({ m }), [choose]);

  // The other end of a portal: select it there, so its details follow.
  const goTo = useCallback(
    (x: number, z: number) => {
      const other = markers.find((m) => m.data.type === "portal" && m.x === x && m.z === z);
      if (other) {
        choose({ m: other });
        show(other);
      } else canvas.current?.flyTo(x, z);
    },
    [markers, show, choose],
  );

  // Escape closes the popover before it closes the map (the sheet handles its own).
  useEffect(() => {
    if (!sel || phone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.getElementById("map-layers-h")) {
        e.preventDefault();
        setSel(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [sel, phone]);

  // The popover follows its mark frame by frame without re-rendering React.
  const onAnchor = useCallback((p: { x: number; y: number } | null) => {
    const el = pop.current;
    if (!el) return;
    if (!p) {
      el.style.visibility = "hidden";
      return;
    }
    const parent = el.parentElement;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const W = parent?.clientWidth ?? 0;
    const H = parent?.clientHeight ?? 0;
    // Above the mark when there is room, else below; always inside the map.
    let x = p.x - w / 2;
    let y = p.y - h - 22;
    if (y < 8) y = p.y + 22;
    x = Math.max(8, Math.min(W - w - 8, x));
    y = Math.max(8, Math.min(H - h - 8, y));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.style.visibility = "visible";
  }, []);

  const onPointerWorld = useCallback(
    (p: { x: number; z: number } | null) => {
      if (coords.current) coords.current.textContent = p ? t("map.coords", { x: number(p.x), z: number(p.z) }) : "";
    },
    [t, number],
  );

  const onSheetHeight = useCallback(
    (px: number) => {
      sheetHeight.current = px;
      if (sel) canvas.current?.reveal(sel.m.x, sel.m.z, px);
    },
    [sel],
  );

  // Clear of the controls: the side board on wide screens, the buttons along the bottom.
  // In landscape the buttons sit in the side margins, so the map keeps its full height.
  const [wide] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1024);
  const [landscape] = useState(() => typeof window !== "undefined" && window.innerWidth > window.innerHeight);
  const insets = useMemo<Insets>(
    () => (landscape && !wide ? { top: 12, right: 64, bottom: 12, left: 64 } : { top: 12, right: coarse ? 12 : 64, bottom: coarse ? 72 : 20, left: wide ? 300 : 12 }),
    [coarse, wide, landscape],
  );

  // A tapped deposit's box: above it when there is room, else below; always inside the map.
  const oreAt = useRef(ore);
  oreAt.current = ore;
  const placeOre = useCallback(() => {
    const el = oreBox.current;
    const o = oreAt.current;
    if (!el || !o || !canvas.current) return;
    const [px, py] = canvas.current.project(o.x, o.z);
    const W = el.parentElement?.clientWidth ?? 0;
    const H = el.parentElement?.clientHeight ?? 0;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let y = py - h - 18;
    if (y < 8) y = py + 18;
    const x = Math.max(8, Math.min(W - w - 8, px - w / 2));
    y = Math.max(8, Math.min(H - h - 8, y));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.style.visibility = px < 0 || py < 0 || px > W || py > H ? "hidden" : "visible";
  }, []);
  useEffect(() => {
    placeOre();
    if (!ore) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.getElementById("map-layers-h")) return;
      e.preventDefault();
      setOre(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [ore, placeOre]);
  useEffect(() => {
    if (!layers.resources) setOre(null);
  }, [layers.resources]);

  // Live players follow the view; admin long presses open what can happen at the spot.
  const onFrame = useCallback(() => {
    live.current?.place();
    placeOre();
  }, [placeOre]);
  const pick = admin?.pick ?? null;
  const onLongPress = useMemo(() => {
    if (!admin?.present) return undefined;
    return (p: { x: number; z: number }) => (admin.pick ? admin.completePick(p) : admin.open({ kind: "point", x: p.x, z: p.z }));
  }, [admin]);
  const onTapWorld = useMemo(() => (pick && admin ? (p: { x: number; z: number }) => admin.completePick(p) : undefined), [pick, admin]);
  useEffect(() => {
    if (!pick) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      admin?.cancelPick();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [pick, admin]);
  const openPlayer = useMemo(() => (admin?.present ? (name: string) => admin.open({ kind: "player", name }) : undefined), [admin]);

  const reliefState = tiles ? (tiles.stale ? "stale" : "ready") : terrain.status === "ready" ? (terrain.doc.stale ? "stale" : "ready") : "none";
  const panel = <MapLayers map={map} markers={markers} layers={layers} counts={counts} relief={reliefState} onToggle={toggle} onPick={pickResult} />;
  const bottom = "bottom-[max(0.75rem,env(safe-area-inset-bottom))]";

  return (
    <div className="relative h-full">
      <MapCanvas
        ref={canvas}
        map={map}
        mask={mask}
        markers={markers}
        layers={layers}
        selected={selected}
        highlighted={highlighted}
        relief={tiles ? null : relief}
        tiles={tiles}
        storey={storey}
        onStoreys={onStoreys}
        onSelect={onSelect}
        onGroup={onGroup}
        onAnchor={phone ? undefined : onAnchor}
        onPointerWorld={coarse ? undefined : onPointerWorld}
        onFrame={onFrame}
        onLongPress={onLongPress}
        onTapWorld={onTapWorld}
        onOre={setOre}
        remember
        insets={insets}
        className="absolute inset-0"
      />
      <LiveLayer ref={live} canvas={canvas} onOpen={openPlayer} />
      {ore && (
        <div ref={oreBox} className="pointer-events-none absolute left-0 top-0 z-20 max-w-[min(18rem,calc(100%-1rem))]" style={{ visibility: "hidden" }}>
          <OrePopover ore={ore} onClose={() => setOre(null)} />
        </div>
      )}

      {/* Layers, legend and search: a side board on wide screens, a sheet on phones. */}
      <aside aria-label={t("map.layers")} className="plank plank-smooth scroll-quiet absolute bottom-3 left-3 top-3 z-10 hidden w-70 overflow-y-auto px-4 py-4 lg:block">
        {panel}
      </aside>
      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        className={`plaque press absolute ${bottom} left-[max(0.75rem,env(safe-area-inset-left))] z-10 flex items-center gap-2 px-3 py-2 text-sm font-bold coarse:min-h-11 coarse:px-4 lg:hidden`}
        aria-haspopup="dialog"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
          <path d="M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3" />
        </svg>
        {t("map.layers")}
      </button>
      {panelOpen && (
        <Sheet
          labelledBy="map-layers-h"
          onClose={() => setPanelOpen(false)}
          header={(close) => (
            <div className="flex items-center gap-3 pl-1">
              <h2 id="map-layers-h" className="plank-title flex-1 text-lg">
                {t("map.layers")}
              </h2>
              <SheetClose label={t("map.closeLayers")} escLabel={t("key.esc")} onClose={close} />
            </div>
          )}
        >
          {panel}
        </Sheet>
      )}

      <div className={`absolute ${bottom} right-[max(0.75rem,env(safe-area-inset-right))] z-10 flex flex-col items-end gap-1.5 coarse:gap-2`}>
        {/* The storeys of the base in the frame, above the zoom buttons like a lift's panel. */}
        {storeys && (
          <div className="mb-1.5">
            <StoreySwitcher
              info={storeys}
              level={storey?.base === storeys.base ? storey.level : storeys.main}
              onChange={(level) => {
                chosenStoreys.set(storeys.base, level);
                setStorey({ base: storeys.base, level });
              }}
            />
          </div>
        )}
        {/* A finger pinches and double taps; +/- are for mice and trackpads. */}
        {!coarse && <ZoomButton label={t("map.zoomIn")} onClick={() => canvas.current?.zoomBy(1.8)} d="M8 3v10M3 8h10" />}
        {!coarse && <ZoomButton label={t("map.zoomOut")} onClick={() => canvas.current?.zoomBy(1 / 1.8)} d="M3 8h10" />}
        {home && <ZoomButton label={t("map.mainBase")} onClick={() => canvas.current?.flyTo(home.x, home.z, 0.9)} d="M2.5 8L8 3.5 13.5 8M4 7v6.5h8V7M6.5 13.5v-3h3v3" />}
        <ZoomButton label={t("map.fit")} onClick={() => canvas.current?.fit()} d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
      </div>

      <div className={`pointer-events-none absolute ${bottom} left-1/2 z-10 -translate-x-1/2 lg:left-[calc(50%+9rem)]`}>
        <span ref={coords} aria-hidden className="material rounded-[2px] px-2.5 py-1 font-mono text-xs text-bone empty:hidden" />
      </div>
      <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-col items-center gap-2 lg:left-76 lg:items-start">
        {pick && (
          <div role="status" className="material pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-select-hi/60 py-0.5 pl-4 pr-0.5 text-sm font-bold text-bone shadow-[0_0_18px_rgba(94,151,204,0.45)]">
            <span className="min-w-0 truncate">{pick.label}</span>
            <button type="button" onClick={admin?.cancelPick} className="plaque press min-h-9 rounded-full px-3 text-xs coarse:min-h-11">
              {t("map.pick.cancel")}
            </button>
          </div>
        )}
        {stale && (
          <p role="status" className="material rounded-[2px] px-3 py-1.5 text-xs text-flame">
            {t("map.stale")}
          </p>
        )}
        {focus && focusMarks && focusMarks.size > 0 && (
          <div role="status" className="material pointer-events-auto flex max-w-full items-center gap-1 rounded-full py-0.5 pl-3.5 pr-0.5 text-xs font-bold text-bone coarse:text-sm">
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-[#21465f] bg-select/50" />
            <span className="min-w-0 truncate pl-1">{tn("map.highlight", focusMarks.size, { item: focus.label })}</span>
            {onFocusClear && (
              <button type="button" onClick={onFocusClear} aria-label={t("map.highlightClear")} title={t("map.highlightClear")} className="press grid h-8 w-8 shrink-0 place-items-center rounded-full text-ash hover:text-bone coarse:h-11 coarse:w-11">
                <svg width="11" height="11" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M3 3l10 10M13 3L3 13" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      {phone ? (
        sel && (
          <Sheet
            key={sheetEpoch}
            labelledBy="map-details-h"
            modal={false}
            peek
            closeRef={closeSheet}
            onHeight={onSheetHeight}
            onDismiss={onSheetDismiss}
            onClose={onSheetClosed}
            header={(close) => <DetailsHead marker={sel.m} group={sel.group} onClose={close} headingId="map-details-h" />}
          >
            <DetailsBody marker={sel.m} group={sel.group} onGo={goTo} onPick={pickFromGroup} level={sel.level} roomy />
          </Sheet>
        )
      ) : (
        // The outer box is placed by the canvas each frame; the inner one only fades and scales.
        <div ref={pop} className="pointer-events-none absolute left-0 top-0 z-20" style={{ visibility: "hidden" }}>
          <AnimatePresence>
            {sel && (
              <motion.div
                key={sel.group ? `g:${sel.m.id}` : sel.m.id}
                role="dialog"
                aria-label={sel.group ? tn("map.group.title", sel.group.length) : markerTitle(sel.m, t, lookup)}
                className="plank plank-smooth pointer-events-auto origin-bottom px-4 py-3.5 shadow-[0_10px_30px_rgba(0,0,0,0.55)]"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ type: "spring", bounce: 0, visualDuration: 0.2 }}
              >
                <MapDetails marker={sel.m} group={sel.group} onGo={goTo} onPick={pickFromGroup} level={sel.level} onClose={() => setSel(null)} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function ZoomButton({ label, onClick, d }: { label: string; onClick: () => void; d: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="plaque press grid h-10 w-10 place-items-center coarse:h-11 coarse:w-11">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={d} />
      </svg>
    </button>
  );
}
