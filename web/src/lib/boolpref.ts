// A yes/no preference kept per browser in localStorage, followed across tabs,
// for useSyncExternalStore. Where storage refuses a write (private mode, full)
// the choice is kept for the visit instead.

export interface BoolPref {
  /** The stored choice, or null when nobody has chosen. */
  read: () => boolean | null;
  write: (on: boolean) => void;
  subscribe: (fn: () => void) => () => void;
}

export function boolPref(key: string): BoolPref {
  const listeners = new Set<() => void>();
  /** The choice for this visit when storage refused it; wins over what is stored. */
  let memory: boolean | null = null;
  const notify = () => {
    for (const l of listeners) l();
  };
  /** Another tab changed it. */
  const onStorage = (e: StorageEvent) => {
    if (e.key === key || e.key === null) notify();
  };
  return {
    read() {
      if (memory !== null) return memory;
      try {
        const v = localStorage.getItem(key);
        return v === "1" ? true : v === "0" ? false : null;
      } catch {
        return null;
      }
    },
    write(on) {
      try {
        localStorage.setItem(key, on ? "1" : "0");
        memory = null;
      } catch {
        memory = on;
      }
      notify();
    },
    subscribe(fn) {
      if (listeners.size === 0) window.addEventListener("storage", onStorage);
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0) window.removeEventListener("storage", onStorage);
      };
    },
  };
}
