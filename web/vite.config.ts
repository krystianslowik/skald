import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// `npm run dev` talks to the Skald server on :8080 (run it with `bun run dev` for the mock agent).
const SERVER = process.env.SERVER_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
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
  },
  build: { outDir: "dist", emptyOutDir: true },
});
