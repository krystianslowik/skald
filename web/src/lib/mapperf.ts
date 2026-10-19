import { useCallback, useSyncExternalStore } from "react";
import { boolPref } from "./boolpref";

// The map's performance mode, per browser: on, the terrain is drawn with the
// plain shader (no close-zoom grain, rock or contours) and the woods without
// a canopy, for weak phones. Off until someone turns it on.

const pref = boolPref("skald_map_perf");

/** Whether performance mode is on. */
export const mapPerf = (): boolean => pref.read() ?? false;

export const setMapPerf = (on: boolean): void => pref.write(on);

/** Performance mode and its switch. */
export function useMapPerf(): { on: boolean; toggle: () => void } {
  const on = useSyncExternalStore(pref.subscribe, mapPerf, () => false);
  const toggle = useCallback(() => setMapPerf(!on), [on]);
  return { on, toggle };
}
