import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentSource } from "../src/agent";
import { createApp } from "../src/app";
import { RateLimiter } from "../src/auth";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { MockAgent } from "../src/mock";
import { emptyAgentState, type ActionName, type PlayerProfile, type SettingsRequest } from "../src/types";

const HASH = await Bun.password.hash("ognisko");

function setup(
  opts: { online?: boolean; actionStatus?: number; backup?: AgentSource["backup"]; trustedIpHeader?: string; settings?: AgentSource["settings"]; asset?: AgentSource["asset"] } = {},
) {
  const actions: ActionName[] = [];
  const backups: string[] = [];
  const settingsCalls: SettingsRequest[] = [];
  const agent: AgentSource = {
    async getState() {
      return emptyAgentState();
    },
    async getLogs() {
      return [{ ts: "2026-10-09T18:00:00Z", line: "hello" }];
    },
    async action(name) {
      actions.push(name);
      return { status: opts.actionStatus ?? 200, body: { ok: (opts.actionStatus ?? 200) === 200, message: "m" } };
    },
    async backup(name, signal) {
      backups.push(name);
      return opts.backup ? opts.backup(name, signal) : new Response(null, { status: 404 });
    },
    async stream() {},
    async map() {
      return { status: 404, etag: null, body: null };
    },
    async pieces() {
      return new Response(null, { status: 404 });
    },
    async nature() {
      return new Response(null, { status: 404 });
    },
    async asset(path, etag, signal) {
      return opts.asset ? opts.asset(path, etag, signal) : new Response(null, { status: 404 });
    },
    async bridge() {
      return { status: 404, body: { ok: false, message: "not found" } };
    },
    async settings(req) {
      settingsCalls.push(req);
      return opts.settings ? opts.settings(req) : { status: 404, body: { ok: false, message: "not found" } };
    },
  };
  const hub = new Hub(agent, new HistoryStore(":memory:"));
  Object.defineProperty(hub, "online", { get: () => opts.online ?? true });
  let t = 0;
  const app = createApp({
    sessionSecret: "secret",
    passwordHash: HASH,
    secureCookie: true,
    agent,
    hub,
    metrics: async () => null,
    locale: "pl",
    trustedIpHeader: opts.trustedIpHeader ?? "CF-Connecting-IP",
    limiter: new RateLimiter(5, 60_000, 900_000, () => t),
  });
  return { app, actions, backups, settingsCalls, advance: (ms: number) => (t += ms) };
}

const login = (app: ReturnType<typeof setup>["app"], password: string, ip = "9.9.9.9") =>
  app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ password }),
  });

async function sessionCookie(app: ReturnType<typeof setup>["app"]): Promise<string> {
  const res = await login(app, "ognisko");
  expect(res.status).toBe(200);
  const sc = res.headers.get("set-cookie")!;
  expect(sc).toContain("HttpOnly");
  expect(sc).toContain("Secure");
  expect(sc).toContain("SameSite=Strict");
  expect(sc).toContain("Max-Age=2592000");
  return sc.split(";")[0]!;
}

describe("app", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("rejects a wrong password and protects the API", async () => {
    expect((await login(s.app, "nope")).status).toBe(401);
    expect((await s.app.request("/api/state")).status).toBe(401);
    expect((await s.app.request("/api/me")).status).toBe(401);
    expect((await s.app.request("/healthz")).status).toBe(200);
  });

  it("serves the public config before login", async () => {
    const res = await s.app.request("/api/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ locale: "pl" });
  });

  it("logs in and serves state, logs and me", async () => {
    const cookie = await sessionCookie(s.app);
    const me = await s.app.request("/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    const st = await s.app.request("/api/state", { headers: { cookie } });
    const body = (await st.json()) as Record<string, unknown>;
    expect(body.online).toBe(true);
    expect(body.history).toBeDefined();
    expect(body.metrics).toBeNull();
    expect(body.metricsConfigured).toBe(true);
    expect(body.server).toBeDefined();
    const logs = await s.app.request("/api/logs?limit=10", { headers: { cookie } });
    expect(((await logs.json()) as { lines: unknown[] }).lines).toHaveLength(1);
  });

  it("rate limits 5 attempts per minute per CF-Connecting-IP, then locks 15 min", async () => {
    for (let i = 0; i < 5; i++) expect((await login(s.app, "bad")).status).toBe(401);
    const locked = await login(s.app, "ognisko");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
    expect((await login(s.app, "ognisko", "1.1.1.1")).status).toBe(200);
    s.advance(14 * 60_000);
    expect((await login(s.app, "ognisko")).status).toBe(429);
    s.advance(2 * 60_000);
    expect((await login(s.app, "ognisko")).status).toBe(200);
  });

  it("ignores forwarding headers unless one is configured as trusted", async () => {
    const direct = setup({ trustedIpHeader: "" });
    // Rotating a spoofed header must not reset the limiter.
    for (let i = 0; i < 5; i++) expect((await login(direct.app, "bad", `10.0.0.${i}`)).status).toBe(401);
    expect((await login(direct.app, "ognisko", "10.0.0.99")).status).toBe(429);
  });

  it("forwards actions, rejects unknown ones, and refuses when the agent is down", async () => {
    const cookie = await sessionCookie(s.app);
    const res = await s.app.request("/api/action/backup", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(s.actions).toEqual(["backup"]);
    expect((await s.app.request("/api/action/rm-rf", { method: "POST", headers: { cookie } })).status).toBe(404);

    const busy = setup({ actionStatus: 409 });
    const c2 = await sessionCookie(busy.app);
    expect((await busy.app.request("/api/action/restart", { method: "POST", headers: { cookie: c2 } })).status).toBe(409);

    const down = setup({ online: false });
    const c3 = await sessionCookie(down.app);
    expect((await down.app.request("/api/action/restart", { method: "POST", headers: { cookie: c3 } })).status).toBe(503);
    expect(down.actions).toEqual([]);
  });

  it("logout clears the cookie", async () => {
    const res = await s.app.request("/api/logout", { method: "POST" });
    expect(res.headers.get("set-cookie")).toContain("skald_session=;");
  });

  it("validates backup names and streams the agent's zip through without buffering", async () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
    const st = setup({
      backup: async () =>
        new Response(body, {
          headers: { "Content-Type": "application/zip", "Content-Length": "6", "Content-Disposition": 'attachment; filename="worlds-20261009-230500.zip"' },
        }),
    });
    const cookie = await sessionCookie(st.app);
    expect((await st.app.request("/api/backups/worlds-20261009-230500.zip")).status).toBe(401);
    for (const bad of ["worlds-2026109-230500.zip", "worlds-20261009-230500.zip.bak", "..%2Fetc%2Fpasswd", "worlds-20261009-230500.tar"]) {
      expect((await st.app.request(`/api/backups/${bad}`, { headers: { cookie } })).status).toBe(400);
    }
    expect(st.backups).toEqual([]);

    const res = await st.app.request("/api/backups/worlds-20261009-230500.zip", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-length")).toBe("6");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="worlds-20261009-230500.zip"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The first chunk reaches the client while the upstream is still open.
    const reader = res.body!.getReader();
    ctrl.enqueue(new Uint8Array([80, 75, 3]));
    expect(Array.from((await reader.read()).value!)).toEqual([80, 75, 3]);
    ctrl.enqueue(new Uint8Array([4, 0, 0]));
    ctrl.close();
    expect(Array.from((await reader.read()).value!)).toEqual([4, 0, 0]);
    expect((await reader.read()).done).toBe(true);
  });

  it("maps agent backup failures to 404 / 502", async () => {
    const missing = setup();
    const c1 = await sessionCookie(missing.app);
    expect((await missing.app.request("/api/backups/worlds-20261009-230500.zip", { headers: { cookie: c1 } })).status).toBe(404);
    const broken = setup({ backup: async () => new Response("boom", { status: 500 }) });
    const c2 = await sessionCookie(broken.app);
    expect((await broken.app.request("/api/backups/worlds-20261009-230500.zip", { headers: { cookie: c2 } })).status).toBe(502);
    const down = setup({ backup: async () => Promise.reject(new Error("ECONNREFUSED")) });
    const c3 = await sessionCookie(down.app);
    expect((await down.app.request("/api/backups/worlds-20261009-230500.zip", { headers: { cookie: c3 } })).status).toBe(502);
  });

  it("serves player profiles behind the session", async () => {
    expect((await s.app.request("/api/players")).status).toBe(401);
    expect((await s.app.request("/api/players/Ragnar")).status).toBe(401);
    const cookie = await sessionCookie(s.app);
    const list = (await (await s.app.request("/api/players", { headers: { cookie } })).json()) as { players: unknown[] };
    expect(list.players).toEqual([]);
    expect((await s.app.request("/api/players/Nikt", { headers: { cookie } })).status).toBe(404);
  });
});

describe("settings proxy", () => {
  it("needs a session and passes agent status codes and bodies through", async () => {
    const s = setup({
      settings: async (req) => {
        if (req.op === "put") return { status: 400, body: { ok: false, message: "invalid settings", errors: { name: "length" } } };
        if (req.op === "apply") return { status: 409, body: { ok: false, message: "another action is in progress" } };
        if (req.op === "password") return { status: 200, body: { password: "hearth-77" } };
        return { status: 200, body: { pending: true } };
      },
    });
    expect((await s.app.request("/api/settings")).status).toBe(401);
    expect((await s.app.request("/api/settings/password")).status).toBe(401);
    const cookie = await sessionCookie(s.app);
    const get = await s.app.request("/api/settings", { headers: { cookie } });
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(await get.json()).toEqual({ pending: true });
    const pw = await s.app.request("/api/settings/password", { headers: { cookie } });
    expect(await pw.json()).toEqual({ password: "hearth-77" });
    const put = await s.app.request("/api/settings", {
      method: "PUT",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { errors: Record<string, string> }).errors).toEqual({ name: "length" });
    const apply = await s.app.request("/api/settings/apply", { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "now" }) });
    expect(apply.status).toBe(409);
    expect((await s.app.request("/api/settings/apply", { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect(s.settingsCalls).toEqual([{ op: "get" }, { op: "password" }, { op: "put", body: { name: "x" } }, { op: "apply", mode: "now" }, { op: "cancel" }]);
  });

  it("rejects bad bodies and modes before the agent sees them", async () => {
    const s = setup();
    const cookie = await sessionCookie(s.app);
    const h = { cookie, "Content-Type": "application/json" };
    expect((await s.app.request("/api/settings", { method: "PUT", headers: h, body: "nope" })).status).toBe(400);
    expect((await s.app.request("/api/settings", { method: "PUT", headers: h, body: "[1]" })).status).toBe(400);
    expect((await s.app.request("/api/settings/apply", { method: "POST", headers: h, body: JSON.stringify({ mode: "later" }) })).status).toBe(400);
    expect(s.settingsCalls).toHaveLength(0);
    // Feature off in the agent: its 404 comes through.
    expect((await s.app.request("/api/settings", { headers: { cookie } })).status).toBe(404);
  });

  it("answers 503 while the agent is offline", async () => {
    const s = setup({ online: false });
    const cookie = await sessionCookie(s.app);
    expect((await s.app.request("/api/settings", { headers: { cookie } })).status).toBe(503);
    expect(s.settingsCalls).toHaveLength(0);
  });
});

describe("app with the mock agent", () => {
  it("downloads a valid generated zip and serves seeded profiles", async () => {
    const agent = new MockAgent();
    const hub = new Hub(agent, new HistoryStore(":memory:"));
    hub.start();
    // Wait for the hub's since=0 replay of the seeded month.
    for (let i = 0; i < 50 && hub.profiles().length === 0; i++) await Bun.sleep(10);
    const app = createApp({ sessionSecret: "secret", passwordHash: HASH, secureCookie: false, agent, hub, metrics: async () => null });
    const res = await app.request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "ognisko" }) });
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const name = (await agent.getState()).backups[0]!.name;
    const dl = await app.request(`/api/backups/${name}`, { headers: { cookie } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toBe(`attachment; filename="${name}"`);
    const bytes = new Uint8Array(await dl.arrayBuffer());
    expect(bytes.length).toBe(Number(dl.headers.get("content-length")));
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(Array.from(bytes.subarray(bytes.length - 22, bytes.length - 18))).toEqual([0x50, 0x4b, 0x05, 0x06]);
    expect((await app.request("/api/backups/worlds-19990101-000000.zip", { headers: { cookie } })).status).toBe(404);

    const ragnar = (await (await app.request("/api/players/Ragnar", { headers: { cookie } })).json()) as PlayerProfile;
    expect(ragnar.longestStreak).toBeGreaterThanOrEqual(9);
    const earned = new Set(ragnar.badges.filter((b) => b.earnedAt).map((b) => b.id));
    for (const id of ["streak_7", "unbroken", "raid_veteran", "hearth_10"]) expect(earned.has(id)).toBe(true);
    const bjorn = (await (await app.request("/api/players/Bjorn", { headers: { cookie } })).json()) as PlayerProfile;
    expect(bjorn.badges.find((b) => b.id === "night_owl")!.earnedAt).not.toBeNull();
    hub.stop();
    agent.stop();
  });
});

describe("item icons", () => {
  it("proxies the sheet and map behind the session, with ETags and caching", async () => {
    const seen: { path: string; etag: string | null }[] = [];
    const s = setup({
      asset: async (path, etag) => {
        seen.push({ path, etag });
        if (etag === '"b1"') return new Response(null, { status: 304, headers: { ETag: '"b1"' } });
        if (path === "icons/map.json") return new Response('{"build":"b1"}', { headers: { ETag: '"b1"', "Content-Type": "application/json" } });
        return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { ETag: '"b1"', "Content-Type": "image/webp", "Content-Length": "4" } });
      },
    });
    expect((await s.app.request("/api/icons/sheet.webp")).status).toBe(401);
    expect(seen).toEqual([]);
    const cookie = await sessionCookie(s.app);

    const map = await s.app.request("/api/icons/map.json", { headers: { cookie } });
    expect(map.status).toBe(200);
    expect(map.headers.get("etag")).toBe('"b1"');
    expect(map.headers.get("cache-control")).toBe("private, no-cache");
    expect(await map.text()).toBe('{"build":"b1"}');

    const sheet = await s.app.request("/api/icons/sheet.webp?v=b1", { headers: { cookie } });
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get("content-type")).toBe("image/webp");
    expect(sheet.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(Array.from(new Uint8Array(await sheet.arrayBuffer()))).toEqual([82, 73, 70, 70]);

    const again = await s.app.request("/api/icons/sheet.webp?v=b1", { headers: { cookie, "If-None-Match": '"b1"' } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe('"b1"');
    expect(seen.map((x) => x.path)).toEqual(["icons/map.json", "icons/sheet.webp", "icons/sheet.webp"]);
    expect(seen[2]!.etag).toBe('"b1"');
  });

  it("answers 404 when the agent has no icons and 502 when it is unreachable", async () => {
    const off = setup();
    const cookie = await sessionCookie(off.app);
    expect((await off.app.request("/api/icons/map.json", { headers: { cookie } })).status).toBe(404);
    const down = setup({
      asset: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const c2 = await sessionCookie(down.app);
    expect((await down.app.request("/api/icons/sheet.webp", { headers: { cookie: c2 } })).status).toBe(502);
  });

  it("the mock serves a generated sheet covering every item in its map", async () => {
    const agent = new MockAgent();
    const st = await agent.getState();
    expect(st.icons?.available).toBe(true);
    const mapRes = await agent.asset("icons/map.json", null);
    const doc = (await mapRes.json()) as { build: string; size: number; width: number; height: number; items: Record<string, [number, number]> };
    expect(doc.build).toBe(st.icons!.build!);
    for (const name of ["Wood", "SwordBronze", "TrophyDeer", "Coins"]) expect(doc.items[name]).toBeDefined();
    const sheet = new Uint8Array(await (await agent.asset("icons/sheet.webp", null)).arrayBuffer());
    // A PNG of the size map.json gives.
    expect(Array.from(sheet.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(sheet.buffer, sheet.byteOffset);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([doc.width, doc.height]);
    expect((await agent.asset("icons/sheet.webp", `"${doc.build}"`)).status).toBe(304);
    agent.stop();
  });
});

describe("terrain", () => {
  it("proxies the terrain image and its facts behind the session", async () => {
    const s = setup({
      asset: async (path, etag) => {
        if (path === "terrain.json") return new Response('{"build":"k1","radius":10500}', { headers: { "Content-Type": "application/json" } });
        if (path !== "terrain.png") return new Response(null, { status: 404 });
        if (etag === '"t-k1"') return new Response(null, { status: 304, headers: { ETag: '"t-k1"' } });
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { ETag: '"t-k1"', "Content-Type": "image/png" } });
      },
    });
    expect((await s.app.request("/api/terrain.png")).status).toBe(401);
    const cookie = await sessionCookie(s.app);
    const doc = await s.app.request("/api/terrain.json", { headers: { cookie } });
    expect(doc.status).toBe(200);
    expect(doc.headers.get("cache-control")).toBe("private, no-cache");
    const png = await s.app.request("/api/terrain.png?v=k1", { headers: { cookie } });
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect((await s.app.request("/api/terrain.png?v=k1", { headers: { cookie, "If-None-Match": '"t-k1"' } })).status).toBe(304);
  });

  it("the mock paints its own noise as a north-up disc", async () => {
    const agent = new MockAgent();
    const st = await agent.getState();
    expect(st.terrain?.available).toBe(true);
    expect(st.terrain?.request?.seedHash).toBe(st.world.meta!.seed);
    const doc = (await (await agent.asset("terrain.json", null)).json()) as { resolution: number; radius: number };
    const png = new Uint8Array(await (await agent.asset("terrain.png", null)).arrayBuffer());
    const dv = new DataView(png.buffer, png.byteOffset);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([doc.resolution, doc.resolution]);
    agent.stop();
  });
});
