import { useI18n } from "../../i18n";
import { markerItems, markerStore, type Marker } from "../../lib/mapgeo";
import { countItems } from "../../lib/storage";
import { mapUrlAt } from "../../lib/world";
import { clusterSummary, contentsOf, sortCluster, stackText, summarize, type Summary } from "../../lib/clusterlist";
import { InventoryGrid } from "../storage/Inventory";
import { ItemIcon } from "../storage/ItemIcon";
import { MapIcon } from "./MapIcon";

/** What a mark is, in a few words: the popover heading and the search hint. */
export function markerTitle(m: Marker, t: ReturnType<typeof useI18n>["t"], lookup: ReturnType<typeof useI18n>["lookup"]): string {
  const d = m.data;
  switch (d.type) {
    case "base":
      return d.name || t("map.base.title");
    case "portal":
      return d.tag ? t("map.portal.tagged", { tag: d.tag }) : t("map.portal.title");
    case "grave":
      return t("map.grave.title");
    case "bed":
      return t("map.bed.title");
    case "vehicle":
      return lookup(`map.vehicle.${d.kind}`) ?? d.kind;
    case "storage":
      return lookup(`map.storage.prefab.${d.store.prefab}`) ?? t("map.storage.chest");
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

function marksLines(marker: Marker, t: ReturnType<typeof useI18n>["t"], tn: ReturnType<typeof useI18n>["tn"], lookup: ReturnType<typeof useI18n>["lookup"]): string[] {
  const d = marker.data;
  const lines: string[] = [];
  switch (d.type) {
    case "base":
      if (d.name) lines.push(t("map.base.title"));
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
      if (d.items.length) lines.push(tn("map.grave.holds", countItems(d.items)));
      break;
    }
    case "bed":
      if (d.owner) lines.push(t("map.bed.owner", { name: d.owner }));
      break;
    case "vehicle":
    case "storage": {
      const store = markerStore(marker);
      if (!store) break;
      const n = countItems(store.items);
      if (store.unreadable) lines.push(t("map.storage.unreadable"));
      else if (store.width === 0) lines.push(t("map.storage.noHold"));
      else if (n === 0) lines.push(t("map.storage.empty"));
      else lines.push(tn(d.type === "vehicle" ? "map.storage.loaded" : "map.storage.holds", n));
      break;
    }
    case "pin":
      if (d.name) lines.push(lookup(`map.pinKind.${d.kind}`) ?? t("map.pinKind.other"));
      else lines.push(t("map.pinUnnamed"));
      break;
    case "location":
      lines.push(lookup(`map.locKind.${d.kind}`) ?? d.kind);
      lines.push(d.explored ? t("map.loc.found") : d.placed ? t("map.loc.unfound") : t("map.loc.unplaced"));
      break;
  }
  return lines;
}

/** Icon, title, where, and the close button: the popover's top row and the sheet's header. */
export function DetailsHead({ marker, group, onClose, headingId }: { marker: Marker; group?: readonly Marker[]; onClose: () => void; headingId?: string }) {
  const { t, tn, lookup } = useI18n();
  return (
    <div className="flex items-start gap-2.5">
      <MapIcon icon={marker.icon} size={30} />
      <div className="min-w-0 flex-1">
        <h3 id={headingId} className="font-bold leading-tight text-flame">
          {group ? tn("map.group.title", group.length) : markerTitle(marker, t, lookup)}
        </h3>
        <p className="mt-0.5 text-xs text-ash">{t("map.at", { x: marker.x, z: marker.z })}</p>
      </div>
      <button data-autofocus type="button" onClick={onClose} aria-label={t("map.closeDetails")} className="plaque press tap -mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center coarse:h-9 coarse:w-9">
        <svg width="11" height="11" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      </button>
    </div>
  );
}

/** Stacks as "50× Wood, 20× Stone" with their marks, and "+N more" past them. */
function SummaryLine({ summary, size, className = "" }: { summary: Summary; size: number; className?: string }) {
  const { t, number } = useI18n();
  return (
    <span className={`flex flex-wrap items-center gap-x-2.5 gap-y-0.5 ${className}`}>
      {summary.top.map((s) => (
        <span key={s.name} className="inline-flex items-center gap-1">
          <ItemIcon name={s.name} category={s.category} size={size} iconSize={size + 6} className="text-flame/80" />
          <span>{t("map.cluster.stack", { n: number(s.total), item: s.label })}</span>
        </span>
      ))}
      {summary.more > 0 && <span>{t("map.cluster.more", { n: summary.more })}</span>}
    </span>
  );
}

/** A pile of marks too close to zoom apart: what is in it, then each mark by how full it is. */
function ClusterList({ group, onPick }: { group: readonly Marker[]; onPick?: (m: Marker) => void }) {
  const { t, lookup } = useI18n();
  const rows = sortCluster(group);
  const all = clusterSummary(group, lookup);
  return (
    <>
      {all.top.length > 0 && (
        <div className="mt-2 rounded-[2px] bg-black/25 px-2 py-1.5">
          <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-ash">{t("map.cluster.all")}</p>
          <SummaryLine summary={all} size={14} className="mt-1 text-xs text-bone" />
        </div>
      )}
      <ul className="mt-1 space-y-0.5">
        {rows.map((m) => {
          const c = contentsOf(m);
          const title = markerTitle(m, t, lookup);
          const kind = markerKind(m, t, lookup);
          const sum = c.kind === "items" ? summarize(c.items, lookup) : null;
          const note = c.kind === "unreadable" ? t("map.cluster.unreadable") : c.kind === "noHold" ? t("map.cluster.noHold") : sum && sum.top.length === 0 ? t("map.cluster.empty") : null;
          return (
            <li key={m.id}>
              <button type="button" onClick={() => onPick?.(m)} className="press-soft flex min-h-11 w-full items-center gap-2.5 rounded-[2px] px-1.5 py-1 text-left hover:bg-black/25">
                <MapIcon icon={m.icon} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-bone">{title}</span>
                  {sum && sum.top.length > 0 && <SummaryLine summary={sum} size={12} className="text-xs text-ash" />}
                  {note && <span className="block text-xs text-ash">{note}</span>}
                </span>
                <span className="shrink-0 text-xs text-ash">{kind === title ? "" : kind}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * The facts the save holds about a mark, "Go to the other end" for a portal
 * and a link to the same spot on valheim-map.world; for a pile of marks too
 * close to zoom apart, the list of them to pick from.
 */
export function DetailsBody({
  marker,
  group,
  seedName,
  onGo,
  onPick,
  roomy = false,
}: {
  marker: Marker;
  group?: readonly Marker[];
  seedName: string;
  onGo?: (x: number, z: number) => void;
  onPick?: (m: Marker) => void;
  /** Phone sheet: full-width, finger-sized actions. */
  roomy?: boolean;
}) {
  const { t, tn, lookup, number } = useI18n();
  if (group) return <ClusterList group={group} onPick={onPick} />;
  const lines = marksLines(marker, t, tn, lookup);
  const d = marker.data;
  const items = markerItems(marker);
  const store = markerStore(marker);
  // A grave is the player's own 8 x 4 inventory; a raft has no hold at all.
  const grid = d.type === "grave" ? { width: 8, height: Math.max(4, ...d.items.map((i) => i.y + 1)) } : store && store.width > 0 && !store.unreadable ? store : null;
  const partner = d.type === "portal" ? d.partner : undefined;
  const action = roomy ? "min-h-11 px-4 py-2.5 text-sm" : "px-2.5 py-1 text-xs";
  return (
    <>
      {lines.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-bone">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {items && grid && (items.length > 0 || store) && (
        <div className="mt-3">
          <InventoryGrid items={items} width={grid.width} height={grid.height} names={roomy || grid.width <= 4} />
        </div>
      )}
      <div className={`mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 ${roomy ? "gap-x-3" : ""}`}>
        {partner && onGo && (
          <button type="button" onClick={() => onGo(partner.x, partner.z)} className={`plaque press font-bold ${action}`}>
            {t("map.portal.goOther")}
          </button>
        )}
        {seedName && (
          <a
            href={mapUrlAt(seedName, marker.x, marker.z)}
            target="_blank"
            rel="noopener noreferrer"
            title={t("map.openFullHint")}
            className={`inline-flex items-center gap-1 font-bold text-flame underline decoration-flame/40 underline-offset-4 hover:text-gold ${roomy ? "min-h-11 text-sm" : "text-xs"}`}
          >
            {t("map.openFull")}
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
              <path d="M4 2h6v6M10 2L3 9" />
            </svg>
          </a>
        )}
      </div>
    </>
  );
}

/** The popover over a mark (wider screens): head and body in one small board. */
export function MapDetails({
  marker,
  group,
  seedName,
  onGo,
  onPick,
  onClose,
}: {
  marker: Marker;
  group?: readonly Marker[];
  seedName: string;
  /** Moves the map to a world point (the other end of a portal). */
  onGo?: (x: number, z: number) => void;
  onPick?: (m: Marker) => void;
  onClose: () => void;
}) {
  return (
    <div className={`${!group && markerItems(marker)?.length ? "w-[19rem]" : "w-[16.5rem]"} max-w-[calc(100vw-2rem)] text-sm`}>
      <DetailsHead marker={marker} group={group} onClose={onClose} />
      <DetailsBody marker={marker} group={group} seedName={seedName} onGo={onGo} onPick={onPick} />
    </div>
  );
}
