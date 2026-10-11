import { useRef, type KeyboardEvent } from "react";
import { useI18n } from "../../i18n";
import type { StoreyInfo } from "../../lib/planrender";
import { useOrdinal } from "../storage/StackLevel";

/**
 * The floor switcher of the base in the frame, like the storey tabs of an
 * architect's plan: the roof on top, the ground at the bottom. A radio group:
 * arrow keys move between storeys, Home and End jump to the ground and the top.
 */
export function StoreySwitcher({ info, level, onChange }: { info: StoreyInfo; level: number; onChange: (level: number) => void }) {
  const { t } = useI18n();
  const nth = useOrdinal();
  const list = useRef<HTMLDivElement>(null);
  // Top down, as a building stands.
  const levels = Array.from({ length: info.storeys + (info.hasRoof ? 1 : 0) }, (_, i) => i).reverse();
  const label = (i: number) => (i === info.storeys ? t("map.storey.roof") : i === 0 ? t("map.storey.ground") : t("map.storey.floor", { nth: nth(i) }));
  const current = Math.min(level, levels[0]!);
  const move = (to: number) => {
    const next = Math.max(0, Math.min(levels[0]!, to));
    onChange(next);
    list.current?.querySelector<HTMLButtonElement>(`[data-level="${next}"]`)?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };
    if (e.key in step) move(current + step[e.key]!);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(levels[0]!);
    else return;
    e.preventDefault();
  };
  return (
    <div ref={list} role="radiogroup" aria-label={t("map.storeys")} onKeyDown={onKey} className="plaque flex flex-col overflow-hidden p-0.5">
      {levels.map((i) => (
        <button
          key={i}
          type="button"
          role="radio"
          data-level={i}
          aria-checked={i === current}
          tabIndex={i === current ? 0 : -1}
          onClick={() => onChange(i)}
          className={`press-soft min-h-9 min-w-10 rounded-[2px] px-2.5 text-right text-xs font-bold whitespace-nowrap coarse:min-h-11 coarse:text-sm ${i === current ? "bg-select/45 text-bone" : "text-ash hover:text-bone"}`}
        >
          {label(i)}
        </button>
      ))}
    </div>
  );
}
