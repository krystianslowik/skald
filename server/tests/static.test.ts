import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
