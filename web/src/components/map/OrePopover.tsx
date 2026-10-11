import { useI18n } from "../../i18n";
import { natureTint, ORE_YIELD, oreKey, type NatureItem } from "../../lib/nature";
import { ItemIcon } from "../storage/ItemIcon";

/** A tapped ore deposit: what it is, what it yields and where. */
export function OrePopover({ ore, onClose }: { ore: NatureItem; onClose: () => void }) {
  const { t, lookup } = useI18n();
  const name = lookup(oreKey(ore.species)) ?? t("map.ore.unknown");
  const item = ORE_YIELD[ore.species];
  const yields = item ? lookup(`item.${item}`) : undefined;
  return (
    <div role="dialog" aria-label={name} className="plank plank-smooth pointer-events-auto flex items-start gap-2.5 px-3.5 py-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.55)]">
      <span aria-hidden className="mt-1 h-3.5 w-3.5 shrink-0 rotate-12 rounded-[3px] border-2 border-[#20160d]" style={{ background: natureTint("ore", ore.species) }} />
      <div className="min-w-0">
        <h3 className="font-bold leading-tight text-flame">{name}</h3>
        {item && yields && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-bone">
            <ItemIcon name={item} size={14} iconSize={20} className="text-flame/80" />
            {t("map.ore.yields", { item: yields })}
          </p>
        )}
        <p className="mt-0.5 text-xs text-ash">{t("map.at", { x: Math.round(ore.x), z: Math.round(ore.z) })}</p>
      </div>
      <button type="button" onClick={onClose} aria-label={t("map.closeDetails")} className="plaque press tap -mr-1 grid h-7 w-7 shrink-0 place-items-center coarse:h-9 coarse:w-9">
        <svg width="11" height="11" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      </button>
    </div>
  );
}
