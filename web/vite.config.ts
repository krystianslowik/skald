import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

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

export default defineConfig({
  plugins: [react(), tailwindcss(), preloadBodyFont()],
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
    // Vitest blanks CSS by default; the font test reads the stylesheet's source with `?raw`.
    css: { include: [/index\.css/] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Fonts stay files (fetched only when a glyph needs them), never base64 in the render-blocking CSS.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
  },
});
