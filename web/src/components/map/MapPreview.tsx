import { useMemo } from "react";
import { useI18n } from "../../i18n";
import { buildMarkers, decodeRLE, DEFAULT_LAYERS } from "../../lib/mapgeo";
import { useWorldMap } from "../../lib/useWorldMap";
import { MapCanvas } from "./MapCanvas";

const noop = () => undefined;
/** The still shows what matters at a glance: no chests. */
const PREVIEW_LAYERS = { ...DEFAULT_LAYERS, storage: false };

/** The dashboard's map board: a still of the explored world that opens the full map. */
export default function MapPreview({ saveKey, onOpen }: { saveKey: string; onOpen: () => void }) {
  const { t, tn, lookup } = useI18n();
  const [load] = useWorldMap(saveKey);
  const map = load.status === "ready" ? load.map : null;
  const markers = useMemo(() => (map ? buildMarkers(map, lookup) : []), [map, lookup]);
  const mask = useMemo(() => (map?.explored.available ? decodeRLE(map.explored.rle, map.explored.size) : null), [map]);

  return (
    <div>
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("map.preview.open")}
        className="press-soft group relative block h-56 w-full overflow-hidden rounded-[3px] bg-[#16110c] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.6)] sm:h-64"
      >
        {map ? (
          <MapCanvas map={map} mask={mask} markers={markers} layers={PREVIEW_LAYERS} selected={null} onSelect={noop} interactive={false} className="pointer-events-none absolute inset-0" />
        ) : (
          <span className="grid h-full place-items-center px-6 text-sm text-ash">
            {load.status === "loading" ? t("map.loading") : load.status === "off" ? t("map.off") : t("map.notReady")}
          </span>
        )}
        <span className="plaque absolute bottom-3 right-3 px-3 py-1.5 text-xs font-bold group-hover:text-flame">{t("map.preview.open")}</span>
      </button>
      {map && (
        <p className="mt-2.5 text-xs text-ash">
          {[tn("map.count.bases", map.bases.length), tn("map.count.portals", map.portals.length), tn("map.count.graves", map.tombstones.length)].join(", ")}
        </p>
      )}
    </div>
  );
}
