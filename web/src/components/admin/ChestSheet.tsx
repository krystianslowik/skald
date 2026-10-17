import { useState } from "react";
import type { MapContainer } from "../../types";
import { stackSize } from "../../lib/admin";
import { chestRoom, MAX_CHEST_ADD, notePending, usePendingItems, type ChestAddResult } from "../../lib/chestadd";
import { failText, isNotPickedUp } from "../../lib/refusal";
import { itemLabel } from "../../lib/storage";
import { useI18n } from "../../i18n";
import { Sheet } from "../Sheet";
import { ItemIcon } from "../storage/ItemIcon";
import { containerTitle } from "../storage/VillageStores";
import { useAdmin } from "./AdminContext";
import { ItemSearch } from "./ItemPicker";
import { AdminHead, Btn, Stepper } from "./parts";

/**
 * Add item to one chest of the map: pick an item and an amount (with a guess
 * of what fits; the bridge refuses more and says how many), and it goes into
 * the chest in the running game. The map keeps the last
 * save's contents, so the added slots are shown as pending until the next
 * save (lib/chestadd).
 */
export function ChestSheet({ chest, onClose }: { chest: MapContainer; onClose: () => void }) {
  const i18n = useI18n();
  const { t, lookup, number } = i18n;
  const admin = useAdmin();
  const items = usePendingItems(chest) ?? chest.items;
  const [item, setItem] = useState<string | null>(null);
  const [amount, setAmount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last try timed out, so it may have gone in: the button then says "again".
  const [uncertain, setUncertain] = useState(false);

  // A guess: the web knows stack sizes only roughly, the bridge knows them
  // exactly and answers how many fit when it is fewer.
  const room = item ? chestRoom(chest, items, item) : 0;
  const pick = (name: string) => {
    navigator.vibrate?.(6);
    setError(null);
    setItem(name);
    setUncertain(false);
    setAmount(Math.max(1, Math.min(chestRoom(chest, items, name) || 1, stackSize(name) > 1 ? 10 : 1)));
  };

  const title = containerTitle(chest, t, lookup);
  const what = (n: number, name: string) => t("map.cluster.stack", { n: number(n), item: itemLabel(name, lookup) });
  const blocked = !!admin?.blocker;

  const send = async () => {
    if (!admin || !item || busy) return;
    setBusy(true);
    setError(null);
    const res = await admin.run("chest-add", { prefab: chest.prefab, at: { x: chest.x, y: chest.y ?? 0, z: chest.z }, item, amount }, { quiet: true });
    setBusy(false);
    if (res.needsAdmin) return;
    if (!res.ok) {
      // A 504 may mean the items went in, unless the bridge says the game never took the command.
      const timedOut = res.status === 504 && !isNotPickedUp(res.error);
      const msg = timedOut ? t("admin.chest.timeout") : failText(i18n, res);
      setUncertain(timedOut);
      setError(msg);
      navigator.vibrate?.([30, 40, 30]);
      return;
    }
    const d = (res.data ?? {}) as Partial<ChestAddResult>;
    const added = Array.isArray(d.slots) ? d.slots.reduce((n, s) => n + (Number(s.added) || 0), 0) : amount;
    if (Array.isArray(d.slots)) notePending(chest, item, d.slots);
    admin.toast(true, `${t("admin.chest.added", { what: what(added, item), chest: title })} ${d.loaded ? t("admin.chest.live") : t("admin.chest.unloaded")}`);
    onClose();
  };

  return (
    <Sheet
      labelledBy="chest-h"
      onClose={onClose}
      width="sm:w-136"
      header={(close) => (
        <AdminHead
          id="chest-h"
          kicker={t("admin.kicker")}
          title={t("admin.chest.title")}
          sub={t("admin.chest.sub", { chest: title, x: Math.round(chest.x), z: Math.round(chest.z) })}
          emblem={<ItemIcon name={item ?? "Wood"} size={34} iconSize={40} className="text-flame" />}
          onClose={close}
        />
      )}
      footer={
        <div className="material shrink-0 border-t border-iron/50 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-7">
          {error && (
            <p role="alert" className="mb-2 text-sm text-blood">
              {error}
            </p>
          )}
          {item ? (
            <div className="mb-3 flex items-center gap-2">
              <span className="slot grid h-11 w-11 shrink-0 place-items-center">
                <ItemIcon name={item} size={22} iconSize={34} className="text-label" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold leading-tight text-bone">{itemLabel(item, lookup)}</span>
                <span className={`block text-xs ${room < 1 ? "text-blood" : "text-ash"}`}>{room < 1 ? t("admin.chest.full") : t("admin.chest.room", { n: number(room) })}</span>
              </span>
              <Stepper label={t("admin.items.amount")} value={amount} min={1} max={MAX_CHEST_ADD} step={amount >= 100 ? 50 : amount >= 20 ? 10 : 1} onChange={setAmount} />
            </div>
          ) : (
            <p className="mb-3 text-sm text-ash">{t("admin.chest.pick")}</p>
          )}
          <Btn primary onClick={() => void send()} disabled={!item || busy || blocked} className="w-full">
            {busy ? t("admin.chest.busy") : !item ? t("admin.chest.submitIdle") : uncertain ? t("admin.chest.again", { what: what(amount, item) }) : t("admin.chest.submit", { what: what(amount, item) })}
          </Btn>
        </div>
      }
    >
      <div className="space-y-4 pb-4">
        <p className="text-sm text-bone/90">{t("admin.chest.lead")}</p>
        <ItemSearch single onPick={pick} selected={(name) => name === item} />
      </div>
    </Sheet>
  );
}
