// Minimal service worker: caches the app shell only. Never touches /api, /live
// or /healthz (live data and auth must always hit the network). Navigations are
// network-first with the cached shell as the offline fallback; hashed /assets/*
// and icons are cache-first; everything else (incl. the manifest) is network. Bump VERSION to drop old caches.
const VERSION = "skald-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith("/api/") || p === "/api" || p === "/live" || p === "/healthz" || p === "/sw.js") return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put("/", copy));
          }
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
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
