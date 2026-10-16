// Material tones for the floor plans, from the operator's own item icons
// (skald-icons): a piece's building material is read from its prefab name,
// and the material's tone is the average colour of the icon of the item it is
// built from (Wood, Stone, Black marble, ...). Nothing here ships game art;
// without an icon sheet, or for a material whose item it lacks, the plans keep
// their fixed parchment colours.

import type { IconSheet } from "./itemicons";

export type Material = "wood" | "corewood" | "stone" | "iron" | "blackmarble" | "grausten" | "ashwood";

export type Rgb = [number, number, number];

/**
 * The item each material is built from, by its prefab name in the icon map.
 * Darkwood, stave and turf have no item that looks like the piece (fine wood
 * is pale, tar is black), so they keep the fixed colours.
 */
export const MATERIAL_ITEMS: Record<Material, string> = {
  wood: "Wood",
  corewood: "RoundLog",
  stone: "Stone",
  iron: "Iron",
  blackmarble: "BlackMarble",
  grausten: "Grausten",
  ashwood: "Blackwood",
};

/** A build piece's material from its prefab name, or null when it has no tone of its own. */
export function pieceMaterial(name: string): Material | null {
  const n = name.toLowerCase();
  if (/^wood_(wall_log|pole_log|log_)/.test(n)) return "corewood";
  if (n.startsWith("woodiron_") || n.startsWith("iron_")) return "iron";
  if (n.startsWith("wood_") || n === "woodwall" || n === "stake_wall" || n === "piece_sharpstakes") return "wood";
  if (n.startsWith("stone_")) return "stone";
  if (n.startsWith("blackmarble_")) return "blackmarble";
  if (n.startsWith("piece_grausten")) return "grausten";
  if (n.startsWith("ashwood_")) return "ashwood";
  return null;
}

/** The average colour of an icon's RGBA pixels, weighted by opacity; null for an empty icon. */
export function averageTone(px: ArrayLike<number>): Rgb | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    const a = px[i + 3]!;
    // Soft edges blend into the transparent background: only the solid body counts.
    if (a < 128) continue;
    r += px[i]! * a;
    g += px[i + 1]! * a;
    b += px[i + 2]! * a;
    w += a;
  }
  return w ? [Math.round(r / w), Math.round(g / w), Math.round(b / w)] : null;
}

/** `a` moved towards `b` by `t` (0..1). */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as Rgb;
}

export const rgba = (c: Rgb, alpha: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;

/** Each material's tone from a decoded icon sheet; empty when the browser will not read it back. */
export function materialTones(img: CanvasImageSource, sheet: IconSheet): Map<Material, Rgb> {
  const out = new Map<Material, Rgb>();
  if (typeof document === "undefined") return out;
  const size = sheet.size;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return out;
  for (const [m, item] of Object.entries(MATERIAL_ITEMS) as [Material, string][]) {
    const at = sheet.items[item];
    if (!at) continue;
    try {
      g.clearRect(0, 0, size, size);
      g.drawImage(img, at[0], at[1], size, size, 0, 0, size, size);
      const tone = averageTone(g.getImageData(0, 0, size, size).data);
      if (tone) out.set(m, tone);
    } catch {
      // a tainted or undecodable sheet: no tones, the fixed colours stay
      return new Map();
    }
  }
  return out;
}
