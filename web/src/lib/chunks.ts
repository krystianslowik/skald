// After a deploy, a tab that still runs the old build asks for hashed chunks
// that are gone. The import fails; instead of letting React unmount the whole
// page, the tab reloads once to pick up the new build.
//
// A chunk can also fail because the device is offline or the server is down.
// Browsers keep a failed `import()` for the life of the page (WebKit even past
// a reload), so asking again for the same URL never reaches the network. The
// built page publishes each lazy chunk's URL and the chunks it imports
// (i18n/preload.ts), which lets a failure be told apart (gone after a deploy,
// or unreachable) and fetched again, dependencies included.

import { lazy, type ComponentType } from "react";
import { CHUNK_DEPS_GLOBAL, CHUNKS_GLOBAL } from "../i18n/preload";

const KEY = "skald.chunkReload";
/** A second chunk failure this soon after a reload is not a stale build: show the error instead of looping. */
const GUARD_MS = 60_000;
/** At most this many chunk reloads per tab in `SPENT_MS`, so a chunk that keeps failing cannot reload the page every minute. */
const MAX_RELOADS = 2;
const SPENT_MS = 5 * 60_000;

/**
 * The page reload, swappable in tests (jsdom cannot reload). `reloading` is set
 * once this page asked for one, so a second failing chunk waits for it instead
 * of showing an error.
 */
export const page = {
  reload: () => window.location.reload(),
  reloading: false,
};

/**
 * A lazy chunk that could not be loaded while the device was offline or the
 * server could not be reached (`reason` "net"). The boundary says so (not
 * "Skald was updated") and reloads once the chunk can be fetched again.
 * "held": the server has the chunk, so this build is current, but a reload
 * just happened; the boundary keeps checking and reloads once the loop guard
 * allows. "spent": the same, but this tab already reloaded as often as it may.
 */
export class ChunkOffline extends Error {
  /** When it was thrown. */
  readonly at = Date.now();
  /** `probed`: the server was asked and did not answer (the device looked online), or answered ("held", "spent"). */
  constructor(
    readonly urls: readonly string[],
    readonly probed = false,
    readonly reason: "net" | "held" | "spent" = "net",
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

const published = (global: string, key: string): unknown => {
  const map = (globalThis as Record<string, unknown>)[global];
  return map && typeof map === "object" ? (map as Record<string, unknown>)[key] : undefined;
};

/** A lazy chunk's URL in the running build (`MapView`, `en`), or undefined under `vite` dev and in tests. */
export function chunkUrl(name: string): string | undefined {
  const url = published(CHUNKS_GLOBAL, name);
  return typeof url === "string" ? url : undefined;
}

/** The URLs of the chunks a lazy chunk imports (MapView: the map canvas, the shared sheet code...), empty when none or unknown. */
export function chunkDeps(url: string): string[] {
  const deps = published(CHUNK_DEPS_GLOBAL, url);
  return Array.isArray(deps) ? deps.filter((d): d is string => typeof d === "string") : [];
}

/**
 * The page's own scripts and styles (`/assets/...`): the entry, the chunks the
 * HTML preloads, and the ones Vite's import helper added since (it adds a
 * `modulepreload` link for every chunk a lazy one imports).
 */
export function pageAssets(): string[] {
  const out = new Set<string>();
  for (const el of document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[type="module"][src], link[rel="modulepreload"][href], link[rel="stylesheet"][href]')) {
    try {
      const u = new URL(el instanceof HTMLScriptElement ? el.src : el.href, location.href);
      if (u.origin === location.origin && u.pathname.startsWith("/assets/")) out.add(u.pathname);
    } catch {
      // Not a URL: nothing to fetch.
    }
  }
  return [...out];
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
 * What `recoverChunk` did: "reloading"; "down" (offline, or the server did not
 * answer); "held" (the server has the chunks, so the build is current, but a
 * reload just happened: try again in a minute); "spent" (the same, but this tab
 * already reloaded as often as it may: stop trying); "stale" (the chunk is
 * gone or unknown and the reload was held back).
 */
export type Recovery = "reloading" | "down" | "held" | "spent" | "stale";

/**
 * After a chunk failed: reloads the page (once, see `reloadOnce`) if that can
 * help, that is, the device is online and the server answers. `urls`: the
 * chunks the failed import named (the lazy chunk, and the dependency the
 * browser blamed if it said); the chunks they import are fetched again too.
 */
export async function recoverChunk(urls: readonly (string | undefined)[]): Promise<Recovery> {
  if (navigator.onLine === false) return "down";
  const named = [...new Set(urls.filter((u): u is string => !!u))];
  // No chunk named (WebKit does not say, and the build may not list it): ask
  // for the page's own scripts instead. The entry imports every lazy chunk by
  // its hashed name, so an entry still on the server means this build is current.
  const probed = named.length ? named : pageAssets();
  if (!probed.length) return reloadOnce() ? "reloading" : "stale";
  const probes = await Promise.all(probed.map(probeChunk));
  if (probes.includes("down")) return "down";
  if (probes.includes("gone")) return reloadOnce() ? "reloading" : "stale";
  // WebKit reuses a failed module script, the entry's and each one it imports,
  // even across a reload, until an ordinary request for the same URL succeeds;
  // the no-store probe does not count. A lazy import also fails the page's own
  // scripts it asks for again (Vite preloads every chunk it imports, the entry
  // included), so those are fetched too. A reload before all of them answered
  // would leave a blank page: keep the note and try again later instead.
  const warm = await warmAll([...probed, ...named.flatMap(chunkDeps), ...pageAssets()]);
  if (warm === "down") return "down";
  // One of the page's own scripts is gone from the server: a deploy changed it, though not the lazy chunk.
  if (warm === "gone") return reloadOnce() ? "reloading" : "stale";
  if (reloadOnce()) return "reloading";
  return reloadBlock() === "spent" ? "spent" : "held";
}

/**
 * Fetches each URL with an ordinary request (the kind WebKit needs before it
 * stops reusing a failed module script): "down" if any got no answer, else
 * "gone" if any answered with an error, else "ok".
 */
async function warmAll(urls: readonly string[]): Promise<"ok" | "gone" | "down"> {
  const res = await Promise.all(
    [...new Set(urls)].map((u) =>
      fetch(u, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).then(
        (r) => (r.ok ? "ok" : "gone"),
        () => "down",
      ),
    ),
  );
  return res.includes("down") ? "down" : res.includes("gone") ? "gone" : "ok";
}

/** This tab's recent chunk reloads (sessionStorage); throws without sessionStorage. A time ahead of the clock (it was set back) is dropped. */
function recentReloads(now: number): number[] {
  const raw = sessionStorage.getItem(KEY) ?? "";
  return raw
    .split(",")
    .map(Number)
    .filter((t) => t > 0 && t <= now && now - t < SPENT_MS);
}

/**
 * Why `reloadOnce` would not reload now: "wait" (one happened in the last
 * minute), "spent" (as many as five minutes allow, or no sessionStorage to
 * count them in), or null when it may.
 */
export function reloadBlock(now = Date.now()): "wait" | "spent" | null {
  try {
    const recent = recentReloads(now);
    if (recent.length >= MAX_RELOADS) return "spent";
    return recent.some((t) => now - t < GUARD_MS) ? "wait" : null;
  } catch {
    return "spent";
  }
}

/**
 * Reloads the page unless it already did so in the last minute, or twice in
 * the last five (kept in sessionStorage, so per tab), or the device is
 * offline, where a reload would not fetch a new build. Returns whether a
 * reload is under way.
 */
export function reloadOnce(now = Date.now()): boolean {
  if (page.reloading) return true;
  if (navigator.onLine === false) return false;
  if (reloadBlock(now)) return false;
  try {
    sessionStorage.setItem(KEY, [...recentReloads(now), now].join(","));
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
 * reaches the nearest error boundary. Offline, with the server down, or with
 * the chunk still on the server (not a new build) it throws `ChunkOffline`
 * instead, and the boundary reloads once that can help.
 * `name` is the module's file name (`MapView`), how the build lists its URL.
 */
export function lazyChunk<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, name: string) {
  return lazy(() =>
    load().catch(async (err: unknown) => {
      if (!isChunkError(err)) throw err;
      // The chunk that failed may be one this one imports; the error names it where the browser says.
      const urls = [failedChunkUrl(err), chunkUrl(name)].filter((u): u is string => !!u);
      const r = await recoverChunk(urls);
      if (r === "reloading") return new Promise<never>(() => undefined);
      if (r === "down") throw new ChunkOffline(urls, navigator.onLine !== false);
      // Still on the server: not a new build, whatever the browser says. Retry once the guard allows.
      if (r === "held" || r === "spent") throw new ChunkOffline(urls, true, r);
      throw err;
    }),
  );
}

/**
 * Warms a chunk ahead of use; a failure here is not worth a reload or a console
 * error. Offline it does nothing: the browser would keep the failed import, and
 * the real one, once back online, would fail with it and reload the page.
 */
export const preload = (load: () => Promise<unknown>) => {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  load().catch(() => undefined);
};

/** An idle callback that does not come within this time runs anyway (a busy page). */
const IDLE_TIMEOUT_MS = 5000;
/** Where the browser has no `requestIdleCallback` (Safari): run this long after the call instead. */
const IDLE_FALLBACK_MS = 2000;

/**
 * Runs `fn` once the page is idle after its first paint; returns a cancel.
 * Warming a chunk this way loads it while this build is still on the server:
 * a tab left open across a deploy then opens it from memory, instead of asking
 * for a chunk the new build removed and reloading the page.
 */
export function whenIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === "function" && typeof cancelIdleCallback === "function") {
    const id = requestIdleCallback(() => fn(), { timeout: IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, IDLE_FALLBACK_MS);
  return () => clearTimeout(id);
}
