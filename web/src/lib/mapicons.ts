// Map marks: own line drawings on a 24 x 24 box, inked like the hand-drawn
// marks on a paper map. Not the game's icons. Used as canvas sprites and as
// inline SVG in the legend.

import type { IconId } from "./mapgeo";

export interface IconDef {
  /** Stroked path (round caps and joins). */
  d: string;
  /** Optional filled path drawn under the stroke. */
  fill?: string;
  /** Ink colour of this mark. */
  ink: string;
}

const INK = "#2b1d12";
const RED = "#8e2a1f";
const BLUE = "#21465f";
const PURPLE = "#4b2a52";

export const ICONS: Record<IconId, IconDef> = {
  // A longhouse: steep roof, crossed gable ends, low walls.
  base: { d: "M3 12L12 5l9 7M5 11v8h14v-8M10 19v-4h4v4M10 5.5L8 3.5M14 5.5l2-2", fill: "M3 12L12 5l9 7v7H5v-7z", ink: INK },
  // A ring of standing stone with a swirl inside.
  portal: { d: "M12 3a8 9 0 1 1 0 18a8 9 0 1 1 0-18M12 8a3.5 4 0 1 0 3 5.5", ink: BLUE },
  // A rounded headstone with a cross-mark.
  grave: { d: "M7 20V10a5 5 0 0 1 10 0v10M5 20h14M10 11l4 4M14 11l-4 4", fill: "M7 20V10a5 5 0 0 1 10 0v10z", ink: RED },
  bed: { d: "M3 18V8M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5M5.5 11.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0", ink: INK },
  // A longship: curled prow and stern, square sail.
  ship: { d: "M3 15h18l-3 4H6zM3 15c-1-2 0-4 2-4M21 15c1-2 0-4-2-4M12 15V4M8 5h8v7H8z", fill: "M8 5h8v7H8z", ink: BLUE },
  cart: { d: "M4 8h16l-2 7H6zM8 18.5a2 2 0 1 0 0.01 0M16 18.5a2 2 0 1 0 0.01 0M2 8h2", ink: INK },
  "pin-fire": { d: "M12 21c-4 0-6-3-6-6c0-4 4-6 4-10c3 2 4 4 3 7c2-1 3-2 3-4c2 2 2 4 2 7c0 3-2 6-6 6zM12 21c-2 0-3-1.5-3-3c0-2 2-3 2-5c2 1.5 4 3 4 5c0 1.5-1 3-3 3z", ink: RED },
  "pin-home": { d: "M4 11l8-6l8 6M6 10v9h12v-9M10 19v-5h4v5", ink: INK },
  "pin-hammer": { d: "M14 4l6 6l-3 3l-6-6zM12.5 8.5L4 17l3 3l8.5-8.5", ink: INK },
  "pin-point": { d: "M12 7a5 5 0 1 0 0.01 0", fill: "M12 9a3 3 0 1 0 0.01 0", ink: INK },
  "pin-cave": { d: "M3 20c1-8 4-13 9-13s8 5 9 13M8 20c0-4 2-7 4-7s4 3 4 7", ink: INK },
  "pin-boss": { d: "M6 6c0 4 2 6 6 6s6-2 6-6M6 6L4 3M18 6l2-3M8 13v5l4 3l4-3v-5M10 15.5h.01M14 15.5h.01", ink: RED },
  // An altar stone with two horns: where a boss is summoned.
  "loc-boss": { d: "M5 20h14M7 20v-5h10v5M8 15c-2-3-2-7 0-10M16 15c2-3 2-7 0-10M12 15V9", ink: RED },
  // A trader's bag with a coin.
  "loc-trader": { d: "M8 8h8l3 12H5zM9 8c0-2 1-4 3-4s3 2 3 4M12 12a2.5 2.5 0 1 0 0.01 0", ink: PURPLE },
  // A dark doorway in a mound.
  "loc-dungeon": { d: "M3 20c2-9 5-14 9-14s7 5 9 14M9 20v-5a3 3 0 0 1 6 0v5", fill: "M9 20v-5a3 3 0 0 1 6 0v5z", ink: PURPLE },
  // A ring of standing stones.
  "loc-start": { d: "M12 4v4M18.5 7l-2.5 3M20 14h-4M5.5 7L8 10M4 14h4M7 19l2-3M17 19l-2-3", ink: INK },
};
