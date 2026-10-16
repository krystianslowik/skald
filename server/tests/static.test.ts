import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Hono } from "hono";
import { mountStatic, withLocale } from "../src/static";

const root = mkdtempSync(join(tmpdir(), "skald-web-"));
writeFileSync(join(root, "index.html"), '<!doctype html><html lang="en"><head><title>x</title></head><body></body></html>');
writeFileSync(join(root, "sw.js"), "self.addEventListener('fetch', () => {});");
writeFileSync(join(root, "manifest.webmanifest"), "{}");
writeFileSync(join(root, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
writeFileSync(join(root, "icon-192.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "assets", "index-AbC123.js"), "export {};");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("mountStatic", () => {
  const app = new Hono();
  app.get("/api/x", (c) => c.json({ ok: true }));
  // Like production (`../web/dist`), the root is relative to the CWD.
  mountStatic(app, relative(process.cwd(), root));

  it("serves PWA files with the right types and revalidates the shell and service worker", async () => {
    const sw = await app.request("/sw.js");
    expect(sw.headers.get("content-type")).toContain("javascript");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    const mf = await app.request("/manifest.webmanifest");
    expect(mf.headers.get("content-type")).toContain("application/manifest+json");
    expect(mf.headers.get("cache-control")).toBe("no-cache");
    expect((await app.request("/icon.svg")).headers.get("content-type")).toContain("image/svg+xml");
    expect((await app.request("/icon-192.png")).headers.get("content-type")).toBe("image/png");
    expect((await app.request("/icon-192.png")).headers.get("cache-control")).toBeNull();
    const spa = await app.request("/some/route");
    expect(spa.headers.get("content-type")).toContain("text/html");
    expect(spa.headers.get("cache-control")).toBe("no-cache");
    expect((await app.request("/api/x")).headers.get("cache-control")).toBeNull();
  });

  it("caches hashed assets for good, and a missing one is a 404, not the page", async () => {
    const js = await app.request("/assets/index-AbC123.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const gone = await app.request("/assets/index-Old999.js");
    expect(gone.status).toBe(404);
    expect(gone.headers.get("content-type") ?? "").not.toContain("text/html");
    expect(gone.headers.get("cache-control")).toBeNull();
  });
});

describe("default language in the page", () => {
  const app = new Hono();
  mountStatic(app, relative(process.cwd(), root), "pl");

  it("writes SKALD_LOCALE onto <html> for every way the shell is served", async () => {
    for (const path of ["/", "/index.html", "/some/route"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const body = await res.text();
      expect(body).toContain('<html lang="pl" data-locale="pl">');
      expect(body).not.toContain('lang="en"');
    }
  });

  it("leaves other files alone", async () => {
    expect(await (await app.request("/assets/index-AbC123.js")).text()).toBe("export {};");
  });

  it("replaces an existing lang or data-locale and keeps other attributes", () => {
    expect(withLocale('<html class="a" lang="en" data-locale=\'pl\'><body>', "en")).toBe('<html class="a" lang="en" data-locale="en"><body>');
    expect(withLocale("<!doctype html><html><head>", "pl")).toBe('<!doctype html><html lang="pl" data-locale="pl"><head>');
  });
});
