import { memo, useCallback, useDeferredValue, useId, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import type { IconId } from "../../lib/mapgeo";
import { groupStacks, stackIndex, type StackPlace } from "../../lib/stacks";
import { aggregate, CATEGORIES, searchStore, type Category, type StoreEntry } from "../../lib/storage";
import { useStorage } from "../../lib/useStorage";
import type { MapContainer } from "../../types";
import { MapIcon } from "../map/MapIcon";
import { Sheet, SheetClose } from "../Sheet";
import { ItemGlyph, ItemIcon } from "./ItemIcon";
import { StackLevel } from "./StackLevel";

const ICON: Record<MapContainer["kind"], IconId> = { chest: "chest", cart: "cart", ship: "ship" };

/** A container's name: the chest's kind ("Reinforced chest"), the cart or the ship. */
export function containerTitle(c: MapContainer, t: ReturnType<typeof useI18n>["t"], lookup: ReturnType<typeof useI18n>["lookup"]): string {
  if (c.kind === "chest") return lookup(`map.storage.prefab.${c.prefab}`) ?? t("map.storage.chest");
  return lookup(`map.vehicle.${c.prefab}`) ?? c.prefab;
}

/** Slots shown before "Show all": four rows of six on a phone, three rows of ~64 px slots wider. */
const PHONE = 640;
const SLOT = 64;
const GAP = 3;

/** How many columns the bag gets, and how many slots fit before "Show all". */
function useBagSize() {
  const [width, setWidth] = useState(0);
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = width < PHONE ? 6 : Math.max(6, Math.floor((width + GAP) / (SLOT + GAP)));
  return { ref, cols, collapsed: cols * (width < PHONE ? 4 : 3) };
}
const OPEN_KEY = "skald.stores.open";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean) {
  try {
    if (open) localStorage.setItem(OPEN_KEY, "1");
    else localStorage.removeItem(OPEN_KEY);
  } catch {
    // Private mode or blocked storage: the choice just does not stick.
  }
}

const Slot = memo(function Slot({ entry, onOpen }: { entry: StoreEntry; onOpen: (e: StoreEntry) => void }) {
  const { t, tn, number } = useI18n();
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(entry)}
        aria-haspopup="dialog"
        aria-label={`${t("inv.slot", { item: entry.label, n: number(entry.total) })}, ${tn("store.places", entry.places.length)}`}
        title={entry.label}
        className="slot press-soft relative grid aspect-square w-full place-items-center overflow-hidden p-0.5 text-flame hover:brightness-125"
      >
        <ItemIcon name={entry.name} category={entry.category} size={20} iconSize={30} className="opacity-90" />
        <span className="absolute bottom-0.5 right-1 text-[0.625rem] font-bold tabular-nums leading-none text-bone [text-shadow:1px_0_0_#000,-1px_0_0_#000,0_1px_0_#000,0_-1px_0_#000]">
          {number(entry.total)}
        </span>
      </button>
    </li>
  );
});

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`press-soft flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-bold whitespace-nowrap coarse:min-h-11 ${
        on ? "border-flame/70 bg-flame/15 text-bone" : "border-iron/40 text-ash hover:text-bone"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Everything the village keeps in the chests, carts and ships players built,
 * added up into one bag of slots, biggest stacks first. Chips narrow it to a
 * kind, search works in either language, and the bag stays a few rows tall
 * until asked for the rest. A slot opens the list of places the item is in;
 * each one goes to the map, where every place holding it is ringed.
 */
export function VillageStores({ saveKey, onShow }: { saveKey: string; onShow: (entry: StoreEntry, open: string) => void }) {
  const { t, tn, lookup, number } = useI18n();
  const [load, retry] = useStorage(saveKey);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [category, setCategory] = useState<Category | null>(null);
  const [expanded, setExpanded] = useState(readOpen);
  const [open, setOpen] = useState<StoreEntry | null>(null);
  const searchId = useId();
  const bag = useBagSize();

  const containers = load.status === "ready" ? load.storage.containers : null;
  const entries = useMemo(() => (containers ? aggregate(containers, lookup) : []), [containers, lookup]);
  const stacks = useMemo(() => stackIndex(groupStacks(containers ?? [])), [containers]);
  const found = useMemo(() => searchStore(entries, deferred), [entries, deferred]);
  const counts = useMemo(() => {
    const by = new Map<Category, number>();
    for (const e of found) by.set(e.category, (by.get(e.category) ?? 0) + 1);
    return CATEGORIES.filter((c) => by.has(c)).map((c) => ({ category: c, n: by.get(c)! }));
  }, [found]);
  const active = category && counts.some((c) => c.category === category) ? category : null;
  const shown = useMemo(
    () => (active ? found.filter((e) => e.category === active) : found).toSorted((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
    [found, active],
  );
  const searching = deferred.trim() !== "";
  const clipped = !expanded && !searching && shown.length > bag.collapsed;
  const unreadable = useMemo(() => containers?.filter((c) => c.unreadable).length ?? 0, [containers]);
  const onOpen = useCallback((e: StoreEntry) => setOpen(e), []);
  const toggle = useCallback(() => {
    setExpanded((was) => {
      writeOpen(!was);
      return !was;
    });
  }, []);
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
    <div ref={bag.ref} className="text-sm">
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
      {counts.length > 0 && (
        <div role="group" aria-label={t("store.kinds")} className="-mx-1 mt-2 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          <Chip on={active === null} onClick={() => setCategory(null)}>
            {t("store.all")} <span className="tabular-nums text-ash">{number(found.length)}</span>
          </Chip>
          {counts.map(({ category: c, n }) => (
            <Chip key={c} on={active === c} onClick={() => setCategory(active === c ? null : c)}>
              <ItemGlyph category={c} size={13} />
              {t(`store.cat.${c}`)} <span className="tabular-nums text-ash">{number(n)}</span>
            </Chip>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <p className="mt-4 text-center text-ash" aria-live="polite">
          {t("store.searchEmpty")}
        </p>
      ) : (
        <>
          <ul aria-label={active ? t(`store.cat.${active}`) : t("store.title")} className="mt-2 grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${bag.cols}, minmax(0, 1fr))` }}>
            {(clipped ? shown.slice(0, bag.collapsed) : shown).map((e) => (
              <Slot key={e.name} entry={e} onOpen={onOpen} />
            ))}
          </ul>
          {!searching && shown.length > bag.collapsed && (
            <button type="button" onClick={toggle} aria-expanded={expanded} className="press-soft mt-2 w-full rounded-[2px] py-2 text-xs font-bold text-flame hover:bg-black/25 coarse:min-h-11">
              {expanded ? t("store.less") : t("store.more", { n: number(shown.length) })}
            </button>
          )}
        </>
      )}
      <p className="mt-2 text-xs text-ash">
        {t("store.totals", { kinds: entries.length, containers: containers!.length })}
        {unreadable > 0 && <> {tn("store.unreadable", unreadable)}</>}
      </p>
      {open && <WhereSheet entry={open} stacks={stacks} onClose={() => setOpen(null)} onShow={show} />}
    </div>
  );
}

/** Where one item is: every container holding it, most first, each a way onto the map. */
function WhereSheet({ entry, stacks, onClose, onShow }: { entry: StoreEntry; stacks: ReadonlyMap<string, StackPlace>; onClose: () => void; onShow: (entry: StoreEntry, open: string) => void }) {
  const { t, tn, lookup, number } = useI18n();
  return (
    <Sheet
      labelledBy="store-where-h"
      onClose={onClose}
      header={(close) => (
        <div className="flex items-center gap-3 pl-1">
          <span className="slot grid h-11 w-11 shrink-0 place-items-center text-flame">
            <ItemIcon name={entry.name} category={entry.category} size={22} iconSize={36} />
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
        {entry.places.map((p) => {
          const at = stacks.get(p.container.id);
          return (
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
                  {at && at.stack.chests.length > 1 && <StackLevel index={at.index} total={at.stack.chests.length} ordered={at.stack.ordered} className="mt-0.5 text-xs text-bone" />}
                </span>
                <span className="shrink-0 font-bold tabular-nums text-flame">{number(p.count)}</span>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-ash">
                  <path d="M6 3l5 5-5 5" />
                </svg>
                <span className="sr-only">{t("store.showOnMap")}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={() => onShow(entry, entry.places[0]!.container.id)} className="plaque press mt-4 w-full px-4 py-2.5 text-sm font-bold coarse:min-h-11">
        {entry.places.length > 1 ? t("store.showAll") : t("store.showOnMap")}
      </button>
    </Sheet>
  );
}
