import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { buildMarkers, decodeRLE, DEFAULT_LAYERS, layerCounts, LAYERS, mainBase, type Insets, type LayerId, type Marker } from "../../lib/mapgeo";
import { COARSE, PHONE, useMedia } from "../../lib/useMedia";
import { useWorldMap } from "../../lib/useWorldMap";
import { terrainUrl } from "../../lib/world";
import { Sheet, SheetClose } from "../Sheet";
import { MapCanvas, type MapCanvasHandle } from "./MapCanvas";
import { DetailsBody, DetailsHead, MapDetails, markerTitle } from "./MapDetails";
import { MapLayers } from "./MapLayers";

const LAYERS_KEY = "skald.map.layers";

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
 * The full-screen world map: the save's map on parchment (Map) or the seed's
 * terrain from valheim-map.world (Terrain). Opened from the header or the
 * dashboard's map board; Escape, the close button or Back closes it. On
 * phones it is the Map tab: it stops above the tab bar and has no back button.
 */
export default function MapView({ seedName, saveKey, now, onClose, asTab = false }: { seedName: string; saveKey: string; now: number; onClose: () => void; asTab?: boolean }) {
  const { t } = useI18n();
  const [load, retry] = useWorldMap(saveKey);
  const [tab, setTab] = useState<"map" | "terrain">("map");
  const [terrainSeen, setTerrainSeen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  const map = load.status === "ready" ? load.map : null;
  const seed = map?.meta.seedName || seedName;

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="worldmap-h"
      className={`fixed inset-x-0 top-0 flex flex-col bg-coal ${asTab ? "z-30 h-[calc(100dvh-var(--tabbar-h))]" : "z-50 h-[100dvh]"}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <header className="plank plank-smooth relative z-20 flex shrink-0 items-center gap-3 rounded-none py-2 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))] sm:gap-5 sm:pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(1.25rem,env(safe-area-inset-right))]">
        <button ref={closeRef} type="button" onClick={onClose} aria-label={t("map.close")} title={t("map.close")} className={`plaque press grid h-9 w-9 shrink-0 place-items-center coarse:h-11 coarse:w-11 ${asTab ? "hidden" : ""}`}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10 3L5 8l5 5" />
          </svg>
        </button>
        <h2 id="worldmap-h" className="plank-title min-w-0 truncate text-base sm:text-lg">
          {t("map.title")}
        </h2>
        <div role="tablist" aria-label={t("map.tabs")} className="ml-auto flex shrink-0 gap-1.5">
          {(["map", "terrain"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls={`map-panel-${id}`}
              onClick={() => {
                setTab(id);
                if (id === "terrain") setTerrainSeen(true);
              }}
              className="plaque press px-3 py-1.5 text-xs font-bold coarse:min-h-11 coarse:px-4 coarse:text-sm sm:text-sm"
            >
              {t(id === "map" ? "map.tab.map" : "map.tab.terrain")}
            </button>
          ))}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div id="map-panel-map" role="tabpanel" hidden={tab !== "map"} className="absolute inset-0">
          {map ? (
            <SaveMap map={map} stale={load.status === "ready" && load.stale} seed={seed} now={now} />
          ) : (
            <MapMessage load={load.status} onRetry={retry} />
          )}
        </div>
        {/* The third-party page loads only once someone opens this tab. */}
        {terrainSeen && (
          <div id="map-panel-terrain" role="tabpanel" hidden={tab !== "terrain"} className="absolute inset-0">
            <TerrainFrame seedName={seed} />
          </div>
        )}
      </div>
      <EscapeCloses onClose={onClose} />
    </motion.div>
  );
}

function EscapeCloses({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An open popover or the layers sheet takes Escape first.
      if (e.key === "Escape" && !e.defaultPrevented && !document.getElementById("map-layers-h") && !document.getElementById("map-details-h")) onClose();
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

/** A mark, or a pile of marks too close to zoom apart, that the details are about. */
type Selection = { m: Marker; group?: readonly Marker[] };

function SaveMap({ map, stale, seed, now }: { map: import("../../types").ApiMap; stale: boolean; seed: string; now: number }) {
  const { t, tn, lookup, number } = useI18n();
  const coarse = useMedia(COARSE);
  // Phones get the details as a bottom sheet; wider screens a popover on the mark.
  const phone = useMedia(PHONE);
  const canvas = useRef<MapCanvasHandle>(null);
  const [layers, setLayers] = useState(storedLayers);
  const [sel, setSel] = useState<Selection | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  const coords = useRef<HTMLSpanElement>(null);
  const closeSheet = useRef<(() => void) | null>(null);
  const sheetHeight = useRef(0);
  // The details sheet is on its way out; a new pick meanwhile gets a fresh sheet.
  const leaving = useRef(false);
  const [sheetEpoch, setSheetEpoch] = useState(0);

  const markers = useMemo(() => buildMarkers(map, lookup), [map, lookup]);
  const mask = useMemo(() => (map.explored.available ? decodeRLE(map.explored.rle, map.explored.size) : null), [map]);
  const counts = useMemo(() => layerCounts(markers, map), [markers, map]);
  const home = useMemo(() => mainBase(markers), [markers]);
  const selected = sel?.m ?? null;

  // Keep the selection when a new save arrives, by id.
  useEffect(() => {
    setSel((s) => {
      if (!s) return null;
      const m = markers.find((x) => x.id === s.m.id);
      if (!m) return null;
      return s.group ? { m, group: s.group.map((g) => markers.find((x) => x.id === g.id)).filter((x): x is Marker => !!x) } : { m };
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

  const pickResult = useCallback(
    (m: Marker) => {
      setPanelOpen(false);
      choose({ m });
      canvas.current?.flyTo(m.x, m.z, 0.35);
    },
    [choose],
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
  const [wide] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1024);
  const insets = useMemo<Insets>(() => ({ top: 12, right: coarse ? 12 : 64, bottom: coarse ? 72 : 20, left: wide ? 300 : 12 }), [coarse, wide]);

  const panel = <MapLayers map={map} markers={markers} layers={layers} counts={counts} onToggle={toggle} onPick={pickResult} now={now} />;
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
        onSelect={onSelect}
        onGroup={onGroup}
        onAnchor={phone ? undefined : onAnchor}
        onPointerWorld={coarse ? undefined : onPointerWorld}
        remember
        insets={insets}
        className="absolute inset-0"
      />

      {/* Layers, legend and search: a side board on wide screens, a sheet on phones. */}
      <aside aria-label={t("map.layers")} className="plank plank-smooth scroll-quiet absolute bottom-3 left-3 top-3 z-10 hidden w-[17.5rem] overflow-y-auto px-4 py-4 lg:block">
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
              <SheetClose label={t("map.close")} escLabel={t("key.esc")} onClose={close} />
            </div>
          )}
        >
          {panel}
        </Sheet>
      )}

      <div className={`absolute ${bottom} right-[max(0.75rem,env(safe-area-inset-right))] z-10 flex flex-col gap-1.5 coarse:gap-2`}>
        {/* A finger pinches and double taps; +/- are for mice and trackpads. */}
        {!coarse && <ZoomButton label={t("map.zoomIn")} onClick={() => canvas.current?.zoomBy(1.8)} d="M8 3v10M3 8h10" />}
        {!coarse && <ZoomButton label={t("map.zoomOut")} onClick={() => canvas.current?.zoomBy(1 / 1.8)} d="M3 8h10" />}
        {home && <ZoomButton label={t("map.mainBase")} onClick={() => canvas.current?.flyTo(home.x, home.z, 0.9)} d="M2.5 8L8 3.5 13.5 8M4 7v6.5h8V7M6.5 13.5v-3h3v3" />}
        <ZoomButton label={t("map.fit")} onClick={() => canvas.current?.fit()} d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
      </div>

      <div className={`pointer-events-none absolute ${bottom} left-1/2 z-10 -translate-x-1/2 lg:left-[calc(50%+9rem)]`}>
        <span ref={coords} aria-hidden className="material rounded-[2px] px-2.5 py-1 font-mono text-xs text-bone empty:hidden" />
      </div>
      {stale && (
        <p role="status" className="material absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-[2px] px-3 py-1.5 text-xs text-flame">
          {t("map.stale")}
        </p>
      )}

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
            <DetailsBody marker={sel.m} group={sel.group} seedName={seed} onGo={goTo} onPick={pickFromGroup} roomy />
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
                <MapDetails marker={sel.m} group={sel.group} seedName={seed} onGo={goTo} onPick={pickFromGroup} onClose={() => setSel(null)} />
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

/**
 * valheim-map.world's own page for the seed, embedded. The site sends no
 * X-Frame-Options or frame-ancestors today, but that can change, and a
 * cross-origin frame cannot be inspected: the link to open it in a new tab is
 * always there, and a note appears if the frame has not loaded after a while.
 */
export function TerrainFrame({ seedName }: { seedName: string }) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 20_000);
    return () => clearTimeout(timer);
  }, []);
  if (!seedName) return <p className="p-6 text-center text-bone">{t("map.terrain.noSeed")}</p>;
  const url = terrainUrl(seedName);
  return (
    <div className="flex h-full flex-col">
      <div className="material z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs">
        <span className="font-bold text-flame">{t("map.terrain.attribution")}</span>
        <span className="min-w-0 flex-1 text-ash">{t("map.terrain.note")}</span>
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-bold text-flame underline decoration-flame/40 underline-offset-4 hover:text-gold">
          {t("map.terrain.openNew")}
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
            <path d="M4 2h6v6M10 2L3 9" />
          </svg>
        </a>
      </div>
      {slow && !loaded && <p className="bg-black/40 px-4 py-2 text-xs text-bone">{t("map.terrain.slow")}</p>}
      <iframe
        src={url}
        title={t("map.terrain.attribution")}
        className="min-h-0 w-full flex-1 border-0 bg-black"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}
