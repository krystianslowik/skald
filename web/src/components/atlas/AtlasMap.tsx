import { useMemo } from "react";
import { useI18n } from "../../i18n";
import { buildMarkers, decodeRLE, DEFAULT_LAYERS } from "../../lib/mapgeo";
import { useWorldMap } from "../../lib/useWorldMap";
import { MapCanvas } from "../map/MapCanvas";

const noop = () => undefined;
const PREVIEW_LAYERS = { ...DEFAULT_LAYERS, storage: false };
/** Below this many explored pixels (about 0.3 km2) the board says the world is young. */
const YOUNG_PIXELS = 2000;
/** The prototype's `?demo=newworld`: only the spawn's surroundings explored. */
const FRESH_RADIUS_M = 280;

/**
 * The Atlas hero's map: the same still MapPreview draws (real MapCanvas, real
 * save), sized by its board instead of a fixed height. One press opens the map.
 */
export default function AtlasMap({ saveKey, onOpen, fresh = false, className = "" }: { saveKey: string; onOpen: () => void; fresh?: boolean; className?: string }) {
  const { t, tn, lookup } = useI18n();
  const [load] = useWorldMap(saveKey);
  const saved = load.status === "ready" ? load.map : null;
  // A fresh world has built nothing yet: no bases, portals, graves or boats.
  const map = useMemo(() => (saved && fresh ? { ...saved, bases: [], portals: [], tombstones: [], beds: [], vehicles: [], pins: [], storage: [] } : saved), [saved, fresh]);
  const markers = useMemo(() => {
    if (!map) return [];
    const all = buildMarkers(map, lookup);
    return fresh ? all.filter((m) => Math.hypot(m.x, m.z) < FRESH_RADIUS_M) : all;
  }, [map, lookup, fresh]);
  const mask = useMemo(() => {
    if (!map?.explored.available) return null;
    const { size, metersPerPixel } = map.explored;
    if (!fresh) return decodeRLE(map.explored.rle, size);
    const out = new Uint8Array(size * size);
    const r = Math.ceil(FRESH_RADIUS_M / metersPerPixel);
    const c = size / 2;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) out[(c + dz) * size + c + dx] = 1;
    return out;
  }, [map, fresh]);
  const young = fresh || (!!map?.explored.available && map.explored.pixels < YOUNG_PIXELS);

  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("map.preview.open")}
        className="press-soft group relative block min-h-0 w-full flex-1 overflow-hidden rounded-[3px] bg-[#16110c] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.6)]"
      >
        {map ? (
          // Keyed: a demo switch is a different world, fitted afresh.
          <MapCanvas key={fresh ? "fresh" : "save"} map={map} mask={mask} markers={markers} layers={PREVIEW_LAYERS} selected={null} onSelect={noop} interactive={false} className="pointer-events-none absolute inset-0" />
        ) : (
          <span className="grid h-full place-items-center px-6 text-sm text-ash">
            {load.status === "loading" ? t("map.loading") : load.status === "off" ? t("map.off") : t("map.notReady")}
          </span>
        )}
        {map && young && <span className="on-world absolute left-3 right-3 top-3 text-left text-xs text-bone">{t("atlas.newWorld")}</span>}
        <span className="plaque absolute bottom-3 right-3 flex min-h-11 items-center gap-2 px-3 text-sm font-bold group-hover:text-flame">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
            <path d="M3 6.5l5.5-2.5 7 2.5 5.5-2.5v13.5l-5.5 2.5-7-2.5-5.5 2.5zM8.5 4v13.5M15.5 6.5v13.5" />
          </svg>
          {t("map.preview.open")}
        </span>
      </button>
      {map && (
        <p className="mt-2 text-xs text-ash">
          {fresh
            ? [tn("map.count.bases", 0), tn("map.count.portals", 0), tn("map.count.graves", 0)].join(", ")
            : [tn("map.count.bases", map.bases.length), tn("map.count.portals", map.portals.length), tn("map.count.graves", map.tombstones.length)].join(", ")}
        </p>
      )}
    </div>
  );
}
