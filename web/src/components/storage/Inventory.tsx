import { memo, useId, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { CATEGORY_GLYPH, itemCategory, itemLabel, type Category } from "../../lib/storage";
import { COARSE, useMedia } from "../../lib/useMedia";
import type { MapItem } from "../../types";

/** A category's mark: an own line drawing, not the game's item icon. */
export function ItemGlyph({ category, size = 20, className = "" }: { category: Category; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`shrink-0 ${className}`}>
      <path d={CATEGORY_GLYPH[category]} />
    </svg>
  );
}

/** Quality as small stars, like the game's upgrade pips. */
function Stars({ n }: { n: number }) {
  return (
    <span aria-hidden className="absolute left-1 top-0.5 text-[0.5625rem] leading-none tracking-[-0.08em] text-gold [text-shadow:0_1px_1px_#000]">
      {"★".repeat(Math.min(5, n))}
    </span>
  );
}

const DEFAULT_GRID = { width: 5, height: 2 };

/**
 * A container's contents as the game shows them: a grid of dark slots, each
 * with the item's category mark, its name where the slot is wide enough, the
 * stack count bottom right and the quality as stars. Tapping a slot names it
 * in full below the grid with quality, durability and who made it.
 */
export const InventoryGrid = memo(function InventoryGrid({
  items,
  width,
  height,
  names = true,
}: {
  items: readonly MapItem[];
  width: number;
  height: number;
  /** Names in the slots; off where slots are too small to read (a popover). */
  names?: boolean;
}) {
  const { t, lookup, number } = useI18n();
  const coarse = useMedia(COARSE);
  const [picked, setPicked] = useState<string | null>(null);
  const detailId = useId();
  // A raft has no hold; an unknown size falls back to the plain chest's.
  const cols = Math.max(1, width || DEFAULT_GRID.width);
  const rows = Math.max(1, height || DEFAULT_GRID.height);
  const roomy = names && cols <= 6;
  const bySlot = useMemo(() => {
    const m = new Map<string, MapItem>();
    for (const it of items) m.set(`${it.x},${it.y}`, it);
    return m;
  }, [items]);
  const sel = picked ? bySlot.get(picked) : undefined;

  const cells = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const key = `${x},${y}`;
      const it = bySlot.get(key);
      if (!it) {
        cells.push(<li key={key} aria-hidden className="slot aspect-square" />);
        continue;
      }
      const label = itemLabel(it.name, lookup);
      const on = picked === key;
      cells.push(
        <li key={key}>
          <button
            type="button"
            aria-pressed={on}
            aria-describedby={on ? detailId : undefined}
            aria-label={t("inv.slot", { item: label, n: number(it.stack) })}
            title={label}
            onClick={() => setPicked(on ? null : key)}
            className={`slot press-soft relative flex aspect-square w-full flex-col items-center justify-center gap-0.5 overflow-hidden px-0.5 text-flame ${roomy ? "pb-2.5 pt-1" : "p-0.5"} ${on ? "slot-selected text-bone" : ""}`}
          >
            {it.quality && it.quality > 1 ? <Stars n={it.quality} /> : null}
            <ItemGlyph category={itemCategory(it.name, it.type)} size={roomy ? 20 : 17} className="opacity-90" />
            {roomy && <span className="line-clamp-2 w-full break-words text-center text-[0.5625rem] font-bold leading-[1.1] text-bone">{label}</span>}
            {it.stack > 1 && (
              <span className="absolute bottom-0.5 right-1 text-[0.625rem] font-bold tabular-nums leading-none text-bone [text-shadow:1px_0_0_#000,-1px_0_0_#000,0_1px_0_#000,0_-1px_0_#000]">
                {number(it.stack)}
              </span>
            )}
          </button>
        </li>,
      );
    }
  }

  return (
    <div>
      <ul aria-label={t("inv.label")} className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {cells}
      </ul>
      <p id={detailId} aria-live="polite" className="mt-2 min-h-[2.5rem] text-xs leading-snug text-ash">
        {sel ? (
          <>
            <span className="font-bold text-bone">
              {itemLabel(sel.name, lookup)}
              {sel.stack > 1 ? ` × ${number(sel.stack)}` : ""}
            </span>
            {[
              sel.quality && sel.quality > 1 ? t("inv.quality", { n: sel.quality }) : null,
              sel.durability !== undefined ? t("inv.durability", { n: number(sel.durability, 1) }) : null,
              sel.crafter ? t("inv.crafter", { name: sel.crafter }) : null,
            ]
              .filter(Boolean)
              .map((s) => (
                <span key={s}> · {s}</span>
              ))}
          </>
        ) : (
          t(coarse ? "inv.tapHint" : "inv.clickHint")
        )}
      </p>
    </div>
  );
});
