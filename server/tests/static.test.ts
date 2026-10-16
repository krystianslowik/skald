import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Hono } from "hono";
import { mountStatic } from "../src/static";

const root = mkdtempSync(join(tmpdir(), "skald-web-"));
writeFileSync(join(root, "index.html"), "<!doctype html><title>x</title>");
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

  it("answers an unknown /api path with a JSON 404, not the app shell", async () => {
    for (const [method, path] of [["GET", "/api/nope"], ["GET", "/api/x/y"], ["POST", "/api/nope"], ["GET", "/api/"]] as const) {
      const res = await app.request(path, { method });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "not found" });
    }
    expect((await app.request("/api/x")).status).toBe(200);
    // Only the /api prefix: a page path that starts with "api" is still the app.
    expect((await app.request("/apiary")).headers.get("content-type")).toContain("text/html");
  });

  it("caches hashed assets for good and answers a missing one with 404, not the shell", async () => {
    const js = await app.request("/assets/index-AbC123.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const gone = await app.request("/assets/index-Old999.js");
    expect(gone.status).toBe(404);
    expect(gone.headers.get("content-type")).not.toContain("text/html");
    expect(gone.headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/assets/nested/old.css")).status).toBe(404);
    // Only files under /assets/ are assets; a page at /assets is still the app.
    expect((await app.request("/assets")).headers.get("content-type")).toContain("text/html");
  });
});
