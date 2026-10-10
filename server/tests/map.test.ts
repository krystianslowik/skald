import { describe, expect, it } from "bun:test";
import { HttpAgent, type AgentSource, type MapSourceResult } from "../src/agent";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { MAP_RECHECK_MS, MapCache } from "../src/map";
import { gateMap, storageOf } from "../src/mapgate";
import { mockMap } from "../src/mapmock";
import { MockAgent } from "../src/mock";
import { emptyAgentState, type ApiMap, type ApiStorage, type MapSnapshot } from "../src/types";

const HASH = await Bun.password.hash("ognisko");

function decodeRle(b64: string): Uint8Array {
  const bytes = Buffer.from(b64, "base64");
  const out = new Uint8Array(2048 * 2048);
  let i = 0;
  let on = false;
  let p = 0;
  while (p < bytes.length) {
    let n = 0;
    let shift = 0;
    for (;;) {
      const c = bytes[p++]!;
      n += (c & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(c & 0x80)) break;
    }
    if (on) out.fill(1, i, i + n);
    i += n;
    on = !on;
  }
  expect(i).toBe(2048 * 2048);
  return out;
}

describe("mockMap", () => {
  const m = mockMap({ now: Date.parse("2026-10-10T20:00:00Z") });

  it("is a whole, realistic world", () => {
    expect(Buffer.from(m.land.data, "base64").length).toBe(m.land.size * m.land.size);
    expect(m.stats.generatedZones).toBeGreaterThan(3000);
    const mask = decodeRle(m.explored.rle);
    expect(mask.reduce((a, b) => a + b, 0)).toBe(m.explored.pixels);
    expect(m.explored.pixels).toBeGreaterThan(10_000);
    expect(m.locations.length).toBeGreaterThan(1000);
    // Most of the seed is unseen; a few places are found.
    expect(m.locations.some((l) => !l.placed)).toBe(true);
    expect(m.locations.some((l) => l.placed && !l.explored)).toBe(true);
    expect(m.locations.filter((l) => l.explored).length).toBeGreaterThan(3);
    const paired = m.portals.filter((p) => p.pairedWith);
    expect(paired.length).toBe(6);
    for (const p of paired) expect(m.portals.find((q) => q.id === p.pairedWith)?.pairedWith).toBe(p.id);
    expect(m.vehicles.some((v) => v.kind === "Karve")).toBe(true);
  });

  it("drops names when asked", () => {
    const hidden = mockMap({ showNames: false });
    const j = JSON.stringify(hidden);
    for (const n of ["Ragnar", "Bjorn", "Hearthstead", '"tag":"home"', "crafter"]) expect(j).not.toContain(n);
    expect(hidden.meta.showNames).toBe(false);
  });

  it("has stores: chests, a loaded cart and karve, graves with items, no world chests", () => {
    const store = m.storage!;
    expect(store.filter((c) => c.kind === "chest").length).toBeGreaterThan(8);
    for (const v of m.vehicles) expect(store.some((c) => c.id === v.id && c.x === v.x && c.z === v.z)).toBe(true);
    expect(store.find((c) => c.prefab === "Cart")!.items.length).toBeGreaterThan(0);
    for (const c of store) {
      expect(c.prefab).not.toMatch(/Treasure|shipwreck/);
      expect(new Set(c.items.map((i) => `${i.x},${i.y}`)).size).toBe(c.items.length);
      for (const i of c.items) expect(i.x < c.width && i.y < c.height).toBe(true);
    }
    expect(m.tombstones.every((g) => (g.items?.length ?? 0) > 0)).toBe(true);
    const all = store.flatMap((c) => c.items);
    expect(all.some((i) => i.quality && i.quality > 1)).toBe(true);
    expect(all.some((i) => i.durability !== undefined)).toBe(true);
    expect(all.every((i) => i.type)).toBe(true);
  });
});

describe("gateMap", () => {
  const snap = mockMap();

  it("keeps only found locations without spoilers", () => {
    const g = gateMap(snap, false);
    expect(g.spoilers).toBe(false);
    expect(g.locations.every((l) => l.placed && l.explored)).toBe(true);
    expect(g.hiddenLocations).toBe(snap.locations.length - g.locations.length);
    expect(g.hiddenLocations).toBeGreaterThan(0);
  });

  it("gives an older agent's map an empty store", () => {
    const { storage: _, ...old } = snap;
    expect(gateMap(old, false).storage).toEqual([]);
    const s = storageOf(gateMap(snap, false));
    expect(s.containers).toBe(snap.storage!);
    expect(Object.keys(s).sort()).toEqual(["containers", "generation", "savedAt", "showNames"]);
  });

  it("keeps everything with spoilers", () => {
    const g = gateMap(snap, true);
    expect(g.locations.length).toBe(snap.locations.length);
    expect(g.hiddenLocations).toBe(0);
  });
});

function source(results: (MapSourceResult | Error)[]) {
  const calls: (string | null)[] = [];
  const fetchMap = async (etag: string | null) => {
    calls.push(etag);
    const r = results.shift();
    if (!r || r instanceof Error) throw r ?? new Error("no more");
    return r;
  };
  return { calls, fetchMap };
}

describe("MapCache", () => {
  const body = mockMap();

  it("revalidates by ETag, shares a round trip and serves stale on errors", async () => {
    let now = 0;
    const src = source([
      { status: 200, etag: '"a"', body },
      { status: 304, etag: '"a"', body: null },
      new Error("down"),
    ]);
    const cache = new MapCache(src.fetchMap, false, () => now);
    const [r1, r2] = await Promise.all([cache.get(), cache.get()]);
    expect(src.calls).toEqual([null]);
    expect(r1.ok && r2.ok && r1.etag === r2.etag).toBe(true);
    if (!r1.ok) throw new Error("not ok");
    const gated = JSON.parse(r1.json) as ApiMap;
    expect(gated.spoilers).toBe(false);
    expect(new TextDecoder().decode(Bun.gunzipSync(r1.gzip))).toBe(r1.json);

    // Within the window: no agent call.
    now += MAP_RECHECK_MS - 1;
    await cache.get();
    expect(src.calls.length).toBe(1);

    now += 2;
    const r3 = await cache.get();
    expect(src.calls).toEqual([null, '"a"']);
    expect(r3.ok && r3.etag === r1.etag && !r3.stale).toBe(true);

    now += MAP_RECHECK_MS + 1;
    const r4 = await cache.get();
    expect(r4.ok && r4.stale).toBe(true);
  });

  it("passes 404 and 503 through until there is a copy", async () => {
    const off = new MapCache(source([{ status: 404, etag: null, body: null }]).fetchMap, false);
    expect(await off.get()).toEqual({ ok: false, status: 404, message: "world map off" });
    const cold = new MapCache(source([{ status: 503, etag: null, body: null }]).fetchMap, false);
    expect(await cold.get()).toEqual({ ok: false, status: 503, message: "world map not ready" });
    const down = new MapCache(source([new Error("x")]).fetchMap, false);
    expect(await down.get()).toEqual({ ok: false, status: 502, message: "agent unreachable" });
  });
});

describe("GET /api/map", () => {
  async function setup(spoilers: boolean, mapBody: MapSnapshot | null = mockMap()) {
    const agent = new MockAgent();
    const hub = new Hub(agent, new HistoryStore(":memory:"));
    const fetchMap = async (): Promise<MapSourceResult> => (mapBody ? { status: 200, etag: '"x"', body: mapBody } : { status: 404, etag: null, body: null });
    const app = createApp({
      sessionSecret: "secret",
      passwordHash: HASH,
      secureCookie: false,
      agent,
      hub,
      metrics: async () => null,
      map: new MapCache(fetchMap, spoilers),
    });
    const res = await app.request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "ognisko" }) });
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    return { app, cookie };
  }

  it("needs a session", async () => {
    const { app } = await setup(false);
    expect((await app.request("/api/map")).status).toBe(401);
  });

  it("serves the gated map with an ETag, gzip and 304", async () => {
    const { app, cookie } = await setup(false);
    const res = await app.request("/api/map", { headers: { cookie } });
    expect(res.status).toBe(200);
    const etag = res.headers.get("ETag")!;
    expect(etag).toMatch(/^".+"$/);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    const body = (await res.json()) as ApiMap;
    expect(body.spoilers).toBe(false);
    expect(body.locations.every((l) => l.explored && l.placed)).toBe(true);

    const gz = await app.request("/api/map", { headers: { cookie, "Accept-Encoding": "gzip, br" } });
    expect(gz.headers.get("Content-Encoding")).toBe("gzip");
    const raw = new Uint8Array(await gz.arrayBuffer());
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(raw))).spoilers).toBe(false);

    const again = await app.request("/api/map", { headers: { cookie, "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });

  it("shows everything with MAP_SPOILERS", async () => {
    const { app, cookie } = await setup(true);
    const body = (await (await app.request("/api/map", { headers: { cookie } })).json()) as ApiMap;
    expect(body.spoilers).toBe(true);
    expect(body.locations.some((l) => !l.explored)).toBe(true);
  });

  it("is 404 when the agent has no map", async () => {
    const { app, cookie } = await setup(false, null);
    expect((await app.request("/api/map", { headers: { cookie } })).status).toBe(404);
    expect((await app.request("/api/storage", { headers: { cookie } })).status).toBe(404);
  });

  it("serves the stores alone, with their own ETag", async () => {
    const { app, cookie } = await setup(false);
    expect((await app.request("/api/storage")).status).toBe(401);
    const res = await app.request("/api/storage", { headers: { cookie } });
    expect(res.status).toBe(200);
    const etag = res.headers.get("ETag")!;
    const map = await app.request("/api/map", { headers: { cookie } });
    expect(etag).not.toBe(map.headers.get("ETag"));
    const body = (await res.json()) as ApiStorage;
    expect(body.containers.length).toBe(mockMap().storage!.length);
    expect(JSON.stringify(body)).not.toContain("locations");
    expect((await app.request("/api/storage", { headers: { cookie, "If-None-Match": etag } })).status).toBe(304);
  });
});

describe("HttpAgent.map", () => {
  it("sends If-None-Match and reads 200 and 304", async () => {
    const seen: Headers[] = [];
    const snap = mockMap();
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen.push(h);
      if (h.get("If-None-Match") === '"v1"') return new Response(null, { status: 304, headers: { ETag: '"v1"' } });
      return new Response(JSON.stringify(snap), { status: 200, headers: { ETag: '"v1"', "Content-Type": "application/json" } });
    }) as typeof fetch;
    const a = new HttpAgent("http://agent", "tok", fetchImpl);
    const first = await a.map(null);
    expect(first.status).toBe(200);
    expect(first.etag).toBe('"v1"');
    expect(first.body?.meta.seedName).toBe("ZbzIWkK5KK");
    const second = await a.map('"v1"');
    expect(second).toEqual({ status: 304, etag: '"v1"', body: null });
    expect(seen[0]!.get("X-Agent-Token")).toBe("tok");
    expect(seen[1]!.get("If-None-Match")).toBe('"v1"');
  });
});

describe("mock agent map and clock", () => {
  it("stamps the save generation and keeps a world clock", async () => {
    const now = Date.parse("2026-10-10T20:00:00Z");
    const m = new MockAgent(() => now);
    const r = await m.map(null);
    expect(r.status).toBe(200);
    expect((await m.map(r.etag)).status).toBe(304);
    const st = await m.getState();
    expect(st.world.clock?.advancing).toBe(true);
    expect(st.world.clock?.day).toBeGreaterThanOrEqual(41);
    const empty = emptyAgentState();
    expect(empty.world.clock).toBeUndefined();
  });
});

describe("config", () => {
  it("reads MAP_SPOILERS, off by default", () => {
    expect(loadConfig({ MOCK_AGENT: "1" }).mapSpoilers).toBe(false);
    expect(loadConfig({ MOCK_AGENT: "1", MAP_SPOILERS: "true" }).mapSpoilers).toBe(true);
  });
});

// AgentSource must stay implementable by a plain object.
const _typecheck: Pick<AgentSource, "map"> = { map: async () => ({ status: 404, etag: null, body: null }) };
void _typecheck;
