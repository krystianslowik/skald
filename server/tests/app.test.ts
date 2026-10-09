import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentSource } from "../src/agent";
import { createApp } from "../src/app";
import { RateLimiter } from "../src/auth";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { MockAgent } from "../src/mock";
import { emptyAgentState, type ActionName, type PlayerProfile } from "../src/types";

const HASH = await Bun.password.hash("ognisko");

function setup(opts: { online?: boolean; actionStatus?: number; backup?: AgentSource["backup"]; trustedIpHeader?: string } = {}) {
  const actions: ActionName[] = [];
  const backups: string[] = [];
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
  return { app, actions, backups, advance: (ms: number) => (t += ms) };
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
