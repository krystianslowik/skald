import type { IconId } from "../../lib/mapgeo";
import { ICONS } from "../../lib/mapicons";

/** A map mark as inline SVG, on a small paper disc like on the map itself. */
export function MapIcon({ icon, size = 22, dim = false }: { icon: IconId; size?: number; dim?: boolean }) {
  const def = ICONS[icon];
  return (
    <svg width={size} height={size} viewBox="-3 -3 30 30" aria-hidden className={`shrink-0 ${dim ? "opacity-50" : ""}`}>
      <circle cx="12" cy="12" r="14" fill="#e6d7b4" />
      {def.fill && <path d={def.fill} fill={def.ink} fillOpacity={0.28} />}
      <path d={def.d} fill="none" stroke={def.ink} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
