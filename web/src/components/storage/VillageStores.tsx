import { memo, useCallback, useDeferredValue, useId, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import type { IconId } from "../../lib/mapgeo";
import { aggregate, CATEGORIES, searchStore, type Category, type StoreEntry } from "../../lib/storage";
import { useStorage } from "../../lib/useStorage";
import type { MapContainer } from "../../types";
import { MapIcon } from "../map/MapIcon";
import { Sheet, SheetClose } from "../Sheet";
import { ItemGlyph } from "./ItemIcon";

const ICON: Record<MapContainer["kind"], IconId> = { chest: "chest", cart: "cart", ship: "ship" };

/** A container's name: the chest's kind ("Reinforced chest"), the cart or the ship. */
export function containerTitle(c: MapContainer, t: ReturnType<typeof useI18n>["t"], lookup: ReturnType<typeof useI18n>["lookup"]): string {
  if (c.kind === "chest") return lookup(`map.storage.prefab.${c.prefab}`) ?? t("map.storage.chest");
  return lookup(`map.vehicle.${c.prefab}`) ?? c.prefab;
}

const Row = memo(function Row({ entry, onOpen }: { entry: StoreEntry; onOpen: (e: StoreEntry) => void }) {
  const { tn, number } = useI18n();
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(entry)}
        aria-haspopup="dialog"
        className="press-soft flex min-h-9 w-full items-center gap-2.5 rounded-[2px] px-1.5 py-1 text-left hover:bg-black/25 coarse:min-h-11"
      >
        <ItemGlyph category={entry.category} size={18} className="text-flame/80" />
        <span className="min-w-0 flex-1 truncate text-bone">{entry.label}</span>
        <span className="shrink-0 text-[0.6875rem] text-ash">{tn("store.places", entry.places.length)}</span>
        <span className="w-12 shrink-0 text-right font-bold tabular-nums text-flame">{number(entry.total)}</span>
      </button>
    </li>
  );
});

/**
 * Everything the village keeps in the chests, carts and ships players built,
 * added up, searchable in either language and grouped by kind. An item opens
 * the list of places it is in, most first; each one goes to the map, where
 * every place holding it is ringed.
 */
export function VillageStores({ saveKey, onShow }: { saveKey: string; onShow: (entry: StoreEntry, open: string) => void }) {
  const { t, tn, lookup } = useI18n();
  const [load, retry] = useStorage(saveKey);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [open, setOpen] = useState<StoreEntry | null>(null);
  const searchId = useId();

  const containers = load.status === "ready" ? load.storage.containers : null;
  const entries = useMemo(() => (containers ? aggregate(containers, lookup) : []), [containers, lookup]);
  const groups = useMemo(() => {
    const found = searchStore(entries, deferred);
    const by = new Map<Category, StoreEntry[]>();
    for (const e of found) {
      const list = by.get(e.category);
      if (list) list.push(e);
      else by.set(e.category, [e]);
    }
    return CATEGORIES.filter((c) => by.has(c)).map((c) => ({ category: c, entries: by.get(c)! }));
  }, [entries, deferred]);
  const unreadable = useMemo(() => containers?.filter((c) => c.unreadable).length ?? 0, [containers]);
  const onOpen = useCallback((e: StoreEntry) => setOpen(e), []);
  const show = useCallback(
    (e: StoreEntry, id: string) => {
      setOpen(null);
      onShow(e, id);
    },
    [onShow],
  );

  if (load.status !== "ready") {
    const text = load.status === "loading" ? t("store.loading") : load.status === "off" ? t("store.off") : t("store.failed");
    return (
      <div className="py-4 text-center text-sm">
        <p className={load.status === "loading" ? "text-flame" : "text-bone"}>{text}</p>
        {load.status === "failed" && (
          <button type="button" onClick={retry} className="plaque press mt-3 px-4 py-2 text-sm font-bold coarse:min-h-11">
            {t("map.retry")}
          </button>
        )}
      </div>
    );
  }
  if (entries.length === 0) return <p className="py-4 text-center text-sm text-ash">{t("store.empty")}</p>;

  return (
    <div className="text-sm">
      <div role="search">
        <label htmlFor={searchId} className="sr-only">
          {t("store.search")}
        </label>
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("store.searchPlaceholder")}
          className="field w-full px-3 py-2 text-sm coarse:min-h-11 coarse:text-base"
          autoComplete="off"
          enterKeyHint="search"
        />
      </div>
      <p className="mt-2 text-xs text-ash">
        {t("store.totals", { kinds: entries.length, containers: containers!.length })}
        {unreadable > 0 && <> {tn("store.unreadable", unreadable)}</>}
      </p>
      {groups.length === 0 ? (
        <p className="mt-4 text-center text-ash" aria-live="polite">
          {t("store.searchEmpty")}
        </p>
      ) : (
        <div className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <section key={g.category} aria-label={t(`store.cat.${g.category}`)} className="min-w-0">
              <h3 className="label-caps flex items-center gap-1.5 border-b border-iron/30 pb-1">
                <ItemGlyph category={g.category} size={14} />
                {t(`store.cat.${g.category}`)}
              </h3>
              <ul className="mt-1">
                {g.entries.map((e) => (
                  <Row key={e.name} entry={e} onOpen={onOpen} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {open && <WhereSheet entry={open} onClose={() => setOpen(null)} onShow={show} />}
    </div>
  );
}

/** Where one item is: every container holding it, most first, each a way onto the map. */
function WhereSheet({ entry, onClose, onShow }: { entry: StoreEntry; onClose: () => void; onShow: (entry: StoreEntry, open: string) => void }) {
  const { t, tn, lookup, number } = useI18n();
  return (
    <Sheet
      labelledBy="store-where-h"
      onClose={onClose}
      header={(close) => (
        <div className="flex items-center gap-3 pl-1">
          <span className="slot grid h-11 w-11 shrink-0 place-items-center text-flame">
            <ItemGlyph category={entry.category} size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="store-where-h" className="plank-title truncate text-lg">
              {entry.label}
            </h2>
            <p className="text-xs text-ash">
              {number(entry.total)} · {tn("store.places", entry.places.length)}
            </p>
          </div>
          <SheetClose label={t("map.close")} escLabel={t("key.esc")} onClose={close} />
        </div>
      )}
    >
      <h3 className="label-caps mt-1">{t("store.where")}</h3>
      <ul className="mt-2 space-y-1">
        {entry.places.map((p) => (
          <li key={p.container.id}>
            <button
              type="button"
              onClick={() => onShow(entry, p.container.id)}
              className="press-soft flex min-h-12 w-full items-center gap-3 rounded-[2px] px-2 py-1.5 text-left hover:bg-black/25"
            >
              <MapIcon icon={ICON[p.container.kind]} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-bone">{containerTitle(p.container, t, lookup)}</span>
                <span className="block text-xs text-ash">{t("map.at", { x: p.container.x, z: p.container.z })}</span>
              </span>
              <span className="shrink-0 font-bold tabular-nums text-flame">{number(p.count)}</span>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-ash">
                <path d="M6 3l5 5-5 5" />
              </svg>
              <span className="sr-only">{t("store.showOnMap")}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => onShow(entry, entry.places[0]!.container.id)} className="plaque press mt-4 w-full px-4 py-2.5 text-sm font-bold coarse:min-h-11">
        {entry.places.length > 1 ? t("store.showAll") : t("store.showOnMap")}
      </button>
    </Sheet>
  );
}
