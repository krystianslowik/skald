// Build time: the inline script that the built index.html runs before the app.
// It picks the language the app will start in (the viewer's stored choice, else
// the server's SKALD_LOCALE in `<html data-locale>`) and preloads that one
// dictionary chunk, so it downloads alongside the app instead of after it.

import { LOCALE_STORAGE_KEY, type Locale } from "./locales.ts";

/** `chunks`: each language's built chunk, as an absolute URL path. */
export function localePreloadScript(chunks: Record<Locale, string>): string {
  const m = JSON.stringify(chunks).replace(/</g, "\\u003c");
  const key = JSON.stringify(LOCALE_STORAGE_KEY);
  return (
    `(function(){var m=${m},h=document.documentElement,l=h.getAttribute("data-locale");` +
    `try{var s=localStorage.getItem(${key});if(Object.prototype.hasOwnProperty.call(m,s))l=s}catch(e){}` +
    `if(!Object.prototype.hasOwnProperty.call(m,l))return;h.lang=l;` +
    `var k=document.createElement("link");k.rel="modulepreload";k.crossOrigin="";k.href=m[l];document.head.appendChild(k)})()`
  );
}
