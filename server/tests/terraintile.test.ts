import { describe, expect, it } from "bun:test";
import { createApp } from "../src/app";
import { RateLimiter } from "../src/auth";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { MockAgent } from "../src/mock";
import { MOCK_TILE_BUILD, mockTerrainTile } from "../src/mockterrain";

const HASH = await Bun.password.hash("ognisko");

function setup() {
  const agent = new MockAgent();
  const asked: string[] = [];
  const tile = agent.terrainTile.bind(agent);
  agent.terrainTile = async (t, etag) => {
    asked.push(`${t.z}/${t.x}/${t.y}/${t.v}`);
    return tile(t, etag);
  };
  const hub = new Hub(agent, new HistoryStore(":memory:"));
  const app = createApp({
    sessionSecret: "secret",
    passwordHash: HASH,
    secureCookie: true,
    agent,
    hub,
    metrics: async () => null,
    locale: "pl",
    trustedIpHeader: "CF-Connecting-IP",
    limiter: new RateLimiter(5, 60_000, 900_000, () => 0),
  });
  return { app, agent, asked };
}

async function cookieOf(app: ReturnType<typeof setup>["app"]): Promise<string> {
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
    body: JSON.stringify({ password: "ognisko" }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

describe("terrain tiles", () => {
  it("proxies tiles behind the session, cached for good, untouched", async () => {
    const s = setup();
    const url = `/api/terrain/tile?z=3&x=3&y=3&v=${MOCK_TILE_BUILD}`;
    expect((await s.app.request(url)).status).toBe(401);
    const cookie = await cookieOf(s.app);
    const doc = await s.app.request("/api/terrain/tiles.json", { headers: { cookie } });
    expect(doc.status).toBe(200);
    expect(doc.headers.get("cache-control")).toBe("private, no-cache");
    expect(((await doc.json()) as { build: string }).build).toBe(MOCK_TILE_BUILD);
    const res = await s.app.request(url, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    // The body is the agent's gzip, not re-encoded: it starts with the gzip magic.
    const body = new Uint8Array(await res.arrayBuffer());
    expect([body[0], body[1]]).toEqual([0x1f, 0x8b]);
    const raw = Bun.gunzipSync(body);
    const dv = new DataView(raw.buffer, raw.byteOffset);
    expect(dv.getUint32(0, true)).toBe(0x31544b53);
    expect(dv.getInt32(8, true)).toBe(258);
    expect(raw.length).toBe(24 + 258 * 258 * 4);
    const etag = res.headers.get("etag")!;
    expect((await s.app.request(url, { headers: { cookie, "If-None-Match": etag } })).status).toBe(304);
  });

  it("refuses bad tiles before the agent and passes 404 through uncached", async () => {
    const s = setup();
    const cookie = await cookieOf(s.app);
    for (const q of ["z=-1&x=0&y=0&v=a", "z=1&x=0&y=0", "z=1&x=a&y=0&v=a", "z=1&x=0&y=0&v=a/b"]) {
      expect((await s.app.request(`/api/terrain/tile?${q}`, { headers: { cookie } })).status).toBe(400);
    }
    expect(s.asked).toEqual([]);
    const gone = await s.app.request("/api/terrain/tile?z=1&x=0&y=0&v=old-build", { headers: { cookie } });
    expect(gone.status).toBe(404);
    expect(gone.headers.get("cache-control")).toBe("no-store");
  });

  it("the mock's tiles abut: a tile's east apron is its neighbour's first column", () => {
    const a = mockTile(4, 7, 7);
    const b = mockTile(4, 8, 7);
    const n = 258;
    for (const row of [1, 100, 256]) {
      // a's column n-2 is its last pixel, b's column 0 its west apron: the same place.
      expect(Math.abs(a.height(row, n - 2) - b.height(row, 0))).toBeLessThanOrEqual(1);
      expect(Math.abs(a.height(row, n - 1) - b.height(row, 1))).toBeLessThanOrEqual(1);
    }
  });
});


function mockTile(z: number, x: number, y: number) {
  const raw = mockTerrainTile(z, x, y)!;
  const dv = new DataView(raw.buffer);
  const n = dv.getInt32(8, true);
  return { height: (row: number, col: number) => dv.getUint16(24 + n * n + 2 * (row * n + col), true) };
}
