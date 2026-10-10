import { useI18n } from "../../i18n";
import type { Marker } from "../../lib/mapgeo";
import { mapUrlAt } from "../../lib/world";
import { MapIcon } from "./MapIcon";

/** What a mark is, in a few words: the popover heading and the search hint. */
export function markerTitle(m: Marker, t: ReturnType<typeof useI18n>["t"], lookup: ReturnType<typeof useI18n>["lookup"]): string {
  const d = m.data;
  switch (d.type) {
    case "base":
      return t("map.base.title");
    case "portal":
      return d.tag ? t("map.portal.tagged", { tag: d.tag }) : t("map.portal.title");
    case "grave":
      return t("map.grave.title");
    case "bed":
      return t("map.bed.title");
    case "vehicle":
      return lookup(`map.vehicle.${d.kind}`) ?? d.kind;
    case "pin":
      return d.name || (lookup(`map.pinKind.${d.kind}`) ?? t("map.pinKind.other"));
    case "location":
      return m.label;
  }
}

/** The kind of a mark, for search ("portal", "grave", "Haldor", ...). */
export function markerKind(m: Marker, t: ReturnType<typeof useI18n>["t"], lookup: ReturnType<typeof useI18n>["lookup"]): string {
  const d = m.data;
  switch (d.type) {
    case "pin":
      return lookup(`map.pinKind.${d.kind}`) ?? t("map.pinKind.other");
    case "location":
      return lookup(`map.locKind.${d.kind}`) ?? d.kind;
    default:
      return markerTitle(m, t, lookup);
  }
}

/**
 * The details of one mark: what it is, the facts the save holds about it,
 * and a link to the same spot on valheim-map.world.
 */
export function MapDetails({
  marker,
  seedName,
  onGo,
  onClose,
}: {
  marker: Marker;
  seedName: string;
  /** Moves the map to a world point (the other end of a portal). */
  onGo?: (x: number, z: number) => void;
  onClose: () => void;
}) {
  const { t, tn, lookup } = useI18n();
  const d = marker.data;
  const lines: string[] = [];
  switch (d.type) {
    case "base":
      lines.push(tn("map.base.pieces", d.pieces));
      lines.push(d.hasBed ? t("map.base.bed") : t("map.base.noBed"));
      if (d.stations.length) lines.push(d.stations.map((s) => lookup(`map.station.${s}`) ?? s).join(", "));
      break;
    case "portal":
      if (!d.pairedWith) lines.push(t("map.portal.unpaired"));
      else lines.push(d.partnerTag ? t("map.portal.leadsTo", { tag: d.partnerTag }) : t("map.portal.leadsToPortal"));
      break;
    case "grave": {
      const name = d.owner || t("map.grave.someone");
      lines.push(d.day >= 0 ? t("map.grave.fell", { name, day: d.day }) : t("map.grave.fellHere", { name }));
      break;
    }
    case "bed":
      if (d.owner) lines.push(t("map.bed.owner", { name: d.owner }));
      break;
    case "pin":
      if (d.name) lines.push(lookup(`map.pinKind.${d.kind}`) ?? t("map.pinKind.other"));
      else lines.push(t("map.pinUnnamed"));
      break;
    case "location":
      lines.push(lookup(`map.locKind.${d.kind}`) ?? d.kind);
      lines.push(d.explored ? t("map.loc.found") : d.placed ? t("map.loc.unfound") : t("map.loc.unplaced"));
      break;
  }
  const partner = d.type === "portal" ? d.partner : undefined;
  return (
    <div className="w-[16.5rem] max-w-[calc(100vw-2rem)] text-sm">
      <div className="flex items-start gap-2.5">
        <MapIcon icon={marker.icon} size={30} />
        <div className="min-w-0 flex-1">
          <h3 className="font-bold leading-tight text-flame">{markerTitle(marker, t, lookup)}</h3>
          <p className="mt-0.5 text-xs text-ash">{t("map.at", { x: marker.x, z: marker.z })}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={t("map.closeDetails")} className="plaque press -mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center">
          <svg width="11" height="11" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      </div>
      {lines.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-bone">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {partner && onGo && (
          <button type="button" onClick={() => onGo(partner.x, partner.z)} className="plaque press px-2.5 py-1 text-xs font-bold">
            {t("map.portal.goOther")}
          </button>
        )}
        {seedName && (
          <a
            href={mapUrlAt(seedName, marker.x, marker.z)}
            target="_blank"
            rel="noopener noreferrer"
            title={t("map.openFullHint")}
            className="inline-flex items-center gap-1 text-xs font-bold text-flame underline decoration-flame/40 underline-offset-4 hover:text-gold"
          >
            {t("map.openFull")}
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
              <path d="M4 2h6v6M10 2L3 9" />
            </svg>
          </a>
        )}
      </div>
    </div>
  );
}
