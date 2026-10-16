import type { Hono } from "hono";
import { serveStatic } from "hono/bun";

/**
 * Serves the built SPA (`web/dist`) plus its PWA files. The HTML shell, the web
 * manifest and `sw.js` revalidate on every load so a deploy (and a new service
 * worker) is picked up. Vite's `/assets/*` carry a content hash in their names,
 * so they are cached for good: without a service worker (plain http) nothing
 * else keeps a phone from downloading the whole app on every visit. Mount it
 * last, after the API routes.
 */
export function mountStatic(app: Hono, webRoot: string): void {
  // Registered after every API route: an /api path none of them took is a
  // JSON 404, not the app shell with a 200.
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
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
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: `${webRoot}/index.html` }));
}
