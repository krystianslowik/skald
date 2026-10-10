import { CATEGORY_GLYPH, itemCategory, type Category } from "../../lib/storage";

/** A category's mark: an own line drawing, not the game's item icon. */
export function ItemGlyph({ category, size = 20, className = "" }: { category: Category; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`shrink-0 ${className}`}>
      <path d={CATEGORY_GLYPH[category]} />
    </svg>
  );
}

/**
 * Every item visual goes through here. For now it draws the item's category
 * glyph; real item icons are plugged in by changing only this component.
 */
export function ItemIcon({ name, type, size = 20, className = "" }: { name: string; type?: string; size?: number; className?: string }) {
  return <ItemGlyph category={itemCategory(name, type)} size={size} className={className} />;
}
