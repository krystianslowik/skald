import { useSyncExternalStore } from "react";

/** Phones: the bottom tab bar, bottom sheets and the compact header. Landscape phones count too. */
export const PHONE = "(max-width: 639px), (pointer: coarse) and (max-height: 479px)";
/** A finger, not a cursor: larger targets, no +/- zoom buttons, "tap" wording. */
export const COARSE = "(pointer: coarse)";

function subscribe(query: string) {
  return (cb: () => void) => {
    const mq = typeof window !== "undefined" ? window.matchMedia?.(query) : undefined;
    mq?.addEventListener?.("change", cb);
    return () => mq?.removeEventListener?.("change", cb);
  };
}

const subs = new Map<string, (cb: () => void) => () => void>();

export function matches(query: string): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.(query).matches ?? false);
}

/** Whether a media query matches, live. */
export function useMedia(query: string): boolean {
  let sub = subs.get(query);
  if (!sub) subs.set(query, (sub = subscribe(query)));
  return useSyncExternalStore(sub, () => matches(query), () => false);
}
