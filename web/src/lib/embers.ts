import { useReducedMotion } from "motion/react";
import { useCallback, useSyncExternalStore } from "react";

const PREF_KEY = "skald_embers";
const listeners = new Set<() => void>();
/** The choice for this visit when storage refused it (private mode, full); wins over what is stored. */
let memory: boolean | null = null;

function read(): boolean | null {
  if (memory !== null) return memory;
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

const notify = () => {
  for (const l of listeners) l();
};

/** Another tab changed it. */
const onStorage = (e: StorageEvent) => {
  if (e.key === PREF_KEY || e.key === null) notify();
};

function write(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
    memory = null;
  } catch {
    // blocked storage: `memory` keeps it until the page closes
    memory = on;
  }
  notify();
}

function subscribe(fn: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

/**
 * The rising embers behind the page, on or off. Remembered per browser; until
 * someone chooses, they follow the system: off when it asks for reduced motion.
 */
export function useEmbers(): { on: boolean; toggle: () => void } {
  const stored = useSyncExternalStore(subscribe, read, () => null);
  const reduced = useReducedMotion() ?? false;
  const on = stored ?? !reduced;
  const toggle = useCallback(() => write(!on), [on]);
  return { on, toggle };
}
