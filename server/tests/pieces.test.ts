import { describe, expect, it } from "bun:test";
import { HttpAgent, type AgentSource, type MapSourceResult, type PiecesBox } from "../src/agent";
import { createApp, parsePiecesBox } from "../src/app";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { MapCache } from "../src/map";
import { mockMap } from "../src/mapmock";
import { MockAgent } from "../src/mock";
import { MOCK_GROUND, mockPieces, piecesIn } from "../src/mockpieces";
import type { ApiPieces } from "../src/types";

const HASH = await Bun.password.hash("ognisko");

async function setup(pieces?: AgentSource["pieces"], withMap = true) {
  const agent = new MockAgent();
  if (pieces) agent.pieces = pieces as MockAgent["pieces"];
  const hub = new Hub(agent, new HistoryStore(":memory:"));
  const fetchMap = async (): Promise<MapSourceResult> => ({ status: 200, etag: '"x"', body: mockMap() });
  const app = createApp({ sessionSecret: "secret", passwordHash: HASH, secureCookie: false, agent, hub, metrics: async () => null, map: withMap ? new MapCache(fetchMap, false) : undefined });
  const res = await app.request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "ognisko" }) });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return { app, cookie };
}

describe("parsePiecesBox", () => {
  const q = (o: Record<string, string>) => (k: string) => o[k];
  it("takes a box, clamped to the world", () => {
    expect(parsePiecesBox(q({ x0: "100", z0: "-220", x1: "140", z1: "-180" }))).toEqual([100, -220, 140, -180]);
    expect(parsePiecesBox(q({ x0: "10400", z0: "0", x1: "11000", z1: "10" }))).toEqual([10400, 0, 10500, 10]);
  });
  it("refuses a missing, inverted or too large box", () => {
    expect(typeof parsePiecesBox(q({ x0: "1", z0: "2", x1: "3" }))).toBe("string");
    expect(typeof parsePiecesBox(q({ x0: "a", z0: "2", x1: "3", z1: "4" }))).toBe("string");
    expect(typeof parsePiecesBox(q({ x0: "Infinity", z0: "2", x1: "3", z1: "4" }))).toBe("string");
    expect(typeof parsePiecesBox(q({ x0: "5", z0: "2", x1: "3", z1: "4" }))).toBe("string");
    expect(typeof parsePiecesBox(q({ x0: "0", z0: "0", x1: "1025", z1: "4" }))).toBe("string");
    expect(parsePiecesBox(q({ x0: "0", z0: "0", x1: "1024", z1: "1024" }))).toEqual([0, 0, 1024, 1024]);
  });
});

describe("GET /api/pieces", () => {
  const home = "x0=192&z0=-384&x1=256&z1=-320";

  it("needs a session and a good box", async () => {
    const seen: PiecesBox[] = [];
    const { app, cookie } = await setup(async (box) => {
      seen.push(box);
      return new Response("{}");
    });
    expect((await app.request(`/api/pieces?${home}`)).status).toBe(401);
    expect((await app.request("/api/pieces?x0=1&z0=2", { headers: { cookie } })).status).toBe(400);
    expect((await app.request("/api/pieces?x0=0&z0=0&x1=2000&z1=10", { headers: { cookie } })).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("passes the agent's answer through with its ETag, gzip and 304", async () => {
    const { app, cookie } = await setup();
    const res = await app.request(`/api/pieces?${home}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    const etag = res.headers.get("ETag")!;
    expect(etag).toMatch(/^".+"$/);
    const body = (await res.json()) as ApiPieces;
    expect(body.count).toBeGreaterThan(300);
    expect(body.pieces.every((p) => p[1] >= 192 && p[1] <= 256 && p[2] >= -384 && p[2] <= -320)).toBe(true);
    expect(body.prefabs.every((p) => p.length === 6)).toBe(true);

    const gz = await app.request(`/api/pieces?${home}`, { headers: { cookie, "Accept-Encoding": "gzip" } });
    expect(gz.headers.get("Content-Encoding")).toBe("gzip");
    const raw = new Uint8Array(await gz.arrayBuffer());
    expect((JSON.parse(new TextDecoder().decode(Bun.gunzipSync(raw))) as ApiPieces).count).toBe(body.count);

    expect((await app.request(`/api/pieces?${home}`, { headers: { cookie, "If-None-Match": etag } })).status).toBe(304);
  });

  it("is 404 without a map or from an agent that has no floor plans, 503 before the first build", async () => {
    const off = await setup(undefined, false);
    expect((await off.app.request(`/api/pieces?${home}`, { headers: { cookie: off.cookie } })).status).toBe(404);
    const old = await setup(async () => new Response("404 page not found", { status: 404 }));
    expect((await old.app.request(`/api/pieces?${home}`, { headers: { cookie: old.cookie } })).status).toBe(404);
    const early = await setup(async () => new Response("{}", { status: 503, headers: { "Retry-After": "30" } }));
    const res = await early.app.request(`/api/pieces?${home}`, { headers: { cookie: early.cookie } });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    const down = await setup(async () => {
      throw new Error("refused");
    });
    expect((await down.app.request(`/api/pieces?${home}`, { headers: { cookie: down.cookie } })).status).toBe(502);
  });
});

describe("HttpAgent.pieces", () => {
  it("asks for the box with the token, gzip and If-None-Match", async () => {
    const urls: string[] = [];
    const heads: Headers[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      heads.push(new Headers(init?.headers));
      return new Response(null, { status: 304 });
    }) as typeof fetch;
    const a = new HttpAgent("http://agent", "tok", fetchImpl);
    expect((await a.pieces([1, -2, 3.5, 4], '"e"', new AbortController().signal)).status).toBe(304);
    expect(urls[0]).toBe("http://agent/pieces?x0=1&z0=-2&x1=3.5&z1=4");
    expect(heads[0]!.get("X-Agent-Token")).toBe("tok");
    expect(heads[0]!.get("If-None-Match")).toBe('"e"');
  });
});

describe("mock floor plans", () => {
  const map = mockMap();
  const all = mockPieces(map.storage!);
  const kindOf = (p: (typeof all.pieces)[number]) => all.prefabs[p[0]]![1];

  it("draws every chest where its container is, a stack drifting and turning", () => {
    const chests = all.pieces.filter((p) => kindOf(p) === "storage" && all.prefabs[p[0]]![0].startsWith("piece_chest"));
    expect(chests.length).toBe(map.storage!.filter((c) => c.kind === "chest").length);
    const stack = map.storage!.filter((c) => c.id.startsWith("piece_chest_wood@233,-346"));
    expect(stack.map((c) => c.id)).toEqual(["piece_chest_wood@233,-346", "piece_chest_wood@233,-346#1", "piece_chest_wood@233,-346#2"]);
    expect(stack.map((c) => c.y)).toEqual([31.7, 32.6, 33.5]);
    const here = chests.filter((p) => Math.round(p[1]) === 233 && Math.round(p[2]) === -346).sort((a, b) => a[3] - b[3]);
    expect(here.map((p) => p[3])).toEqual([31.7, 32.6, 33.5]);
    expect(here.map((p) => p[4])).toEqual([0, 180, 0]);
    expect(new Set(here.map((p) => p[1])).size).toBe(3);
  });

  it("has a loft over the longhouse and a roof", () => {
    const floors = all.pieces.filter((p) => kindOf(p) === "floor" && p[1] > 200 && p[1] < 236 && p[2] < -343 && p[2] > -357);
    expect(new Set(floors.map((p) => p[3]))).toEqual(new Set([MOCK_GROUND.home, MOCK_GROUND.upper]));
    expect(all.pieces.some((p) => kindOf(p) === "roof" && p[1] > 200 && p[1] < 240)).toBe(true);
    expect(all.pieces.some((p) => kindOf(p) === "stair")).toBe(true);
    expect(map.storage!.some((c) => c.y === +(MOCK_GROUND.upper + 0.05).toFixed(2))).toBe(true);
  });

  it("cuts to a box, renumbers prefabs and marks a truncated answer", () => {
    const cut = piecesIn(all, [192, -384, 256, -320], 7, 50);
    expect(cut.generation).toBe(7);
    expect(cut.count).toBe(50);
    expect(cut.truncated).toBe(true);
    expect(Math.max(...cut.pieces.map((p) => p[0]))).toBe(cut.prefabs.length - 1);
  });
});
