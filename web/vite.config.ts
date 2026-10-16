import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildId, stampServiceWorker } from "./src/lib/swversion.ts";

// `npm run dev` talks to the Skald server on :8080 (run it with `bun run dev` for the mock agent).
const SERVER = process.env.SERVER_URL ?? "http://127.0.0.1:8080";

/** Preloads both weights of the body font from the HTML, so it is usually in before the first paint and nothing shifts when it swaps in. */
const preloadBodyFont = (): Plugin => ({
  name: "skald-preload-body-font",
  transformIndexHtml: {
    order: "post",
    handler(_html, ctx) {
      return Object.keys(ctx.bundle ?? {})
        .filter((f) => /averia-serif-libre-\d+-[\w-]+\.woff2$/.test(f))
        .map((f) => ({ tag: "link", attrs: { rel: "preload", href: `/${f}`, as: "font", type: "font/woff2", crossorigin: "" }, injectTo: "head" as const }));
    },
  },
});

/** Gives sw.js a per-build cache name, so a deploy replaces the worker and its activate drops the old build's cache. */
const stampSw = (): Plugin => {
  let publicDir = "";
  let outDir = "";
  return {
    name: "skald-stamp-sw",
    apply: "build",
    configResolved(c) {
      publicDir = c.publicDir;
      outDir = resolve(c.root, c.build.outDir);
    },
    writeBundle(_options, bundle) {
      // The icons and the manifest are cached too, so their bytes count, not only the bundle's hashed names.
      const publicFiles = (readdirSync(publicDir, { recursive: true }) as string[])
        .filter((f) => f !== "sw.js" && statSync(join(publicDir, f)).isFile())
        .map((f) => `${f}:${buildId([readFileSync(join(publicDir, f), "latin1")])}`);
      const source = readFileSync(join(publicDir, "sw.js"), "utf8");
      writeFileSync(join(outDir, "sw.js"), stampServiceWorker(source, [...Object.keys(bundle), ...publicFiles]));
    },
  };
};

export default defineConfig({
  plugins: [react(), tailwindcss(), preloadBodyFont(), stampSw()],
  resolve: {
    alias: { "@server": fileURLToPath(new URL("../server/src", import.meta.url)) },
  },
  server: {
    proxy: {
      "/api": SERVER,
      "/live": { target: SERVER.replace(/^http/, "ws"), ws: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // The integration-style files mount the whole Dashboard; under heavy CPU load one test can take well over 5 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Fonts stay files (fetched only when a glyph needs them), never base64 in the render-blocking CSS.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
  },
});
