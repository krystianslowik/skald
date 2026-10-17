// Minimal service worker: caches the app shell only. Never touches /api, /live
// or /healthz (live data and auth must always hit the network). Navigations are
// network-first with the cached shell as the offline fallback; hashed /assets/*
// and icons are cache-first; everything else (incl. the manifest) is network.
// The build stamps VERSION, so every deploy installs a new worker whose
// `activate` deletes the previous build's cache: old chunks do not pile up.
const VERSION = "skald-shell-__SKALD_BUILD__";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

/** Worth keeping: a good answer that is not the HTML shell. Assets and icons are never HTML, so HTML there is an error page. */
const cacheable = (res) => res.ok && !(res.headers.get("Content-Type") || "").includes("text/html");

/**
 * Stores a response unless a newer build's worker already dropped this
 * worker's cache: a page still on the old worker during the hand-over must not
 * bring the old cache back.
 */
const store = (key, res) => caches.has(VERSION).then((live) => live && caches.open(VERSION).then((c) => c.put(key, res)));

/** Drops every cache but this build's. */
const prune = () => caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(prune().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith("/api/") || p === "/api" || p === "/live" || p === "/healthz" || p === "/sw.js") return;
  // A page checking whether the server is reachable (lib/chunks.ts probeChunk) wants the network's answer.
  if (req.cache === "no-store") return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) event.waitUntil(store("/", res.clone()));
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || Response.error())),
    );
    return;
  }

  // The manifest is not here: the server marks it no-cache, so it follows the network.
  if (p.startsWith("/assets/") || p.startsWith("/icon")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (cacheable(res)) event.waitUntil(store(req, res.clone()));
            return res;
          }),
      ),
    );
  }
});
