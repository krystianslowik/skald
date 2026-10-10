import { useCallback, useEffect, useState } from "react";

/** The phone's tabs; on wider screens only `map` (the full-screen map) means anything. */
export type Tab = "fire" | "map" | "saga" | "settings";
export const TABS: readonly Tab[] = ["fire", "map", "saga", "settings"];

const fromHash = (h: string): Tab => {
  const t = h.replace(/^#/, "");
  return t === "map" || t === "saga" || t === "settings" ? t : "fire";
};

type Pushed = { skaldMap?: boolean; skaldTab?: boolean } | null;
const ours = () => {
  const s = history.state as Pushed;
  return !!(s?.skaldMap || s?.skaldTab);
};

/**
 * Tabs as URL hashes, so Back works the way phones expect: from any tab Back
 * returns to the fire, and from the fire it leaves. Moving between tabs
 * replaces the entry instead of stacking them.
 */
export function useRoute(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => (typeof location === "undefined" ? "fire" : fromHash(location.hash)));
  useEffect(() => {
    const sync = () => setTab(fromHash(location.hash));
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  const go = useCallback((next: Tab) => {
    const here = fromHash(location.hash);
    if (next === here) return;
    if (next === "fire") {
      // Pushed from here: Back pops it. Landed on a tab directly: drop the hash in place.
      if (ours()) history.back();
      else history.replaceState(null, "", location.pathname + location.search);
    } else {
      const state = next === "map" ? { skaldMap: true } : { skaldTab: true };
      if (here === "fire") history.pushState(state, "", `#${next}`);
      else history.replaceState(ours() ? state : null, "", `#${next}`);
    }
    setTab(next);
  }, []);
  return [tab, go];
}
