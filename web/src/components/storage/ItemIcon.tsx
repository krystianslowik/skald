import { iconCellStyle, useIconSheet } from "../../lib/itemicons";
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
 * Every item visual goes through here: the item's own icon when the server
 * has an icon sheet (made from the operator's game files) that holds it, else
 * its category glyph. `iconSize` is the icon's edge; icons carry more detail
 * than glyphs, so they usually get a little more room.
 */
export function ItemIcon({
  name,
  type,
  category,
  size = 20,
  iconSize = size,
  className = "",
}: {
  name: string;
  type?: string;
  /** The glyph's category when the caller already knows it. */
  category?: Category;
  size?: number;
  iconSize?: number;
  className?: string;
}) {
  const sheet = useIconSheet();
  const style = sheet ? iconCellStyle(sheet, name) : null;
  if (!style) return <ItemGlyph category={category ?? itemCategory(name, type)} size={size} className={className} />;
  return <span aria-hidden data-item-icon={name} className={`inline-block shrink-0 ${className}`} style={{ ...style, width: iconSize, height: iconSize }} />;
}
