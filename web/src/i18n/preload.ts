// Build time: the inline script that the built index.html runs before the app.
// It picks the language the app will start in (the viewer's stored choice, else
// the server's SKALD_LOCALE in `<html data-locale>`) and preloads that one
// dictionary chunk, so it downloads alongside the app instead of after it.
// It also publishes every lazily loaded chunk's URL (`CHUNKS_GLOBAL`), so a
// failed load can be retried under a fresh URL or checked against the server
// (see lib/chunks.ts): browsers keep a failed `import()` for the page's life.
// With them go the chunks each one imports (`CHUNK_DEPS_GLOBAL`): WebKit keeps
// a failed dependency too, so a retry has to fetch those again as well.

import { LOCALE_STORAGE_KEY, type Locale } from "./locales.ts";

/** The `window` property holding `{ chunk name: absolute URL path }` for every lazy chunk. */
export const CHUNKS_GLOBAL = "__skaldChunks";

/** The `window` property holding `{ lazy chunk URL: [URLs of the chunks it imports] }`. */
export const CHUNK_DEPS_GLOBAL = "__skaldChunkDeps";

/** The part of a Rollup output chunk the dependency list needs. */
export interface BundleChunk {
  type: string;
  fileName: string;
  isEntry?: boolean;
  imports?: readonly string[];
}

/**
 * For each lazy chunk (absolute URL path), every chunk it imports statically,
 * directly or through another, that the page's entry does not already load:
 * those are the ones an offline import can leave failed along with it.
 */
export function lazyChunkDeps(bundle: Record<string, BundleChunk>, lazyFiles: readonly string[]): Record<string, string[]> {
  const chunks = new Map(Object.values(bundle).filter((c) => c.type === "chunk").map((c) => [c.fileName, c]));
  const closure = (roots: readonly string[]) => {
    const seen = new Set<string>();
    const walk = (f: string) => {
      for (const d of chunks.get(f)?.imports ?? []) if (!seen.has(d)) (seen.add(d), walk(d));
    };
    roots.forEach(walk);
    return seen;
  };
  const entries = [...chunks.values()].filter((c) => c.isEntry).map((c) => c.fileName);
  const loaded = new Set([...entries, ...closure(entries)]);
  const out: Record<string, string[]> = {};
  for (const f of lazyFiles) {
    const deps = [...closure([f])].filter((d) => !loaded.has(d) && d !== f).sort();
    if (deps.length) out[`/${f}`] = deps.map((d) => `/${d}`);
  }
  return out;
}

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/**
 * `chunks`: each language's built chunk, as an absolute URL path. `lazy`: every
 * lazily loaded chunk by name (the module's file name without extension).
 * `deps`: what each lazy chunk imports (`lazyChunkDeps`).
 */
export function localePreloadScript(chunks: Record<Locale, string>, lazy: Record<string, string> = {}, deps: Record<string, string[]> = {}): string {
  const m = json(chunks);
  const key = JSON.stringify(LOCALE_STORAGE_KEY);
  return (
    `(function(){window[${JSON.stringify(CHUNKS_GLOBAL)}]=${json(lazy)};window[${JSON.stringify(CHUNK_DEPS_GLOBAL)}]=${json(deps)};` +
    `var m=${m},h=document.documentElement,l=h.getAttribute("data-locale");` +
    `try{var s=localStorage.getItem(${key});if(Object.prototype.hasOwnProperty.call(m,s))l=s}catch(e){}` +
    `if(!Object.prototype.hasOwnProperty.call(m,l))return;h.lang=l;` +
    `var k=document.createElement("link");k.rel="modulepreload";k.crossOrigin="";k.href=m[l];document.head.appendChild(k)})()`
  );
}
