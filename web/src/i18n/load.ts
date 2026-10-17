// The dictionaries are ~2000 keys each, so each one is its own chunk and a
// viewer downloads only the language they read. The served index.html
// preloads the right chunk next to the app (see `localePreload` in
// vite.config.ts and the server's static.ts), so the first render does not
// wait on an extra round trip; switching language fetches the other one then.
//
// A browser keeps a failed `import()` of a URL for the page's life, so a retry
// of the same import never reaches the network. After a failure the next
// attempt imports the chunk under a fresh query (`?retry=N`); a dictionary is
// plain data with no imports of its own, so a second copy is harmless.

import { chunkUrl } from "../lib/chunks";
import type { Dict } from "./en";
import { LOCALES, type Locale } from "./locales";

export { isLocale, LOCALES, type Locale } from "./locales";

const LOADERS: Record<Locale, () => Promise<Dict>> = {
  en: () => import("./en").then((m) => m.en),
  pl: () => import("./pl").then((m) => m.pl),
};

/** Imports a chunk by URL; swappable in tests, where nothing is served. */
export const chunkImport = { load: (url: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ url) };

/** Failed attempts per language: the next one uses a URL no failure is cached under. */
const failures: Partial<Record<Locale, number>> = {};

function fetchDict(l: Locale): Promise<Dict> {
  const n = failures[l] ?? 0;
  const url = chunkUrl(l);
  // Under `vite` dev there is no built URL; its module server does not cache failures.
  if (!n || !url) return LOADERS[l]();
  return chunkImport.load(`${url}?retry=${n}`).then((m) => {
    const dict = m[l];
    if (!dict || typeof dict !== "object") throw new Error(`no ${l} dictionary in ${url}`);
    return dict as Dict;
  });
}

/** One try, and at once a second one under a fresh URL unless offline: one dropped request does not fail a load. */
function attempt(l: Locale): Promise<Dict> {
  const fail = (err: unknown): never => {
    failures[l] = (failures[l] ?? 0) + 1;
    throw err;
  };
  return fetchDict(l)
    .catch(fail)
    .catch((err: unknown) => {
      if (navigator.onLine === false || !chunkUrl(l)) throw err;
      return fetchDict(l).catch(fail);
    });
}

const loaded: Partial<Record<Locale, Dict>> = {};
const pending = new Map<Locale, Promise<Dict>>();
const listeners = new Set<() => void>();
let version = 0;

/** Puts a dictionary in place without fetching it (tests). */
export function registerLocale(l: Locale, dict: Dict): void {
  if (loaded[l] === dict) return;
  loaded[l] = dict;
  version++;
  for (const fn of listeners) fn();
}

/** The dictionary, if its chunk is in. */
export const dictFor = (l: Locale): Dict | undefined => loaded[l];

/** Fetches a language's chunk once; a failed fetch can be tried again, and fetches anew. */
export function loadLocale(l: Locale): Promise<Dict> {
  const have = loaded[l];
  if (have) return Promise.resolve(have);
  let p = pending.get(l);
  if (!p) {
    p = attempt(l).then(
      (dict) => {
        pending.delete(l);
        registerLocale(l, dict);
        return dict;
      },
      (err: unknown) => {
        pending.delete(l);
        throw err;
      },
    );
    pending.set(l, p);
  }
  return p;
}

/** Every dictionary loaded so far. */
export const loadedDicts = (): Dict[] => LOCALES.flatMap((l) => (loaded[l] ? [loaded[l]] : []));

/** Bumped each time a dictionary arrives; caches built from `loadedDicts` key on it. */
export const localesVersion = (): number => version;

export function subscribeLocales(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
