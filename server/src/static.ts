import type { Hono } from "hono";
import { serveStatic } from "hono/bun";

/**
 * Serves the built SPA (`web/dist`) plus its PWA files. The HTML shell, the web
 * manifest and `sw.js` revalidate on every load so a deploy (and a new service
 * worker) is picked up; hashed `/assets/*` keep the default caching.
 */
export function mountStatic(app: Hono, webRoot: string): void {
  app.use("/*", async (c, next) => {
    await next();
    const path = c.req.path;
    const type = c.res.headers.get("Content-Type") ?? "";
    if (path === "/sw.js" || path.endsWith(".webmanifest") || type.startsWith("text/html")) {
      c.res.headers.set("Cache-Control", "no-cache");
    }
  });
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: `${webRoot}/index.html` }));
}
