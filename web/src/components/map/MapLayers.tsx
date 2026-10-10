import { useId, useMemo, useState } from "react";
import { useI18n, type TextKey } from "../../i18n";
import { LAYERS, searchMarkers, type IconId, type LayerId, type Marker } from "../../lib/mapgeo";
import type { ApiMap } from "../../types";
import { markerKind, markerTitle } from "./MapDetails";
import { MapIcon } from "./MapIcon";

/** The mark each layer row shows; the fog and grid get small drawn swatches instead. */
const LAYER_ICON: Partial<Record<LayerId, IconId>> = {
  bases: "base",
  portals: "portal",
  graves: "grave",
  beds: "bed",
  vehicles: "ship",
  pins: "pin-fire",
  locations: "loc-dungeon",
};

function Swatch({ layer }: { layer: LayerId }) {
  if (layer === "fog")
    return (
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="shrink-0">
        <circle cx="11" cy="11" r="10" fill="#e9dfc6" />
        <path d="M4 13c2-3 4-1 6-3s5-2 8 1" stroke="#9c8b6a" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      </svg>
    );
  if (layer === "terrain")
    return (
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="shrink-0">
        <defs>
          <radialGradient id="heat">
            <stop offset="0" stopColor="#c44616" stopOpacity="0.9" />
            <stop offset="1" stopColor="#c44616" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="11" cy="11" r="10" fill="#d9c7a0" />
        <circle cx="11" cy="11" r="9" fill="url(#heat)" />
      </svg>
    );
  if (layer === "grid")
    return (
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="shrink-0">
        <circle cx="11" cy="11" r="10" fill="#d9c7a0" />
        <path d="M7 3v16M15 3v16M3 7h16M3 15h16" stroke="#2b1d12" strokeOpacity="0.45" strokeWidth="1" />
      </svg>
    );
  return <MapIcon icon={LAYER_ICON[layer] ?? "pin-point"} />;
}

const LEGEND: { icon: IconId; key: TextKey }[] = [
  { icon: "loc-start", key: "map.locKind.start" },
  { icon: "loc-boss", key: "map.locKind.boss" },
  { icon: "loc-trader", key: "map.locKind.trader" },
  { icon: "loc-dungeon", key: "map.locKind.dungeon" },
  { icon: "cart", key: "map.vehicle.Cart" },
  { icon: "pin-home", key: "map.pinKind.home" },
  { icon: "pin-hammer", key: "map.pinKind.hammer" },
  { icon: "pin-point", key: "map.pinKind.point" },
  { icon: "pin-cave", key: "map.pinKind.cave" },
  { icon: "pin-boss", key: "map.locKind.boss" },
];

/** Search, layer toggles with counts, the legend and what the map leaves out. */
export function MapLayers({
  map,
  markers,
  layers,
  counts,
  onToggle,
  onPick,
  now,
}: {
  map: ApiMap;
  markers: readonly Marker[];
  layers: Record<LayerId, boolean>;
  counts: Record<LayerId, number>;
  onToggle: (l: LayerId) => void;
  onPick: (m: Marker) => void;
  now: number;
}) {
  const { t, tn, lookup, number, ago } = useI18n();
  const [query, setQuery] = useState("");
  const searchId = useId();
  const results = useMemo(
    () => searchMarkers(markers.filter((m) => layers[m.layer]), query, (m) => `${markerTitle(m, t, lookup)} ${markerKind(m, t, lookup)}`),
    [markers, layers, query, t, lookup],
  );
  return (
    <div className="space-y-5 text-sm">
      <div role="search">
        <label htmlFor={searchId} className="label-caps">
          {t("map.search")}
        </label>
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("map.searchPlaceholder")}
          className="field mt-1.5 w-full px-3 py-2 text-sm"
          autoComplete="off"
        />
        {query.trim() && (
          <ul className="mt-2 space-y-1" aria-live="polite">
            {results.length === 0 && <li className="text-xs text-ash">{t("map.searchEmpty")}</li>}
            {results.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onPick(m)} className="press-soft flex w-full items-center gap-2 rounded-[2px] px-1.5 py-1 text-left hover:bg-black/25">
                  <MapIcon icon={m.icon} size={20} />
                  <span className="min-w-0 flex-1 truncate text-bone">{markerTitle(m, t, lookup)}</span>
                  <span className="shrink-0 text-xs text-ash">{markerKind(m, t, lookup) === markerTitle(m, t, lookup) ? "" : markerKind(m, t, lookup)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="label-caps">{t("map.layers")}</h3>
        <ul className="mt-1.5 space-y-0.5">
          {LAYERS.map((l) => {
            const label = t(`map.layer.${l}` as TextKey);
            const on = layers[l];
            const disabled = l === "fog" && !map.explored.available;
            return (
              <li key={l}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => onToggle(l)}
                  aria-label={t("map.layerToggle", { layer: label, state: on ? t("map.on") : t("map.off.state") })}
                  className={`press-soft flex w-full items-center gap-2.5 rounded-[2px] px-1.5 py-1.5 text-left transition-opacity hover:bg-black/25 disabled:cursor-not-allowed ${on && !disabled ? "" : "opacity-45"}`}
                >
                  <Swatch layer={l} />
                  <span className="flex-1 text-bone">{label}</span>
                  {l !== "grid" && l !== "fog" && <span className="text-xs tabular-nums text-ash">{number(counts[l])}</span>}
                  <span aria-hidden className={`h-3.5 w-6 rounded-full p-[2px] transition-colors ${on && !disabled ? "bg-select" : "bg-black/50"}`}>
                    <span className={`block h-2.5 w-2.5 rounded-full bg-bone transition-transform ${on && !disabled ? "translate-x-2.5" : ""}`} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <h3 className="label-caps">{t("map.legend")}</h3>
        <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-label">
          {LEGEND.map((e) => (
            <li key={e.icon} className="flex items-center gap-1.5">
              <MapIcon icon={e.icon} size={18} />
              <span className="min-w-0 truncate">{t(e.key)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-1.5 border-t border-iron/30 pt-3 text-xs text-ash">
        {!map.explored.available && <p>{t("map.noTable")}</p>}
        <p>{map.spoilers ? t("map.spoilersOn") : tn("map.spoilersOff", map.hiddenLocations)}</p>
        {!map.meta.showNames && <p>{t("map.namesHidden")}</p>}
        <p>{t("map.builtFrom", { gen: map.meta.generation, ago: ago(map.meta.savedAt, now) })}</p>
      </div>
    </div>
  );
}
