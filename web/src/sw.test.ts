// Runs public/sw.js against an in-memory Cache Storage and a fake network.

import { afterEach, describe, expect, it, vi } from "vitest";
import SOURCE from "../public/sw.js?raw";
import { buildId, stampServiceWorker, SW_BUILD_TOKEN } from "./lib/swversion";

const ORIGIN = "https://skald.example";

type Handler = (event: { request?: Request; waitUntil(p: Promise<unknown>): void; respondWith?(p: Promise<Response>): void }) => void;

type Stores = Map<string, Map<string, Response>>;

/** What the device offers: the origin's storage quota, and Cache Storage that refuses to open (private mode). */
interface Env {
  quota?: number;
  noStorage?: boolean;
}

/** One worker; pass the same `stores` to two workers to share the browser's Cache Storage. */
function boot(network: (url: string) => Response | Promise<Response>, source = SOURCE, stores: Stores = new Map(), env: Env = {}) {
  const open = async (name: string) => {
    if (env.noStorage) throw new DOMException("no storage", "SecurityError");
    let s = stores.get(name);
    if (!s) stores.set(name, (s = new Map()));
    const store = s;
    const key = (r: Request | string) => {
      const u = new URL(typeof r === "string" ? r : r.url, ORIGIN);
      return u.pathname + u.search;
    };
    return {
      put: async (r: Request | string, res: Response) => void store.set(key(r), res),
      // A stored answer can be read more than once.
      match: async (r: Request | string) => store.get(key(r))?.clone(),
      delete: async (r: Request | string) => store.delete(key(r)),
      keys: async () => [...store.keys()].map((k) => new Request(ORIGIN + k)),
      addAll: async (urls: string[]) => {
        for (const u of urls) store.set(u, await network(u));
      },
    };
  };
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    has: async (name: string) => stores.has(name),
    delete: async (name: string) => stores.delete(name),
    match: async (r: Request | string) => {
      for (const name of stores.keys()) {
        const hit = await (await open(name)).match(r);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const handlers: Record<string, Handler> = {};
  const self = {
    location: { origin: ORIGIN },
    navigator: env.quota ? { storage: { estimate: async () => ({ quota: env.quota }) } } : undefined,
    addEventListener: (type: string, fn: Handler) => void (handlers[type] = fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const fetch = async (r: Request | string) => {
    if (typeof r === "string") return network(r);
    const u = new URL(r.url);
    return network(u.pathname + u.search);
  };
  new Function("self", "caches", "fetch", source)(self, caches, fetch);

  const run = async (type: string) => {
    let wait: Promise<unknown> = Promise.resolve();
    handlers[type]!({ waitUntil: (p) => void (wait = p) });
    await wait;
  };
  /** A request, resolved once the worker's background cache write is done too. */
  const get = async (path: string) => {
    let answer: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    handlers.fetch!({ request: new Request(ORIGIN + path), waitUntil: (p) => void pending.push(p), respondWith: (p) => void (answer = p) });
    const res = await answer!;
    // The worker extends the event from inside its response promise, so collect after it settles.
    await Promise.all(pending);
    return res;
  };
  /** Whether the worker answers a request at all; if not, the browser goes to the network itself. */
  const answers = (path: string, init?: RequestInit) => {
    let answered = false;
    handlers.fetch!({ request: new Request(ORIGIN + path, init), waitUntil: () => undefined, respondWith: () => void (answered = true) });
    return answered;
  };
  return { stores, run, get, answers };
}

const html = () => new Response("<!doctype html><title>Skald</title>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
const js = () => new Response("export {};", { headers: { "Content-Type": "text/javascript" } });

describe("service worker", () => {
  it("never caches the HTML shell under an /assets URL, so a retry can reach the network", async () => {
    let deployed = false;
    const sw = boot((url) => (url.startsWith("/assets/") ? (deployed ? js() : html()) : html()));
    await sw.run("install");
    const first = await sw.get("/assets/MapView-Old123.js");
    expect(first.headers.get("Content-Type")).toContain("text/html");
    const cached = [...sw.stores.values()].flatMap((s) => [...s.entries()]).filter(([k]) => k.startsWith("/assets/"));
    expect(cached).toEqual([]);
    deployed = true;
    expect((await sw.get("/assets/MapView-Old123.js")).headers.get("Content-Type")).toBe("text/javascript");
  });

  it("does not cache a 404 for a missing asset, and caches a real one", async () => {
    const sw = boot((url) => (url === "/assets/gone.js" ? new Response("Not found", { status: 404 }) : url.startsWith("/assets/") ? js() : html()));
    await sw.run("install");
    expect((await sw.get("/assets/gone.js")).status).toBe(404);
    await sw.get("/assets/index-New456.js");
    const keys = [...sw.stores.values()].flatMap((s) => [...s.keys()]);
    expect(keys).toContain("/assets/index-New456.js");
    expect(keys).not.toContain("/assets/gone.js");
  });

  it("lets a no-store request (the page checking the server is up) through to the network, even for a cached asset", async () => {
    const sw = boot((url) => (url.startsWith("/assets/") ? js() : html()));
    await sw.run("install");
    await sw.get("/assets/MapView-New456.js");
    expect(sw.answers("/assets/MapView-New456.js", { cache: "no-store" })).toBe(false);
    expect(sw.answers("/assets/MapView-New456.js")).toBe(true);
  });

  it("drops the previous build's cache, old chunks and all, when a new build's worker activates", async () => {
    const network = (url: string) => (url.startsWith("/assets/") ? js() : html());
    const old = boot(network, stampServiceWorker(SOURCE, ["assets/index-Old123.js"]));
    await old.run("install");
    await old.run("activate");
    await old.get("/assets/index-Old123.js");
    const [oldName] = old.stores.keys();

    // The new worker shares the browser's Cache Storage with the old one.
    const next = boot(network, stampServiceWorker(SOURCE, ["assets/index-New456.js"]), old.stores);
    await next.run("install");
    await next.run("activate");
    expect([...next.stores.keys()]).toHaveLength(1);
    expect(next.stores.has(oldName!)).toBe(false);
    expect([...next.stores.values()][0]!.has("/assets/index-Old123.js")).toBe(false);
  });

  it("keeps an old worker, still serving a page during the hand-over, from bringing its dropped cache back", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const network = async (url: string) => {
      if (url === "/assets/MapPreview-New789.js") await slow;
      return url.startsWith("/assets/") ? js() : html();
    };
    const old = boot(network, stampServiceWorker(SOURCE, ["assets/index-Old123.js"]));
    await old.run("install");
    await old.run("activate");
    const late = old.get("/assets/MapPreview-New789.js");

    // The new build's worker takes over while that request is still on the wire.
    const next = boot(network, stampServiceWorker(SOURCE, ["assets/index-New456.js"]), old.stores);
    await next.run("install");
    await next.run("activate");
    const [current] = old.stores.keys();
    release();
    await late;
    expect([...old.stores.keys()]).toEqual([current]);
  });
});

describe("service worker terrain tiles", () => {
  const tileUrl = (x: number, build = "b1") => `/api/terrain/tile?z=3&x=${x}&y=1&v=${build}`;
  /** A network that answers every tile with `size` bytes and counts what it was asked. */
  const tileNet = (size = 100) => {
    const asked: string[] = [];
    const network = (url: string) => {
      if (url.startsWith("/api/terrain/tile")) asked.push(url);
      return url.startsWith("/api/") ? new Response(new Uint8Array(size), { headers: { "Content-Type": "application/octet-stream" } }) : html();
    };
    return { asked, network };
  };
  const terrainKeys = (stores: Stores) => [...stores.entries()].filter(([n]) => n.startsWith("skald-terrain-")).flatMap(([n, s]) => [...s.keys()].map((k) => `${n} ${k}`));

  afterEach(() => vi.useRealTimers());

  it("keeps a tile and answers it again without the network", async () => {
    const net = tileNet();
    const sw = boot(net.network);
    const first = await sw.get(tileUrl(1));
    expect((await first.arrayBuffer()).byteLength).toBe(100);
    const again = await sw.get(tileUrl(1));
    expect((await again.arrayBuffer()).byteLength).toBe(100);
    expect(net.asked).toEqual([tileUrl(1)]);
    expect(terrainKeys(sw.stores)).toEqual([`skald-terrain-b1 ${tileUrl(1)}`]);
  });

  it("never answers a tile of another build, and drops the old build's tiles", async () => {
    const net = tileNet();
    const sw = boot(net.network);
    await sw.get(tileUrl(1, "b1"));
    await sw.get(tileUrl(1, "b2"));
    expect(net.asked).toEqual([tileUrl(1, "b1"), tileUrl(1, "b2")]);
    expect(terrainKeys(sw.stores)).toEqual([`skald-terrain-b2 ${tileUrl(1, "b2")}`]);
  });

  it("does not keep a tile outside the world or a busy answer", async () => {
    let status = 404;
    const asked: string[] = [];
    const sw = boot((url) => (asked.push(url), new Response("{}", { status })));
    expect((await sw.get(tileUrl(1))).status).toBe(404);
    status = 503;
    expect((await sw.get(tileUrl(1))).status).toBe(503);
    expect((await sw.get(tileUrl(1))).status).toBe(503);
    expect(asked).toHaveLength(3);
    expect(terrainKeys(sw.stores)).toEqual([]);
  });

  it("keeps the tiles when a new app build's worker activates", async () => {
    const net = tileNet();
    const old = boot(net.network, stampServiceWorker(SOURCE, ["assets/index-Old123.js"]));
    await old.run("install");
    await old.run("activate");
    await old.get(tileUrl(1));
    const next = boot(net.network, stampServiceWorker(SOURCE, ["assets/index-New456.js"]), old.stores);
    await next.run("install");
    await next.run("activate");
    expect(terrainKeys(next.stores)).toEqual([`skald-terrain-b1 ${tileUrl(1)}`]);
    await next.get(tileUrl(1));
    expect(net.asked).toEqual([tileUrl(1)]);
  });

  it("past its budget drops the least recently used tiles, and a tile read again counts as used", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const net = tileNet(100);
    // A quarter of the quota: 2000 bytes, room for 20 tiles of 100.
    const sw = boot(net.network, SOURCE, new Map(), { quota: 8000 });
    for (let x = 0; x < 64; x++) {
      vi.setSystemTime(x * 1000);
      await sw.get(tileUrl(x));
    }
    expect(terrainKeys(sw.stores)).toHaveLength(64);
    // Tile 0, the oldest, is used again a day later; that store looks at the budget.
    vi.setSystemTime(2 * 24 * 60 * 60 * 1000);
    await sw.get(tileUrl(0));
    const kept = terrainKeys(sw.stores).map((k) => k.split(" ")[1]);
    expect(kept).toHaveLength(18);
    expect(kept).toContain(tileUrl(0));
    expect(kept).toContain(tileUrl(63));
    expect(kept).not.toContain(tileUrl(1));
    expect(kept).not.toContain(tileUrl(46));
    expect(net.asked).toHaveLength(64);
  });

  it("does not keep a sign-in page that came back as a 200", async () => {
    const asked: string[] = [];
    const sw = boot((url) => (asked.push(url), html()));
    await sw.get(tileUrl(1));
    await sw.get(tileUrl(1));
    expect(asked).toHaveLength(2);
    expect(terrainKeys(sw.stores)).toEqual([]);
  });

  it("keeps the current build's tiles while a tab left on an old build asks for its own", async () => {
    const asked: string[] = [];
    const sw = boot((url) => {
      asked.push(url);
      // The server only serves the current build.
      return url.endsWith("v=b2") ? new Response(new Uint8Array(100), { headers: { "Content-Type": "application/octet-stream" } }) : new Response("{}", { status: 404 });
    });
    await sw.get(tileUrl(1, "b2"));
    expect((await sw.get(tileUrl(1, "b1"))).status).toBe(404);
    await sw.get(tileUrl(1, "b2"));
    expect(asked).toEqual([tileUrl(1, "b2"), tileUrl(1, "b1")]);
    expect(terrainKeys(sw.stores)).toEqual([`skald-terrain-b2 ${tileUrl(1, "b2")}`]);
  });

  it("still answers tiles from the network where it cannot store them", async () => {
    const net = tileNet();
    const sw = boot(net.network, SOURCE, new Map(), { noStorage: true });
    expect((await sw.get(tileUrl(1))).status).toBe(200);
    expect((await sw.get(tileUrl(1))).status).toBe(200);
    expect(net.asked).toHaveLength(2);
  });

  it("leaves the rest of /api to the network", async () => {
    const sw = boot(tileNet().network);
    expect(sw.answers("/api/terrain/tiles.json")).toBe(false);
    expect(sw.answers("/api/terrain/tile?z=0&x=0&y=0")).toBe(false);
    expect(sw.answers("/api/state")).toBe(false);
  });
});

describe("stampServiceWorker", () => {
  it("gives each build its own cache name, and the same build the same one", () => {
    expect(SOURCE).toContain(SW_BUILD_TOKEN);
    const a = stampServiceWorker(SOURCE, ["assets/index-Aaa.js", "index.html"]);
    const b = stampServiceWorker(SOURCE, ["assets/index-Bbb.js", "index.html"]);
    expect(a).not.toContain(SW_BUILD_TOKEN);
    expect(a).not.toBe(b);
    expect(buildId(["x", "y"])).toBe(buildId(["y", "x"]));
    expect(() => stampServiceWorker("const VERSION = 'v1';", [])).toThrow();
  });
});
