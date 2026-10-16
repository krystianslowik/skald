import { useEffect, useState } from "react";

/** How often relative times ("5 min ago", "2 h 10 min") refresh. */
export const TICK_MS = 15_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

/** One interval for every label on the page, running only while something listens. */
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  timer ??= setInterval(() => {
    for (const l of listeners) l();
  }, TICK_MS);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * The current time, refreshed by the shared ticker. Only the component that
 * calls it re-renders on a tick, so keep it in small leaves that print a time.
 */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => subscribe(() => setNow(Date.now())), []);
  return now;
}
