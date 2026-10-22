import { useCallback, useEffect, useRef, useState } from "react";
import { leaveSheets, noteEntries, sheetPending, traverse } from "./sheetHistory";
import { isAdminHash } from "./adminTabs";

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
 * replaces the entry instead of stacking them. Open sheets hold entries of
 * their own on top (lib/sheetHistory); a tab change steps back over them first.
 */
export function useRoute(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => (typeof location === "undefined" ? "fire" : fromHash(location.hash)));
  // A tab tapped while sheets are still being stepped over; a later tap supersedes it.
  const deferred = useRef<Tab | null>(null);
  const shown = useRef(tab);
  shown.current = tab;
  useEffect(() => {
    // While a tap steps back over sheets, the hash is the tab under them: showing it
    // would close the map for a render (dropping its focus). The tap lands the tab itself.
    const sync = () => {
      if (deferred.current !== null && sheetPending()) return;
      // The admin sheet's address (`#admin/...`, on its own history entry) sits over the tab, not instead of it.
      if (isAdminHash(location.hash)) return;
      setTab(fromHash(location.hash));
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  const go = useCallback((next: Tab) => {
    // Under the admin sheet's address the tab is the one showing.
    const at = () => (isAdminHash(location.hash) ? shown.current : fromHash(location.hash));
    if (next === (deferred.current ?? at())) return;
    const move = () => {
      if (deferred.current !== null && deferred.current !== next) return;
      deferred.current = null;
      const here = at();
      if (next === here) return setTab(next);
      if (next === "fire") {
        // Pushed from here: Back pops it. Landed on a tab directly: drop the hash in place.
        if (ours()) traverse(-1);
        else history.replaceState(null, "", location.pathname + location.search);
      } else {
        const state = next === "map" ? { skaldMap: true } : { skaldTab: true };
        if (here === "fire") {
          history.pushState(state, "", `#${next}`);
          noteEntries();
        }
        else history.replaceState(ours() ? state : null, "", `#${next}`);
      }
      setTab(next);
    };
    deferred.current = next;
    if (!leaveSheets(move)) move();
    // Shown at once; the history catches up once the sheets are stepped over.
    else setTab(next);
  }, []);
  return [tab, go];
}
