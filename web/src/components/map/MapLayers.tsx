import { useId, useMemo, useState, type ReactNode } from "react";
import { useEveryLocale, useI18n, type TextKey } from "../../i18n";
import { LAYERS, markerItems, markerStores, searchMarkers, type IconId, type LayerId, type Marker } from "../../lib/mapgeo";
import { fold, matchingItems } from "../../lib/storage";
import type { ApiMap } from "../../types";
import { markerKind, markerTitle } from "./MapDetails";
import { ItemIcon } from "../storage/ItemIcon";
import { StackLevel } from "../storage/StackLevel";
import { MapIcon } from "./MapIcon";
import { useMapPerf } from "../../lib/mapperf";
import { RelativeTime } from "../RelativeTime";

/** The mark each layer row shows; the fog and grid get small drawn swatches instead. */
const LAYER_ICON: Partial<Record<LayerId, IconId>> = {
  bases: "base",
  portals: "portal",
  graves: "grave",
  beds: "bed",
  vehicles: "ship",
  storage: "chest",
  pins: "pin-fire",
  locations: "loc-dungeon",
};

function Swatch({ layer }: { layer: LayerId }) {
  if (layer === "relief")
    return (
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="shrink-0">
        <circle cx="11" cy="11" r="10" fill="#7c9cab" />
        <path d="M4 12c2-4 5-6 8-5s4 3 6 2v6a10 10 0 0 1-14-1z" fill="#9cac5c" />
        <path d="M9 9l2-3 2 3z" fill="#e2e2e6" />
      </svg>
    );
  if (layer === "contours")
    return (
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="shrink-0">
        <circle cx="11" cy="11" r="10" fill="#9cac5c" />
        <path d="M4 15c3-1 4-5 7-5s4 3 7 2M6 18c2-1 3-3 5-3s4 2 6 1M7 8c1-2 3-3 5-2" stroke="#2b1d12" strokeOpacity="0.55" strokeWidth="1" fill="none" strokeLinecap="round" />
      </svg>
    );
  if (layer === "fog")
    return (
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="shrink-0">
        <circle cx="11" cy="11" r="10" fill="#e9dfc6" />
        <path d="M4 13c2-3 4-1 6-3s5-2 8 1" stroke="#9c8b6a" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      </svg>
    );
  if (layer === "nature")
    return (
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="shrink-0">
        <circle cx="11" cy="11" r="10" fill="#d9c7a0" />
        <path d="M5.5 12.5a3.6 3.6 0 0 1 3-5.6 3.8 3.8 0 0 1 6.8.6 3.4 3.4 0 0 1 .9 6.4 3.6 3.6 0 0 1-5.2 1.9 3.6 3.6 0 0 1-5.5-3.3z" fill="#9aae62" stroke="#3f4d22" strokeWidth="1.2" />
        <circle cx="15.5" cy="16.5" r="1.6" fill="#8d8a82" stroke="#4a463f" strokeWidth="0.8" />
      </svg>
    );
  if (layer === "resources")
    return (
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="shrink-0">
        <circle cx="11" cy="11" r="10" fill="#d9c7a0" />
        <path d="M6 13l2.5-5.5 5-1.5 3 4-1.5 5-6 1z" fill="#d27a32" stroke="#20160d" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M9 10.5l2.5-1.5M11.5 14l2-1.5" stroke="#fff6dc" strokeOpacity="0.8" strokeWidth="1" strokeLinecap="round" />
      </svg>
    );
  if (layer === "buildings")
    return (
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="shrink-0">
        <circle cx="11" cy="11" r="10" fill="#d9c7a0" />
        <path d="M6 6h10v10H6z" fill="#ecdcb4" />
        <path d="M11 16H6V6h10v10h-2M11 6v5h5" fill="none" stroke="#3a2a1a" strokeWidth="1.6" strokeLinecap="square" />
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

/** Layers without a count: drawn from what loads as the map is zoomed, or nothing to count. */
const NO_COUNT = new Set<LayerId>(["grid", "fog", "relief", "contours", "nature", "resources"]);

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
  { icon: "pin-boss", key: "map.legend.bossPin" },
];

/** Search, layer toggles with counts, the legend and what the map leaves out. */
export function MapLayers({
  map,
  markers,
  layers,
  counts,
  relief = "none",
  onToggle,
  onPick,
  extra,
}: {
  map: ApiMap;
  markers: readonly Marker[];
  layers: Record<LayerId, boolean>;
  counts: Record<LayerId, number>;
  /** The world generator's terrain: none (no row), ready, or from an older game build. */
  relief?: "none" | "ready" | "stale";
  onToggle: (l: LayerId) => void;
  /** `level`: the chest of a stack that holds what was searched for. */
  onPick: (m: Marker, level?: number) => void;
  /** A section of its own under the search (the web pins). */
  extra?: ReactNode;
}) {
  const { t, tn, lookup, number } = useI18n();
  const { on: perf } = useMapPerf();
  const [query, setQuery] = useState("");
  const searchId = useId();
  // Item names in every language match; the other dictionaries load once a query is typed.
  const langs = useEveryLocale(query.trim().length >= 2);
  const results = useMemo(() => {
    const shown = markers.filter((m) => layers[m.layer]);
    const byName = searchMarkers(shown, query, (m) => `${markerTitle(m, t, lookup)} ${markerKind(m, t, lookup)}`);
    // Then whatever holds a matching item, the most of it first.
    const q = fold(query.trim());
    const seen = new Set(byName.map((m) => m.id));
    const held: { m: Marker; hint: string; count: number; item?: string; level?: number }[] = [];
    if (q.length >= 2) {
      for (const m of shown) {
        const items = markerItems(m);
        if (!items?.length || seen.has(m.id)) continue;
        const hits = matchingItems(items, q, lookup);
        if (!hits.length) continue;
        const top = hits[0]!;
        // In a stack, the chest that holds the most of it.
        const stores = markerStores(m);
        let level: number | undefined;
        if (stores.length > 1) {
          const counts = stores.map((c) => matchingItems(c.items, q, lookup).find((h) => h.name === top.name)?.count ?? 0);
          level = counts.indexOf(Math.max(...counts));
        }
        held.push({ m, count: top.count, item: top.name, level, hint: t("map.searchItem", { item: top.label, n: number(top.count) }) });
      }
      held.sort((a, b) => b.count - a.count);
    }
    return [...byName.map((m): { m: Marker; hint: string; item?: string; level?: number } => ({ m, hint: "" })), ...held.slice(0, 10)];
  }, [markers, layers, query, t, lookup, number, langs]);
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
            {results.map(({ m, hint, item, level }) => (
              <li key={m.id}>
                <button type="button" onClick={() => onPick(m, level)} className="press-soft flex w-full items-center gap-2 rounded-[2px] px-1.5 py-1 text-left hover:bg-black/25 coarse:min-h-11">
                  <MapIcon icon={m.icon} size={20} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-bone">{markerTitle(m, t, lookup)}</span>
                    {level !== undefined && m.data.type === "storage" && m.data.stack && <StackLevel index={level} total={m.data.stack.length} ordered={m.data.stack.every((c) => typeof c.y === "number")} className="text-xs text-ash" />}
                  </span>
                  {item && <ItemIcon name={item} size={14} iconSize={22} className="text-flame/80" />}
                  <span className={`shrink-0 text-xs ${hint ? "font-bold tabular-nums text-flame" : "text-ash"}`}>
                    {hint || (markerKind(m, t, lookup) === markerTitle(m, t, lookup) ? "" : markerKind(m, t, lookup))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {extra}

      <div>
        <h3 className="label-caps">{t("map.layers")}</h3>
        <ul className="mt-1.5 space-y-0.5">
          {LAYERS.filter((l) => (l !== "relief" && l !== "contours") || relief !== "none").map((l) => {
            const label = t(`map.layer.${l}` as TextKey);
            const on = layers[l];
            // Contour lines are drawn on the terrain, and not in performance mode.
            const disabled = (l === "fog" && !map.explored.available) || (l === "contours" && (!layers.relief || perf));
            return (
              <li key={l}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => onToggle(l)}
                  aria-label={t("map.layerToggle", { layer: label, state: on ? t("map.on") : t("map.off.state") })}
                  className={`press-soft flex w-full items-center gap-2.5 rounded-[2px] px-1.5 py-1.5 text-left transition-opacity hover:bg-black/25 disabled:cursor-not-allowed coarse:min-h-12 coarse:gap-3 coarse:text-base ${on && !disabled ? "" : "opacity-45"}`}
                >
                  <Swatch layer={l} />
                  <span className="flex-1 text-bone">{label}</span>
                  {!NO_COUNT.has(l) && <span className="text-xs tabular-nums text-ash">{number(counts[l])}</span>}
                  {/* A wider switch for a thumb. */}
                  <span aria-hidden className={`h-3.5 w-6 rounded-full p-[2px] transition-colors coarse:h-7 coarse:w-12 coarse:p-[3px] ${on && !disabled ? "bg-select" : "bg-black/50"}`}>
                    <span
                      className={`block h-2.5 w-2.5 rounded-full bg-bone shadow-[0_1px_2px_rgba(0,0,0,0.5)] transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none coarse:h-5.5 coarse:w-5.5 ${on && !disabled ? "translate-x-2.5 coarse:translate-x-5" : ""}`}
                    />
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
        {relief === "stale" && <p>{t("map.relief.stale")}</p>}
        {relief !== "none" && layers.relief && !map.spoilers && <p>{t("map.relief.spoilers")}</p>}
        <p>{map.spoilers ? t("map.spoilersOn") : tn("map.spoilersOff", map.hiddenLocations)}</p>
        {!map.meta.showNames && <p>{t("map.namesHidden")}</p>}
        <p><RelativeTime iso={map.meta.savedAt} format={(ago) => t("map.builtFrom", { gen: map.meta.generation, ago })} /></p>
      </div>
    </div>
  );
}
