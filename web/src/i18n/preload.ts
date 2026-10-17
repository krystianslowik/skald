// Build time: the inline script that the built index.html runs before the app.
// It picks the language the app will start in (the viewer's stored choice, else
// the server's SKALD_LOCALE in `<html data-locale>`) and preloads that one
// dictionary chunk, so it downloads alongside the app instead of after it.
// It also publishes every lazily loaded chunk's URL (`CHUNKS_GLOBAL`), so a
// failed load can be retried under a fresh URL or checked against the server
// (see lib/chunks.ts): browsers keep a failed `import()` for the page's life.

import { LOCALE_STORAGE_KEY, type Locale } from "./locales.ts";

/** The `window` property holding `{ chunk name: absolute URL path }` for every lazy chunk. */
export const CHUNKS_GLOBAL = "__skaldChunks";

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/**
 * `chunks`: each language's built chunk, as an absolute URL path. `lazy`: every
 * lazily loaded chunk by name (the module's file name without extension).
 */
export function localePreloadScript(chunks: Record<Locale, string>, lazy: Record<string, string> = {}): string {
  const m = json(chunks);
  const key = JSON.stringify(LOCALE_STORAGE_KEY);
  return (
    `(function(){window[${JSON.stringify(CHUNKS_GLOBAL)}]=${json(lazy)};` +
    `var m=${m},h=document.documentElement,l=h.getAttribute("data-locale");` +
    `try{var s=localStorage.getItem(${key});if(Object.prototype.hasOwnProperty.call(m,s))l=s}catch(e){}` +
    `if(!Object.prototype.hasOwnProperty.call(m,l))return;h.lang=l;` +
    `var k=document.createElement("link");k.rel="modulepreload";k.crossOrigin="";k.href=m[l];document.head.appendChild(k)})()`
  );
}
