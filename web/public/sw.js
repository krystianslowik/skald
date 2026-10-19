// Minimal service worker: caches the app shell and terrain tiles. Never touches
// the rest of /api, /live or /healthz (live data and auth must always hit the
// network). Navigations are network-first with the cached shell as the offline
// fallback; hashed /assets/* and icons are cache-first; everything else (incl.
// the manifest) is network.
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

/** Drops every shell cache but this build's (terrain caches follow the world, not the app). */
const prune = () => caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("skald-shell-") && k !== VERSION).map((k) => caches.delete(k))));

// Terrain tiles (/api/terrain/tile?...&v=<build>). The build names the world
// and its terrain, so a tile URL never changes what it answers: tiles are kept
// cache-first in one cache per build, and the first tile stored for a new build
// (another world, a game update) drops the old builds' caches. Safari ignores
// the HTTP cache for requests that pass a service worker, so without this every
// visit there fetched every tile again. The tiles kept are bounded by
// TERRAIN_BUDGET, or a quarter of the origin's quota if that is less; past it
// the least recently used go. Each stored tile carries when it was last used,
// refreshed at most once a day so reading a tile rarely writes it again.
const TERRAIN = "skald-terrain-";
const TERRAIN_BUDGET = 200 * 1024 * 1024;
const USED = "X-Skald-Used";
const BYTES = "X-Skald-Bytes";
const DAY = 24 * 60 * 60 * 1000;
/** Look at the budget on the first tile stored after the worker wakes, then every this many. */
const TRIM_EVERY = 64;
/** The build whose tile was last stored (older builds' caches are dropped then). */
let keptBuild = "";
let stored = 0;
let trimming = null;

/** Over budget: drops the least recently used tiles down to 90 % of it. The whole origin's use under the budget skips the walk. */
const trimTerrain = async (cache) => {
  let budget = TERRAIN_BUDGET;
  try {
    const e = await self.navigator?.storage?.estimate?.();
    if (e?.quota) budget = Math.min(budget, e.quota / 4);
    if (typeof e?.usage === "number" && e.usage <= budget) return;
  } catch {
    // no estimate: walk the cache
  }
  const keys = await cache.keys();
  const tiles = await Promise.all(
    keys.map(async (req) => {
      const r = await cache.match(req);
      return { req, used: Number(r?.headers.get(USED)) || 0, bytes: Number(r?.headers.get(BYTES)) || 0 };
    }),
  );
  let total = tiles.reduce((n, t) => n + t.bytes, 0);
  if (total <= budget) return;
  tiles.sort((a, b) => a.used - b.used);
  for (const t of tiles) {
    if (total <= budget * 0.9) break;
    await cache.delete(t.req);
    total -= t.bytes;
  }
};

/** Keeps a tile, stamped with now as its last use. */
const keepTile = async (cache, req, res) => {
  const body = await res.arrayBuffer();
  const headers = { "Content-Type": "application/octet-stream", [USED]: String(Date.now()), [BYTES]: String(body.byteLength) };
  await cache.put(req, new Response(body, { headers }));
  if (stored++ % TRIM_EVERY === 0 && !trimming) {
    trimming = trimTerrain(cache).finally(() => (trimming = null));
    await trimming;
  }
};

/** Drops the terrain caches of every build but this one. */
const dropOtherBuilds = (build) =>
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(TERRAIN) && k !== TERRAIN + build).map((k) => caches.delete(k))));

/** A whole tile as skald-web sends it: not a proxy's sign-in or error page that came back as a 200. */
const isTile = (res) => res.status === 200 && !res.redirected && (res.headers.get("Content-Type") || "").startsWith("application/octet-stream");

/** The tile from this build's cache, or from the network and then kept. Storage that fails (private mode, quota) only costs the cache. */
const terrainTile = async (event, build) => {
  const req = event.request;
  let cache = null;
  try {
    // Opened per request: a cache dropped on log out must not live on in a handle kept here.
    cache = await caches.open(TERRAIN + build);
    const hit = await cache.match(req);
    if (hit) {
      if (Date.now() - (Number(hit.headers.get(USED)) || 0) > DAY) event.waitUntil(keepTile(cache, req, hit.clone()).catch(() => undefined));
      return hit;
    }
  } catch {
    // no storage here: the network alone
  }
  const res = await fetch(req);
  // Only a whole tile is kept: a 404 (outside the world), a busy answer or a sign-in page must reach the page as it is.
  if (cache && isTile(res)) {
    const keep = keepTile(cache, req, res.clone());
    // Only a build the server still serves drops the others: a tab left on an old build gets 404s and drops nothing.
    if (build !== keptBuild) {
      keptBuild = build;
      event.waitUntil(keep.then(() => dropOtherBuilds(build)).catch(() => undefined));
    } else event.waitUntil(keep.catch(() => undefined));
  }
  return res;
};

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
  const build = p === "/api/terrain/tile" ? url.searchParams.get("v") : null;
  if (build) {
    event.respondWith(terrainTile(event, build));
    return;
  }
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

// Phone push (/api/push): the server sends { title, body, tag, url } as JSON.
// Every push shows a notification: Safari drops a subscription whose pushes
// show nothing. A tag keeps one notification per kind of news on the device.
self.addEventListener("push", (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof msg.title === "string" && msg.title ? msg.title : "Skald";
  const url = typeof msg.url === "string" && msg.url.startsWith("/") && !msg.url.startsWith("//") ? msg.url : "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof msg.body === "string" ? msg.body : "",
      tag: typeof msg.tag === "string" && msg.tag ? `skald-${msg.tag}` : undefined,
      // A replaced notification (more friends at the fire) is news again.
      renotify: typeof msg.tag === "string" && msg.tag !== "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url },
    }),
  );
});

// A tap opens the panel where the news is: an open panel window is focused and
// moved there, else a new one opens.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data && typeof event.notification.data.url === "string" ? event.notification.data.url : "/";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const win = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (win) return win.focus().then((c) => (c && c.url !== target && "navigate" in c ? c.navigate(target) : c));
      return self.clients.openWindow(target);
    }),
  );
});

// The browser renewed the subscription on its own: tell the server, keeping
// this device's choice. Best effort; without a session it is refused, and the
// device turns push on again from Settings.
self.addEventListener("pushsubscriptionchange", (event) => {
  const old = event.oldSubscription;
  event.waitUntil(
    (async () => {
      const post = (path, body, method = "POST") =>
        fetch(path, { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!old) return;
      const res = await post("/api/push/device", { endpoint: old.endpoint });
      const prefs = res.ok ? (await res.json()).prefs : null;
      if (!prefs) return;
      const sub = event.newSubscription || (await self.registration.pushManager.subscribe(old.options));
      const json = sub.toJSON();
      await post("/api/push", { subscription: { endpoint: json.endpoint, keys: json.keys }, prefs }, "PUT");
      // Same endpoint with new keys: the PUT already replaced the row.
      if (json.endpoint !== old.endpoint) await post("/api/push", { endpoint: old.endpoint }, "DELETE");
    })().catch(() => undefined),
  );
});
