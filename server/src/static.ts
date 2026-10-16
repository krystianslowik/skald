import type { Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Locale } from "./types";

/**
 * Writes the server's default language (SKALD_LOCALE) onto the page's `<html>`
 * tag. The built page's inline script reads `data-locale` (unless the viewer
 * stored a choice) and preloads that one dictionary chunk next to the app, so
 * the first render never waits for a config fetch or a second round trip.
 */
export function withLocale(html: string, locale: Locale): string {
  return html.replace(/<html\b([^>]*)>/i, (_m, attrs: string) => {
    const rest = attrs.replace(/\s+(?:lang|data-locale)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return `<html${rest} lang="${locale}" data-locale="${locale}">`;
  });
}

/**
 * Serves the built SPA (`web/dist`) plus its PWA files. The HTML shell, the web
 * manifest and `sw.js` revalidate on every load so a deploy (and a new service
 * worker) is picked up. Vite's `/assets/*` carry a content hash in their names,
 * so they are cached for good: without a service worker (plain http) nothing
 * else keeps a phone from downloading the whole app on every visit.
 */
export function mountStatic(app: Hono, webRoot: string, locale: Locale = "en"): void {
  app.use("/*", async (c, next) => {
    await next();
    const path = c.req.path;
    const type = c.res.headers.get("Content-Type") ?? "";
    if (path === "/sw.js" || path.endsWith(".webmanifest") || type.startsWith("text/html")) {
      c.res.headers.set("Cache-Control", "no-cache");
    } else if (path.startsWith("/assets/") && c.res.status === 200) {
      c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }
  });
  // Rewritten once per build: a rebuilt `web/dist` (new mtime) is picked up without a restart.
  let cached: { mtime: number; html: string } | null = null;
  const shell = async (c: Context) => {
    const file = Bun.file(`${webRoot}/index.html`);
    if (!(await file.exists())) return c.notFound();
    if (cached?.mtime !== file.lastModified) cached = { mtime: file.lastModified, html: withLocale(await file.text(), locale) };
    return c.html(cached.html);
  };
  app.get("/", shell);
  app.get("/index.html", shell);
  app.use("/*", serveStatic({ root: webRoot }));
  // A hashed file that is not there (a tab older than the last deploy asking for a lazy chunk)
  // is a 404, not the page: the HTML would fail as a script and the service worker would keep it.
  app.get("/assets/*", (c) => c.notFound());
  app.get("*", shell);
}
