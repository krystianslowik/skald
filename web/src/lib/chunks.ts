// After a deploy, a tab that still runs the old build asks for hashed chunks
// that are gone. The import fails; instead of letting React unmount the whole
// page, the tab reloads once to pick up the new build.
//
// A chunk can also fail because the device is offline or the server is down.
// Browsers keep a failed `import()` for the life of the page (WebKit even past
// a reload), so asking again for the same URL never reaches the network. The
// built page publishes each lazy chunk's URL (i18n/preload.ts), which lets a
// failure be told apart (gone after a deploy, or unreachable) and fetched again.

import { lazy, type ComponentType } from "react";
import { CHUNKS_GLOBAL } from "../i18n/preload";

const KEY = "skald.chunkReload";
/** A second chunk failure this soon after a reload is not a stale build: show the error instead of looping. */
const GUARD_MS = 60_000;

/**
 * The page reload, swappable in tests (jsdom cannot reload). `reloading` is set
 * once this page asked for one, so a second failing chunk waits for it instead
 * of showing an error.
 */
export const page = { reload: () => window.location.reload(), reloading: false };

/**
 * A lazy chunk that could not be loaded while the device was offline or the
 * server could not be reached. The boundary says so (not "Skald was updated")
 * and reloads once the chunk can be fetched again.
 */
export class ChunkOffline extends Error {
  /** When it was thrown. */
  readonly at = Date.now();
  /** `probed`: the server was asked and did not answer (the device looked online). */
  constructor(
    readonly url: string | undefined,
    readonly probed = false,
  ) {
    super("ChunkLoadError: offline");
    this.name = "ChunkOffline";
  }
}

/** True for the errors browsers and Vite throw when a lazy chunk or its CSS cannot be loaded. */
export function isChunkError(err: unknown): boolean {
  if (err instanceof ChunkOffline) return true;
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /dynamically imported module|Importing a module script failed|module script|valid JavaScript MIME type|Unable to preload CSS|ChunkLoadError/i.test(msg);
}

/** A lazy chunk's URL in the running build (`MapView`, `en`), or undefined under `vite` dev and in tests. */
export function chunkUrl(name: string): string | undefined {
  const map = (globalThis as Record<string, unknown>)[CHUNKS_GLOBAL];
  const url = map && typeof map === "object" ? (map as Record<string, unknown>)[name] : undefined;
  return typeof url === "string" ? url : undefined;
}

/** A probe that gets no answer in this time counts as the server being down. */
export const PROBE_TIMEOUT_MS = 8000;

/**
 * Asks the server for a chunk that failed: "ok", "gone" (any other answer: a
 * 404 after a deploy, an error page, a redirect to a login), or "down" (no
 * answer in time: offline or the server is down). `no-store` keeps the browser
 * cache and the service worker out of it (sw.js passes such requests on).
 */
export async function probeChunk(url: string): Promise<"ok" | "gone" | "down"> {
  try {
    const res = await fetch(url, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok ? "ok" : "gone";
  } catch {
    return "down";
  }
}

/** The chunk a failed import names (Chromium and Firefox say which), else undefined (WebKit does not). */
export function failedChunkUrl(err: unknown): string | undefined {
  const m = /(https?:\/\/[^\s'"]+\/assets\/[^\s'"?#]+\.js)/.exec(err instanceof Error ? err.message : "");
  if (!m?.[1]) return undefined;
  try {
    const u = new URL(m[1]);
    return u.origin === location.origin ? u.pathname : undefined;
  } catch {
    return undefined;
  }
}

/**
 * After a chunk failed: reloads the page (once, see `reloadOnce`) if that can
 * help, that is, the device is online and the server answers. Resolves to
 * whether a reload is under way, "down" when the server cannot be reached.
 */
export async function recoverChunk(url: string | undefined): Promise<boolean | "down"> {
  if (navigator.onLine === false) return "down";
  if (url) {
    const r = await probeChunk(url);
    if (r === "down") return "down";
    // WebKit reuses a failed module script even across a reload until an ordinary
    // request for the same URL succeeds; the no-store probe does not count.
    if (r === "ok") await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).catch(() => undefined);
  }
  return reloadOnce();
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
 * reaches the nearest error boundary. Offline or with the server down it
 * throws `ChunkOffline` instead, and the boundary reloads once it is back.
 * `name` is the module's file name (`MapView`), how the build lists its URL.
 */
export function lazyChunk<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, name: string) {
  return lazy(() =>
    load().catch(async (err: unknown) => {
      if (!isChunkError(err)) throw err;
      // The chunk that failed may be one this one imports; the error names it where the browser says.
      const url = failedChunkUrl(err) ?? chunkUrl(name);
      const r = await recoverChunk(url);
      if (r === "down") throw new ChunkOffline(url, navigator.onLine !== false);
      if (r) return new Promise<never>(() => undefined);
      throw err;
    }),
  );
}

/** Warms a chunk on hover; a failure here is not worth a reload or a console error. */
export const preload = (load: () => Promise<unknown>) => {
  load().catch(() => undefined);
};
