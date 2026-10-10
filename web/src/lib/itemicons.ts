// Item icons from the operator's own game files (skald-icons, opt-in). The
// agent says which game build its sheet is from (`state.icons.build`); the
// map of where each item sits is fetched once per build and the sheet image
// is decoded once, before any icon switches over, so slots never flash empty.
// Without a sheet, or for an item it lacks, ItemIcon draws the category glyph.

import { useSyncExternalStore, type CSSProperties } from "react";
import type { IconMap, IconsInfo } from "../types";

export interface IconSheet {
  url: string;
  size: number;
  width: number;
  height: number;
  items: Record<string, [number, number]>;
}

let sheet: IconSheet | null = null;
/** The build being loaded or shown; null when there is none. */
let wanted: string | null = null;
const subs = new Set<() => void>();

function publish(next: IconSheet | null): void {
  sheet = next;
  for (const f of subs) f();
}

function isIconMap(x: unknown): x is IconMap {
  const m = x as Partial<IconMap> | null;
  return (
    !!m &&
    typeof m === "object" &&
    typeof m.build === "string" &&
    [m.size, m.width, m.height].every((n) => typeof n === "number" && n > 0) &&
    !!m.items &&
    typeof m.items === "object"
  );
}

/** Follow the agent's icon build: a new one loads its map and sheet; none clears them. */
export function setIconBuild(info: IconsInfo | null | undefined): void {
  const build = info?.available && info.build ? info.build : null;
  if (build === wanted) return;
  wanted = build;
  if (!build) {
    if (sheet) publish(null);
    return;
  }
  const failed = () => {
    // Let the next state update try again.
    if (wanted === build) wanted = null;
  };
  fetch("/api/icons/map.json", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((doc: unknown) => {
      if (wanted !== build) return;
      if (!isIconMap(doc)) return failed();
      const url = `/api/icons/sheet.webp?v=${encodeURIComponent(doc.build)}`;
      const next: IconSheet = { url, size: doc.size, width: doc.width, height: doc.height, items: doc.items };
      if (typeof Image === "undefined") return publish(next);
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (wanted === build) publish(next);
      };
      img.onerror = failed;
      img.src = url;
    })
    .catch(failed);
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function useIconSheet(): IconSheet | null {
  return useSyncExternalStore(
    subscribe,
    () => sheet,
    () => null,
  );
}

/**
 * The CSS that shows one item's cell, scaled to whatever box it is drawn in:
 * size and position are in percent of the box, so the same style is sharp at
 * 20 px and at 40 px, on 1x and 3x screens (the cells are 64 px).
 */
export function iconCellStyle(s: IconSheet, name: string): CSSProperties | null {
  const at = s.items[name];
  if (!at) return null;
  const pct = (v: number, total: number) => (total > s.size ? (v / (total - s.size)) * 100 : 0);
  return {
    backgroundImage: `url("${s.url}")`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${(s.width / s.size) * 100}% ${(s.height / s.size) * 100}%`,
    backgroundPosition: `${pct(at[0], s.width)}% ${pct(at[1], s.height)}%`,
  };
}

/** Tests only: put a sheet in place without a network. */
export function setIconSheetForTest(s: IconSheet | null): void {
  wanted = s ? "test" : null;
  publish(s);
}
