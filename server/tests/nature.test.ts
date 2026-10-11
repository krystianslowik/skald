import { describe, expect, it } from "bun:test";
import { HttpAgent, type AgentSource, type MapSourceResult } from "../src/agent";
import { createApp } from "../src/app";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { MapCache } from "../src/map";
import { mockMap } from "../src/mapmock";
import { MockAgent } from "../src/mock";
import { mockNature, natureIn } from "../src/mocknature";
import { mockPieces } from "../src/mockpieces";
import type { ApiNature } from "../src/types";

const HASH = await Bun.password.hash("ognisko");

async function setup(nature?: AgentSource["nature"], opts: { withMap?: boolean; spoilers?: boolean } = {}) {
  const agent = new MockAgent();
  if (nature) agent.nature = nature as MockAgent["nature"];
  const hub = new Hub(agent, new HistoryStore(":memory:"));
  const fetchMap = async (): Promise<MapSourceResult> => ({ status: 200, etag: '"x"', body: mockMap() });
  const map = opts.withMap === false ? undefined : new MapCache(fetchMap, opts.spoilers ?? false);
  const app = createApp({ sessionSecret: "secret", passwordHash: HASH, secureCookie: false, agent, hub, metrics: async () => null, map });
  const res = await app.request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "ognisko" }) });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return { app, cookie };
}

describe("GET /api/nature", () => {
  const home = "x0=128&z0=-384&x1=384&z1=-128";

  it("needs a session and a good box", async () => {
    let asked = 0;
    const { app, cookie } = await setup(async () => {
      asked++;
      return new Response("{}");
    });
    expect((await app.request(`/api/nature?${home}`)).status).toBe(401);
    expect((await app.request("/api/nature?x0=1&z0=2", { headers: { cookie } })).status).toBe(400);
    expect((await app.request("/api/nature?x0=0&z0=0&x1=2000&z1=10", { headers: { cookie } })).status).toBe(400);
    expect(asked).toBe(0);
  });

  it("passes the agent's answer through with its ETag, gzip and 304", async () => {
    const { app, cookie } = await setup();
    const res = await app.request(`/api/nature?${home}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    const etag = res.headers.get("ETag")!;
    expect(etag).toMatch(/^".+"$/);
    const body = (await res.json()) as ApiNature;
    expect(body.count).toBeGreaterThan(1000);
    expect(body.spoilers).toBe(false);
    expect(body.items.every((p) => p[1] >= 128 && p[1] <= 384 && p[2] >= -384 && p[2] <= -128)).toBe(true);
    expect(body.kinds.every((k) => k.length === 4)).toBe(true);

    const gz = await app.request(`/api/nature?${home}`, { headers: { cookie, "Accept-Encoding": "gzip" } });
    expect(gz.headers.get("Content-Encoding")).toBe("gzip");
    const raw = new Uint8Array(await gz.arrayBuffer());
    expect((JSON.parse(new TextDecoder().decode(Bun.gunzipSync(raw))) as ApiNature).count).toBe(body.count);

    expect((await app.request(`/api/nature?${home}`, { headers: { cookie, "If-None-Match": etag } })).status).toBe(304);
  });

  it("asks for spoilers only when MAP_SPOILERS is on, never because the client did", async () => {
    const asks: boolean[] = [];
    const spy: AgentSource["nature"] = async (_box, spoilers) => {
      asks.push(spoilers);
      return Response.json({ kinds: [], items: [] });
    };
    const off = await setup(spy);
    await off.app.request(`/api/nature?${home}&spoilers=true`, { headers: { cookie: off.cookie } });
    const on = await setup(spy, { spoilers: true });
    await on.app.request(`/api/nature?${home}`, { headers: { cookie: on.cookie } });
    expect(asks).toEqual([false, true]);
  });

  it("is 404 without a map or from an agent that has no nature, 503 before the first build", async () => {
    const off = await setup(undefined, { withMap: false });
    expect((await off.app.request(`/api/nature?${home}`, { headers: { cookie: off.cookie } })).status).toBe(404);
    const old = await setup(async () => new Response("404 page not found", { status: 404 }));
    expect((await old.app.request(`/api/nature?${home}`, { headers: { cookie: old.cookie } })).status).toBe(404);
    const early = await setup(async () => new Response("{}", { status: 503, headers: { "Retry-After": "30" } }));
    const res = await early.app.request(`/api/nature?${home}`, { headers: { cookie: early.cookie } });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    const broken = await setup(async () => new Response("boom", { status: 500 }));
    expect((await broken.app.request(`/api/nature?${home}`, { headers: { cookie: broken.cookie } })).status).toBe(502);
    const down = await setup(async () => {
      throw new Error("refused");
    });
    expect((await down.app.request(`/api/nature?${home}`, { headers: { cookie: down.cookie } })).status).toBe(502);
  });
});

describe("HttpAgent.nature", () => {
  it("asks for the box with the token, gzip and If-None-Match, and spoilers only when told", async () => {
    const urls: string[] = [];
    const heads: Headers[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      heads.push(new Headers(init?.headers));
      return new Response(null, { status: 304 });
    }) as typeof fetch;
    const a = new HttpAgent("http://agent", "tok", fetchImpl);
    expect((await a.nature([1, -2, 3.5, 4], false, '"e"', new AbortController().signal)).status).toBe(304);
    await a.nature([0, 0, 256, 256], true, null, new AbortController().signal);
    expect(urls).toEqual(["http://agent/nature?x0=1&z0=-2&x1=3.5&z1=4", "http://agent/nature?x0=0&z0=0&x1=256&z1=256&spoilers=true"]);
    expect(heads[0]!.get("X-Agent-Token")).toBe("tok");
    expect(heads[0]!.get("If-None-Match")).toBe('"e"');
    expect(heads[1]!.get("If-None-Match")).toBeNull();
  });
});

describe("mock nature", () => {
  const all = mockNature();
  const kindOf = (p: (typeof all.items)[number]) => all.kinds[p[0]]!;
  const pieces = mockPieces(mockMap().storage!);

  it("never puts anything inside a building", () => {
    const floors = pieces.pieces.filter((p) => pieces.prefabs[p[0]]![1] === "floor");
    for (const it of all.items) {
      expect(floors.some((f) => Math.abs(f[1] - it[1]) <= 1 && Math.abs(f[2] - it[2]) <= 1)).toBe(false);
    }
  });

  it("has woods with a clearing round the home base, ore and pickables", () => {
    const near = (cx: number, cz: number, r: number) => all.items.filter((p) => Math.hypot(p[1] - cx, p[2] - cz) < r);
    const trees = (list: typeof all.items) => list.filter((p) => kindOf(p)[1] === "tree");
    expect(trees(near(227, -341, 40))).toEqual([]);
    expect(trees(near(227, -341, 300)).length).toBeGreaterThan(1500);
    const species = new Set(all.items.map((p) => `${kindOf(p)[1]}:${kindOf(p)[2]}`));
    for (const s of ["tree:beech", "tree:fir", "tree:swamp", "stump:beech", "log:beech", "rock:boulder", "bush:bush", "ore:copper", "ore:tin", "ore:iron", "pickable:raspberry", "pickable:mushroom", "pickable:flint"]) {
      expect(species.has(s)).toBe(true);
    }
  });

  it("cuts to a box, renumbers kinds and marks a truncated answer", () => {
    const cut = natureIn(all, [128, -384, 384, -128], 7, false, 50);
    expect(cut.generation).toBe(7);
    expect(cut.count).toBe(50);
    expect(cut.truncated).toBe(true);
    expect(Math.max(...cut.items.map((p) => p[0]))).toBe(cut.kinds.length - 1);
  });
});
