import { useReducedMotion } from "motion/react";
import { useCallback, useSyncExternalStore } from "react";
import { boolPref } from "./boolpref";

const pref = boolPref("skald_embers");

/**
 * The rising embers behind the page, on or off. Remembered per browser; until
 * someone chooses, they follow the system: off when it asks for reduced motion.
 */
export function useEmbers(): { on: boolean; toggle: () => void } {
  const stored = useSyncExternalStore(pref.subscribe, pref.read, () => null);
  const reduced = useReducedMotion() ?? false;
  const on = stored ?? !reduced;
  const toggle = useCallback(() => pref.write(!on), [on]);
  return { on, toggle };
}
