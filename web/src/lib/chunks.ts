// After a deploy, a tab that still runs the old build asks for hashed chunks
// that are gone. The import fails; instead of letting React unmount the whole
// page, the tab reloads once to pick up the new build.

import { lazy, type ComponentType } from "react";

const KEY = "skald.chunkReload";
/** A second chunk failure this soon after a reload is not a stale build: show the error instead of looping. */
const GUARD_MS = 60_000;

/**
 * The page reload, swappable in tests (jsdom cannot reload). `reloading` is set
 * once this page asked for one, so a second failing chunk waits for it instead
 * of showing an error.
 */
export const page = { reload: () => window.location.reload(), reloading: false };

/** True for the errors browsers and Vite throw when a lazy chunk or its CSS cannot be loaded. */
export function isChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /dynamically imported module|Importing a module script failed|module script|valid JavaScript MIME type|Unable to preload CSS|ChunkLoadError/i.test(msg);
}

/**
 * Reloads the page unless it already did so in the last minute (kept in
 * sessionStorage, so per tab) or the device is offline, where a reload would
 * not fetch a new build. Returns whether a reload is under way.
 */
export function reloadOnce(now = Date.now()): boolean {
  if (page.reloading) return true;
  if (navigator.onLine === false) return false;
  try {
    const last = Number(sessionStorage.getItem(KEY));
    if (last && now - last < GUARD_MS) return false;
    sessionStorage.setItem(KEY, String(now));
  } catch {
    // No sessionStorage, no loop guard: do not reload.
    return false;
  }
  page.reloading = true;
  page.reload();
  return true;
}

/**
 * `React.lazy` that reloads the page once when the chunk is missing. While the
 * reload is under way it stays suspended; if the guard blocks it, the error
 * reaches the nearest error boundary.
 */
export function lazyChunk<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  return lazy(() =>
    load().catch((err: unknown) => {
      if (isChunkError(err) && reloadOnce()) return new Promise<never>(() => undefined);
      throw err;
    }),
  );
}

/** Warms a chunk on hover; a failure here is not worth a reload or a console error. */
export const preload = (load: () => Promise<unknown>) => {
  load().catch(() => undefined);
};
