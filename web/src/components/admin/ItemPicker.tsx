import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { loadKits, PRESET_KITS, saveKits, stacksOf, stackSize, type Kit, type KitLine } from "../../lib/admin";
import { useIconSheet } from "../../lib/itemicons";
import { fold, isUnusedItem, itemLabel, itemMatches } from "../../lib/storage";
import { useEveryLocale, useI18n } from "../../i18n";
import { dictFor } from "../../i18n/load";
import { Sheet } from "../Sheet";
import { ItemIcon } from "../storage/ItemIcon";
import { targetBody, useAdmin, type Target } from "./AdminContext";
import { AdminHead, Btn, Chip, Stepper, TargetChips } from "./parts";

/** The plugin's caps: 20 lines and 60 stacks per call. */
const MAX_LINES = 20;
const MAX_STACKS = 60;
/** More stacks than this get a second tap. */
const CONFIRM_STACKS = 10;
const SHOWN = 72;

/**
 * Give items: search every item the server's icon sheet knows (names in
 * English and Polish), build a list with amounts and quality, keep it as a
 * kit on this device, and drop it next to a player or at a point.
 */
export function ItemPicker({ target: initial, lines: initialLines, onClose }: { target: Target; lines?: KitLine[]; onClose: () => void }) {
  const { t, tn, lookup } = useI18n();
  const admin = useAdmin();
  const reduced = useReducedMotion() ?? false;
  const [target, setTarget] = useState<Target>(initial);
  const [lines, setLines] = useState<KitLine[]>(initialLines ?? []);
  const [kits, setKits] = useState<Kit[]>(loadKits);
  const [kitName, setKitName] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const stacks = stacksOf(lines, stackSize);
  const tooMany = stacks > MAX_STACKS;
  const add = (item: string) => {
    navigator.vibrate?.(6);
    setConfirm(false);
    setLines((ls) => {
      const i = ls.findIndex((l) => l.item === item);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, amount: Math.min(999, l.amount + (stackSize(item) > 1 ? 10 : 1)) } : l));
      if (ls.length >= MAX_LINES) return ls;
      return [...ls, { item, amount: stackSize(item) > 1 ? 10 : 1, quality: 1 }];
    });
  };
  const update = (i: number, patch: Partial<KitLine>) => {
    setConfirm(false);
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  };
  const remove = (i: number) => setLines((ls) => ls.filter((_, j) => j !== i));

  const kitGroups = [
    { title: t("admin.items.defaultKits"), kits: PRESET_KITS.map((k) => ({ ...k, name: t(k.nameKey) })), custom: false },
    { title: t("admin.items.customKits"), kits, custom: true },
  ];
  const storeKit = () => {
    const name = (kitName ?? "").trim();
    if (!name || lines.length === 0) return;
    const next = [{ name, lines }, ...kits.filter((k) => k.name !== name)];
    setKits(next);
    saveKits(next);
    setKitName(null);
    admin?.toast(true, t("admin.items.kitSaved", { name }));
  };
  const dropKit = (name: string) => {
    const next = kits.filter((k) => k.name !== name);
    setKits(next);
    saveKits(next);
  };

  const send = async () => {
    if (!admin || lines.length === 0 || tooMany || busy) return;
    if (stacks > CONFIRM_STACKS && !confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    const body = lines.length === 1 ? { ...lines[0]!, ...targetBody(target) } : { items: lines, ...targetBody(target) };
    const where = "player" in target ? target.player : t("admin.target.there");
    const res = await admin.run("spawn", body, { done: t("admin.items.sent", { what: tn("admin.items.count", lines.reduce((n, l) => n + l.amount, 0)), where }) });
    setConfirm(false);
    // One drop a second at most, whatever the fingers do.
    setTimeout(() => setBusy(false), 1000);
    if (res.ok) setLines([]);
  };

  const blocked = !!admin?.blocker;
  const sub = "player" in target ? t("admin.items.to", { name: target.player }) : target.label === "base" ? t("admin.target.base") : t("admin.target.point", { x: Math.round(target.at.x), z: Math.round(target.at.z) });

  return (
    <Sheet
      labelledBy="items-h"
      onClose={onClose}
      width="sm:w-136"
      header={(close) => (
        <AdminHead
          id="items-h"
          kicker={t("admin.kicker")}
          title={t("admin.items.title")}
          sub={sub}
          emblem={<ItemIcon name={lines[0]?.item ?? "Wood"} size={34} iconSize={40} className="text-flame" />}
          onClose={close}
        />
      )}
      footer={
        <div className="material shrink-0 border-t border-iron/50 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-7">
          <AnimatePresence initial={false}>
            {lines.length > 0 && (
              <motion.ul
                className="scroll-quiet mb-3 max-h-[30vh] space-y-2 overflow-y-auto"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ type: "spring", bounce: 0, visualDuration: 0.25 }}
              >
                {lines.map((l, i) => (
                  <motion.li key={l.item} layout={reduced ? false : "position"} className="flex items-center gap-2">
                    <span className="slot grid h-11 w-11 shrink-0 place-items-center">
                      <ItemIcon name={l.item} size={22} iconSize={34} className="text-label" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-bold leading-tight text-bone">{itemLabel(l.item, lookup)}</span>
                    <Stepper label={t("admin.items.amount")} value={l.amount} min={1} max={999} step={l.amount >= 100 ? 50 : l.amount >= 20 ? 10 : 1} onChange={(n) => update(i, { amount: n })} />
                    <button
                      type="button"
                      onClick={() => update(i, { quality: (l.quality % 4) + 1 })}
                      aria-label={`${t("admin.items.quality")} ${l.quality}`}
                      className="slot press grid h-11 min-w-11 place-items-center px-1.5 text-xs font-bold tabular-nums text-gold"
                    >
                      {"\u2605"}
                      {l.quality}
                    </button>
                    <button type="button" onClick={() => remove(i)} aria-label={t("admin.items.remove", { item: itemLabel(l.item, lookup) })} className="press grid h-11 w-9 place-items-center text-ash hover:text-blood">
                      <svg width="12" height="12" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                        <path d="M3 3l10 10M13 3L3 13" />
                      </svg>
                    </button>
                  </motion.li>
                ))}
              </motion.ul>
            )}
          </AnimatePresence>
          {kitName !== null ? (
            <div className="mb-3 flex gap-2">
              <input
                autoFocus
                value={kitName}
                maxLength={32}
                onChange={(e) => setKitName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && storeKit()}
                placeholder={t("admin.items.kitName")}
                aria-label={t("admin.items.kitName")}
                className="field min-h-11 flex-1"
              />
              <Btn onClick={storeKit} disabled={!kitName.trim()}>
                {t("admin.items.kitSave")}
              </Btn>
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Btn onClick={() => setKitName("")} disabled={lines.length === 0 || kitName !== null}>
              {t("admin.items.asKit")}
            </Btn>
            <span className={`flex-1 text-right text-xs ${tooMany ? "text-blood" : "text-ash"}`}>
              {lines.length === 0 ? t("admin.items.empty") : tooMany ? t("admin.items.tooMany", { max: MAX_STACKS }) : tn("admin.items.stacks", stacks)}
            </span>
            <Btn primary onClick={() => void send()} disabled={lines.length === 0 || tooMany || busy || blocked} className={confirm ? "ring-2 ring-flame" : ""}>
              {confirm ? t("admin.items.confirm", { n: stacks }) : t("admin.items.give")}
            </Btn>
          </div>
        </div>
      }
    >
      <div className="space-y-4 pb-4">
        <div>
          <p className="label-caps mb-2">{t("admin.items.where")}</p>
          <TargetChips value={target} onChange={setTarget} />
        </div>
        {kitGroups.filter((group) => group.kits.length > 0).map((group) => (
          <div key={group.title}>
            <p className="label-caps mb-2">{group.title}</p>
            <div className="flex flex-wrap gap-2">
              {group.kits.map((k) => (
                <span key={k.name} className="inline-flex items-center">
                  <Chip on={false} onClick={() => setLines(k.lines.slice(0, MAX_LINES))} title={k.lines.map((l) => `${l.amount} ${itemLabel(l.item, lookup)}`).join(", ")}>
                    {k.name}
                    <span className="text-xs font-normal text-ash">{k.lines.length}</span>
                  </Chip>
                  {group.custom && (
                    <button type="button" onClick={() => dropKit(k.name)} aria-label={t("admin.items.kitDelete", { name: k.name })} className="press -ml-1 grid h-9 w-7 place-items-center text-ash hover:text-blood">
                      <svg width="9" height="9" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                        <path d="M3 3l10 10M13 3L3 13" />
                      </svg>
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
        <ItemSearch
          onPick={add}
          badge={(name) => {
            const n = lines.find((l) => l.item === name)?.amount;
            return n ? <span className="absolute right-1 top-0.5 text-[0.6875rem] font-bold tabular-nums text-flame">{n}</span> : null;
          }}
          selected={(name) => lines.some((l) => l.item === name)}
        />
      </div>
    </Sheet>
  );
}

/**
 * Every item the server's icon sheet or the dictionaries know, searchable in
 * English and Polish: the grid of the Give items sheet and of Add item on a
 * chest. `selected` marks picked items, `badge` draws over a tile; `single`
 * makes the tiles a one-of choice for assistive tech.
 */
export function ItemSearch({ onPick, selected, badge, single = false }: { onPick: (item: string) => void; selected?: (item: string) => boolean; badge?: (item: string) => ReactNode; single?: boolean }) {
  const { t, lookup, locale } = useI18n();
  const sheet = useIconSheet();
  const [query, setQuery] = useState("");
  // Item names in every language are searched; the other dictionaries load once a query is typed.
  const langs = useEveryLocale(query.trim() !== "");

  const all = useMemo(() => {
    // Items the dictionaries name (the same keys in each): offered even without an icon sheet.
    const names = new Set(
      Object.keys(dictFor(locale) ?? {})
        .filter((k) => k.startsWith("item."))
        .map((k) => k.slice(5)),
    );
    if (sheet) for (const n of Object.keys(sheet.items)) names.add(n);
    return [...names].filter((name) => !isUnusedItem(name)).map((name) => ({ name, label: itemLabel(name, lookup), icon: !!sheet?.items[name] })).sort((a, b) => Number(b.icon) - Number(a.icon) || a.label.localeCompare(b.label));
  }, [sheet, lookup, locale]);

  const shown = useMemo(() => {
    const q = fold(query.trim());
    const list = q ? all.filter((i) => fold(i.label).includes(q) || itemMatches(i.name, q)) : all;
    return list.slice(0, SHOWN);
  }, [all, query, langs]);

  return (
    <>
      <div>
        <label htmlFor="item-q" className="label-caps mb-2 block">
          {t("admin.items.search")}
        </label>
        <input
          id="item-q"
          data-autofocus
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("admin.items.searchHint")}
          className="field w-full"
          autoComplete="off"
          enterKeyHint="search"
        />
      </div>
      <ul aria-label={t("admin.items.results")} className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2">
        {shown.map((i) => {
          const on = selected?.(i.name) ?? false;
          return (
            <li key={i.name}>
              <button
                type="button"
                onClick={() => onPick(i.name)}
                aria-pressed={single ? on : undefined}
                title={i.label}
                className={`press relative flex h-21 w-full flex-col items-center justify-center gap-1 rounded-[3px] px-1 ${on ? "slot-selected" : "slot"}`}
              >
                <ItemIcon name={i.name} size={26} iconSize={40} className="text-label" />
                <span className="line-clamp-2 w-full text-center text-[0.6875rem] leading-tight text-bone">{i.label}</span>
                {badge?.(i.name)}
              </button>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && <p className="text-sm text-ash">{t("admin.items.none")}</p>}
    </>
  );
}
