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
  /** Modules this page fetched again with an ordinary request, so WebKit dropped their failure: once is enough. */
  warmed: new Set<string>(),
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

/** The entry module and its static imports, already named by the built HTML. */
function entryModuleUrls(): string[] {
  if (typeof document === "undefined") return [];
  const hrefs = [
    ...[...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((s) => s.src),
    ...[...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"][href]')].map((l) => l.href),
  ];
  return [...new Set(hrefs.flatMap((href) => {
    const url = new URL(href, location.href);
    return url.origin === location.origin ? [`${url.pathname}${url.search}`] : [];
  }))];
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
 * browser blamed if it said), their imports, and this page's entry modules are
 * fetched again too.
 */
export async function recoverChunk(urls: readonly (string | undefined)[]): Promise<Recovery> {
  if (navigator.onLine === false) return "down";
  const named = [...new Set(urls.filter((u): u is string => !!u))];
  if (!named.length) return reloadOnce() ? "reloading" : "stale";
  const probes = await Promise.all(named.map(probeChunk));
  if (probes.includes("down")) return "down";
  if (probes.includes("gone")) return reloadOnce() ? "reloading" : "stale";
  // WebKit reuses a failed module script, the entry's and each one it imports,
  // even across a reload, until an ordinary request for the same URL succeeds;
  // the no-store probe does not count. Once per page is enough.
  const all = [...new Set([...named, ...named.flatMap(chunkDeps), ...entryModuleUrls()])].filter((u) => !page.warmed.has(u));
  const warmed = await Promise.all(
    all.map(async (u) => {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return false;
        page.warmed.add(u);
        return true;
      } catch {
        return false;
      }
    }),
  );
  // Reloading while WebKit still holds a failed entry-module load leaves the
  // whole app blank. Keep the recovery note up and retry when any warm-up fails.
  if (warmed.some((ok) => !ok)) return "down";
  if (reloadOnce()) return "reloading";
  return reloadBlock() === "spent" ? "spent" : "held";
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

/** Warms a chunk on hover; a failure here is not worth a reload or a console error. */
export const preload = (load: () => Promise<unknown>) => {
  load().catch(() => undefined);
};
