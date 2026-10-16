// The dictionaries are ~2000 keys each, so each one is its own chunk and a
// viewer downloads only the language they read. The served index.html
// preloads the right chunk next to the app (see `localePreload` in
// vite.config.ts and the server's static.ts), so the first render does not
// wait on an extra round trip; switching language fetches the other one then.

import type { Dict } from "./en";
import { LOCALES, type Locale } from "./locales";

export { isLocale, LOCALES, type Locale } from "./locales";

const LOADERS: Record<Locale, () => Promise<Dict>> = {
  en: () => import("./en").then((m) => m.en),
  pl: () => import("./pl").then((m) => m.pl),
};

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

/** Fetches a language's chunk once; a failed fetch can be tried again. */
export function loadLocale(l: Locale): Promise<Dict> {
  const have = loaded[l];
  if (have) return Promise.resolve(have);
  let p = pending.get(l);
  if (!p) {
    p = LOADERS[l]().then(
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
