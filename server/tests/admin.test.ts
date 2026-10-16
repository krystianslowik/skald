import { afterEach, describe, expect, it } from "bun:test";
import type { AgentSource, BridgeRequest, ToolsRequest } from "../src/agent";
import { createApp, fillStations, foldActor } from "../src/app";
import { ADMIN_IDLE_MS, RateLimiter } from "../src/auth";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { MockAgent } from "../src/mock";
import type { SendResult } from "../src/notify";
import { emptyAgentState, type AdminStatus, type AgentEvent, type LiveMessage } from "../src/types";

const PANEL = await Bun.password.hash("ognisko");
const ADMIN = await Bun.password.hash("jarl");

function fakeAgent(calls: BridgeRequest[], status = 200, toolCalls: ToolsRequest[] = []): AgentSource {
  return {
    async getState() {
      const st = emptyAgentState();
      st.server.world = "Testheim";
      return st;
    },
    async tools(req) {
      toolCalls.push(req);
      if (req.op === "access") return { status: 200, body: { ok: true, data: { writable: true, running: true, admins: { entries: [{ id: "X_1234500000000001", platform: "xbox", known: true }], live: false }, bans: { entries: [], live: true }, online: [] } } };
      if (req.op === "restore-info") return { status: 200, body: { ok: true, data: { world: "Testheim", running: false, playersOnline: false, backups: [] } } };
      if (req.op === "restore") return { status: 202, body: { ok: true, data: { backup: req.body.backup } } };
      return { status: 200, body: { ok: true, data: { applies: "restart" } } };
    },
    async getLogs() {
      return [];
    },
    async action() {
      return { status: 200, body: { ok: true, message: "sent" } };
    },
    async backup() {
      return new Response(null, { status: 404 });
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
    async asset() {
      return new Response(null, { status: 404 });
    },
    async settings() {
      return { status: 200, body: { ok: true } };
    },
    async bridge(req) {
      calls.push(req);
      if (status !== 200) return { status, body: { ok: false, message: "not found" } };
      if (req.op === "status") return { status: 200, body: { available: true, gameBuild: "l-1.0.17", tested: true, acknowledged: false, worldLoaded: true, timeFrozen: false, testedBuilds: ["l-1.0.17"], commands: [] } };
      if (req.op === "read" && req.name === "events") return { status: 200, body: { ok: true, data: { current: null, available: ["wolves"] } } };
      if (req.op === "read" && req.name === "globalkeys") return { status: 200, body: { ok: true, data: ["defeated_eikthyr"] } };
      if (req.op === "read" && req.name === "locations") return { status: 200, body: { ok: true, data: { aliases: ["spawn"], locations: ["x"] } } };
      // A bridge older than 0.3.0 has no station list.
      if (req.op === "read" && req.name === "stations") return { status: 404, body: { ok: false, error: "no route GET /v1/build/stations" } };
      return { status: 200, body: { ok: true, data: { near: "Ragnar" } } };
    },
  };
}

async function setup(opts: { admin?: boolean; bridgeStatus?: number; notifyTest?: () => Promise<SendResult> } = {}) {
  const calls: BridgeRequest[] = [];
  const toolCalls: ToolsRequest[] = [];
  const agent = fakeAgent(calls, opts.bridgeStatus, toolCalls);
  const hub = new Hub(agent, new HistoryStore(":memory:"));
  Object.defineProperty(hub, "online", { get: () => true });
  // The world name the restore confirmation is checked against.
  await (hub as unknown as { pollState(): Promise<void> }).pollState();
  let t = 1_000_000;
  const app = createApp({
    sessionSecret: "secret",
    passwordHash: PANEL,
    adminPasswordHash: opts.admin ? ADMIN : "",
    secureCookie: true,
    agent,
    hub,
    metrics: async () => null,
    trustedIpHeader: "CF-Connecting-IP",
    limiter: new RateLimiter(5, 60_000, 900_000, () => t),
    adminLimiter: new RateLimiter(5, 60_000, 900_000, () => t),
    clock: () => t,
    notifyTest: opts.notifyTest,
  });
  return { app, calls, toolCalls, advance: (ms: number) => (t += ms) };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

async function signIn(app: App): Promise<string> {
  const res = await app.request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "ognisko" }) });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

const post = (app: App, path: string, cookie: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });

const adminCookie = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";

describe("admin without an admin password", () => {
  it("lets everyone signed in command the bridge, with a session-hash actor", async () => {
    const { app, calls } = await setup();
    expect((await post(app, "/api/admin/spawn", "", { item: "Wood" })).status).toBe(401);
    const cookie = await signIn(app);
    const st = (await (await app.request("/api/admin/status", { headers: { Cookie: cookie } })).json()) as AdminStatus;
    expect(st).toMatchObject({ required: false, unlocked: true, idleMs: ADMIN_IDLE_MS, bridge: { available: true } });
    const res = await post(app, "/api/admin/spawn", cookie, { item: "Wood", amount: 20, player: "Ragnar" });
    expect(res.status).toBe(200);
    const run = calls.find((c) => c.op === "run")!;
    expect(run).toMatchObject({ op: "run", command: "spawn", body: { item: "Wood", amount: 20, player: "Ragnar" } });
    expect((run as { actor: string }).actor).toMatch(/^dashboard-[0-9a-f]{6}$/);
    await post(app, "/api/admin/save", cookie, undefined, { "X-Skald-Name": encodeURIComponent("Łukasz Żółw <script>") });
    expect((calls.at(-1) as { actor: string }).actor).toBe("Lukasz-Zolw-script");
  });

  it("keeps the allow-list and body limits", async () => {
    const { app } = await setup();
    const cookie = await signIn(app);
    expect((await post(app, "/api/admin/godmode", cookie, {})).status).toBe(404);
    expect((await post(app, "/api/admin/save", cookie, "[1,2]")).status).toBe(400);
    expect((await post(app, "/api/admin/save", cookie, "{oops")).status).toBe(400);
    expect((await post(app, "/api/admin/save", cookie, { text: "x".repeat(5000) })).status).toBe(413);
    expect((await app.request("/api/admin/read/weather", { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await app.request("/api/admin/read/time", { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("reports the bridge off when the agent has no bridge", async () => {
    const { app } = await setup({ bridgeStatus: 404 });
    const cookie = await signIn(app);
    const st = (await (await app.request("/api/admin/status", { headers: { Cookie: cookie } })).json()) as AdminStatus;
    expect(st.bridge).toMatchObject({ available: false, reason: "off" });
  });

  it("builds the catalog from events, keys and spots", async () => {
    const { app } = await setup();
    const cookie = await signIn(app);
    const cat = await (await app.request("/api/admin/catalog", { headers: { Cookie: cookie } })).json();
    // The bridge is older than 0.3.0: the catalog still answers, with no stations.
    expect(cat).toEqual({ events: ["wolves"], currentEvent: null, globalKeys: ["defeated_eikthyr"], spots: ["spawn"], stations: { kilns: [], smelters: [] } });
  });

  it("keeps only well-formed fill stations", () => {
    expect(
      fillStations({
        kilns: [{ prefab: "charcoal_kiln", inputs: ["Wood", 7] }, { inputs: ["Wood"] }],
        smelters: [{ prefab: "blastfurnace", fuel: "Coal", inputs: ["BlackMetalScrap"] }, { prefab: "odd", inputs: "x" }, null],
      }),
    ).toEqual({
      kilns: [{ prefab: "charcoal_kiln", inputs: ["Wood"] }],
      smelters: [
        { prefab: "blastfurnace", fuel: "Coal", inputs: ["BlackMetalScrap"] },
        { prefab: "odd", fuel: null, inputs: [] },
      ],
    });
    expect(fillStations(undefined)).toEqual({ kilns: [], smelters: [] });
  });
});

describe("admin with an admin password", () => {
  it("keeps the panel password view-only until unlocked", async () => {
    const { app, calls } = await setup({ admin: true });
    const cookie = await signIn(app);
    const st = (await (await app.request("/api/admin/status", { headers: { Cookie: cookie } })).json()) as AdminStatus;
    expect(st).toMatchObject({ required: true, unlocked: false });
    for (const [method, path] of [
      ["POST", "/api/admin/spawn"],
      ["GET", "/api/admin/players"],
      ["GET", "/api/admin/catalog"],
      ["POST", "/api/action/restart"],
      ["PUT", "/api/settings"],
      ["POST", "/api/settings/apply"],
      ["DELETE", "/api/settings/apply"],
      ["GET", "/api/settings/password"],
    ] as const) {
      const res = await app.request(path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("admin_required");
    }
    expect(calls.filter((c) => c.op === "run")).toHaveLength(0);
    // Reading stays open.
    expect((await app.request("/api/state", { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("unlocks with the admin password, slides the idle timeout and locks again", async () => {
    const { app, advance } = await setup({ admin: true });
    const cookie = await signIn(app);
    expect((await post(app, "/api/admin/unlock", cookie, { password: "ognisko" })).status).toBe(401);
    const res = await post(app, "/api/admin/unlock", cookie, { password: "jarl" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=1800");
    let admin = adminCookie(res);
    const both = () => `${cookie}; ${admin}`;
    let r = await post(app, "/api/admin/save", both(), {});
    expect(r.status).toBe(200);
    admin = adminCookie(r) || admin;
    expect((await post(app, "/api/action/backup", both())).status).toBe(200);
    // The server password too, once unlocked.
    expect((await app.request("/api/settings/password", { headers: { Cookie: both() } })).status).toBe(200);
    // 29 minutes idle: still in; each call restarts the clock.
    advance(29 * 60_000);
    r = await post(app, "/api/admin/save", both(), {});
    expect(r.status).toBe(200);
    admin = adminCookie(r);
    advance(29 * 60_000);
    expect((await post(app, "/api/admin/save", both(), {})).status).toBe(200);
    // 31 minutes idle: out.
    advance(31 * 60_000);
    expect((await post(app, "/api/admin/save", both(), {})).status).toBe(403);
  });

  it("does not accept an admin cookie next to another session", async () => {
    const { app } = await setup({ admin: true });
    const a = await signIn(app);
    const b = await signIn(app);
    const admin = adminCookie(await post(app, "/api/admin/unlock", a, { password: "jarl" }));
    expect((await post(app, "/api/admin/save", `${b}; ${admin}`, {})).status).toBe(403);
    expect((await post(app, "/api/admin/save", `${a}; ${admin}`, {})).status).toBe(200);
    const locked = await post(app, "/api/admin/lock", `${a}; ${admin}`);
    expect(locked.headers.get("set-cookie")).toContain("skald_admin=;");
  });

  it("leaves only status, unlock and lock open to a signed-in non-admin", async () => {
    const { app } = await setup({ admin: true });
    const cookie = await signIn(app);
    const get = (path: string) => app.request(path, { headers: { Cookie: cookie } });
    expect((await get("/api/admin/status")).status).toBe(200);
    expect((await post(app, "/api/admin/unlock", cookie, { password: "nope" })).status).toBe(401);
    expect((await post(app, "/api/admin/lock", cookie)).status).toBe(200);
    for (const path of ["/api/admin/players", "/api/admin/catalog", "/api/admin/access", "/api/admin/restore", "/api/admin/read/time", "/api/admin/status/", "/api/admin/statusx"]) {
      expect([path, (await get(path)).status]).toEqual([path, 403]);
    }
    for (const path of ["/api/admin/save", "/api/admin/status", "/api/admin/restore", "/api/admin/access/admins/add"]) {
      expect([path, (await post(app, path, cookie, {})).status]).toEqual([path, 403]);
    }
    // The open three are open for their own method only.
    expect((await get("/api/admin/unlock")).status).toBe(403);
    expect((await get("/api/admin/lock")).status).toBe(403);
  });

  it("rate-limits unlock attempts like logins", async () => {
    const { app } = await setup({ admin: true });
    const cookie = await signIn(app);
    for (let i = 0; i < 5; i++) expect((await post(app, "/api/admin/unlock", cookie, { password: "nope" })).status).toBe(401);
    const res = await post(app, "/api/admin/unlock", cookie, { password: "jarl" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    // A login from the same address is a separate bucket.
    expect((await app.request("/api/login", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" }, body: JSON.stringify({ password: "ognisko" }) })).status).toBe(200);
  });
});

describe("foldActor", () => {
  it("keeps the plugin's characters only", () => {
    expect(foldActor("Sigrun")).toBe("Sigrun");
    expect(foldActor("  Ólafur  Þór ")).toBe("Olafur-or");
    expect(foldActor("a".repeat(80))).toHaveLength(40);
  });
});

describe("live positions in the hub", () => {
  const pos = (n: number): AgentEvent => ({ seq: 0, ts: new Date(1_000_000 + n).toISOString(), type: "positions", data: { t: n, players: [{ name: "Ragnar", platform: "xbox", x: n, z: 0, health: 1, maxHealth: 2 }] } });
  let hub: Hub | null = null;
  afterEach(() => hub?.stop());

  it("passes positions on at most every 2 s, never stores them, and hands the latest to new watchers", async () => {
    let now = 1_000_000;
    const store = new HistoryStore(":memory:");
    hub = new Hub(fakeAgent([]), store, { clock: () => now });
    const got: LiveMessage[] = [];
    hub.subscribe((m) => got.push(m));
    hub.watchPositions((m) => got.push(m));
    hub.ingest("e", { seq: 5, ts: new Date(now).toISOString(), type: "player_join", data: { name: "Ragnar" } });
    hub.ingest("e", pos(1));
    hub.ingest("e", pos(2));
    hub.ingest("e", pos(3));
    expect(got.filter((m) => m.type === "positions")).toHaveLength(1);
    now += 2_000;
    await Bun.sleep(2_050);
    const sent = got.filter((m) => m.type === "positions") as Extract<LiveMessage, { type: "positions" }>[];
    expect(sent).toHaveLength(2);
    expect(sent[1]!.players[0]!.x).toBe(3);
    // The seq-0 events did not disturb the stream position or the history.
    hub.ingest("e", { seq: 6, ts: new Date(now).toISOString(), type: "death", data: { name: "Ragnar" } });
    expect(store.all().map((e) => e.type)).toEqual(["player_join", "death"]);
    expect(hub.latestPositions()).toMatchObject({ type: "positions", t: 3 });
    // The agent sends only changes: a sample from long ago is still the current one.
    now += 60_000;
    expect(hub.latestPositions()).toMatchObject({ type: "positions", t: 3 });
  });
});

describe("mock bridge", () => {
  it("answers commands, moves players and writes admin events", async () => {
    const mock = new MockAgent(Date.now, "UTC");
    const evs: AgentEvent[] = [];
    const abort = new AbortController();
    void mock.stream(1_000_000, (e) => evs.push(e), abort.signal);
    const st = await mock.bridge({ op: "status" });
    expect(st.body).toMatchObject({ available: true, tested: true });
    const players = (await mock.bridge({ op: "players" })).body as { data: { players: { name: string; platform: string; x: number }[] } };
    expect(players.data.players.map((p) => p.name).sort()).toEqual(["Freya", "Ragnar"]);
    expect(JSON.stringify(players)).not.toMatch(/uid|platformId|userId|playfab/i);
    const spawn = await mock.bridge({ op: "run", command: "spawn", body: { items: [{ item: "Wood", amount: 20 }], player: "Ragnar" }, actor: "tester" });
    expect(spawn.status).toBe(200);
    const admin = evs.find((e) => e.type === "admin")!;
    expect(admin.data).toMatchObject({ actor: "tester", command: "spawn", result: "ok", player: "Ragnar", items: [{ item: "Wood", amount: 20 }] });
    const tp = await mock.bridge({ op: "run", command: "teleport", body: { player: "Freya", toSpot: "eikthyr" }, actor: "tester" });
    expect(tp.status).toBe(200);
    const after = (await mock.bridge({ op: "players" })).body as { data: { players: { name: string; x: number; z: number }[] } };
    expect(after.data.players.find((p) => p.name === "Freya")).toMatchObject({ x: 330, z: 140 });
    expect((await mock.bridge({ op: "run", command: "kick", body: { player: "Nobody" }, actor: "t" })).status).toBe(404);
    expect((await mock.bridge({ op: "run", command: "broadcast", body: { text: "hi", type: "chat" }, actor: "t" })).status).toBe(501);
    const bans = (await mock.bridge({ op: "read", name: "bans" })).body as { data: { id: string }[] };
    expect((await mock.bridge({ op: "run", command: "unban", body: { id: bans.data[0]!.id }, actor: "t" })).status).toBe(200);
    abort.abort();
    mock.stop();
  });

  it("fills kilns with wood and smelters with the chosen ore", async () => {
    const mock = new MockAgent(Date.now, "UTC");
    const evs: AgentEvent[] = [];
    const abort = new AbortController();
    void mock.stream(1_000_000, (e) => evs.push(e), abort.signal);
    const st = (await mock.bridge({ op: "read", name: "stations" })).body as { data: { smelters: { inputs: string[] }[] } };
    expect(st.data.smelters.flatMap((s) => s.inputs)).toContain("IronScrap");
    const run = (body: Record<string, unknown>, command: "fill-kilns" | "fill-smelters" = "fill-smelters") => mock.bridge({ op: "run", command, body: { player: "Ragnar", ...body }, actor: "t" });
    expect((await run({}, "fill-kilns")).status).toBe(200);
    expect((await run({ what: "both", ore: "IronScrap" })).status).toBe(200);
    expect((await run({ what: "coal" })).status).toBe(200);
    expect((await run({ what: "ore", ore: "current" })).status).toBe(200);
    expect((await run({ what: "both", ore: "current" })).status).toBe(200);
    expect((await run({ what: "ore" })).status).toBe(400);
    expect((await run({ what: "everything", ore: "IronScrap" })).status).toBe(400);
    expect((await run({ ore: "Barley" })).status).toBe(400);
    const fills = evs.filter((e) => e.type === "admin").map((e) => e.data);
    expect(fills[0]).toMatchObject({ command: "fill-kilns", added: { Wood: expect.any(Number) }, player: "Ragnar" });
    expect(fills[0]).not.toHaveProperty("fuel");
    // A blast furnace does not take iron: two smelters filled, one skipped.
    expect(fills[1]).toMatchObject({ command: "fill-smelters", what: "both", ore: "IronScrap", smelters: 2, skipped: 1, added: { IronScrap: 2 }, fuel: "Coal" });
    expect(fills[2]).toMatchObject({ command: "fill-smelters", what: "coal", smelters: 3, added: {}, fuel: "Coal" });
    // Keep the current ore: only the smelter holding iron gets ore; with coal the empty ones get coal.
    expect(fills[3]).toMatchObject({ what: "ore", ore: "current", smelters: 1, skipped: 2, added: { IronScrap: 1 } });
    expect(fills[3]).not.toHaveProperty("fuel");
    expect(fills[4]).toMatchObject({ what: "both", ore: "current", smelters: 3, skipped: 0, added: { IronScrap: 1 }, fuel: "Coal" });
    abort.abort();
    mock.stop();
  });

  it("can play a bridge that is off, disabled or on an untested build", async () => {
    expect((await new MockAgent(Date.now, "UTC", "off").bridge({ op: "status" })).status).toBe(404);
    expect((await new MockAgent(Date.now, "UTC", "disabled").bridge({ op: "status" })).body).toMatchObject({ available: false, reason: "disabled" });
    const m = new MockAgent(Date.now, "UTC", "untested");
    expect((await m.bridge({ op: "status" })).body).toMatchObject({ available: true, tested: false, acknowledged: false, gameBuild: "l-1.0.18" });
    expect((await m.bridge({ op: "run", command: "save", body: {}, actor: "t" })).status).toBe(409);
    expect((await m.bridge({ op: "run", command: "ack-build", body: { build: "l-1.0.18" }, actor: "t" })).status).toBe(200);
    expect((await m.bridge({ op: "status" })).body).toMatchObject({ acknowledged: true });
    expect((await m.bridge({ op: "run", command: "save", body: {}, actor: "t" })).status).toBe(200);
    m.stop();
  });
});

describe("admin and ban lists, world restore", () => {
  const get = (app: App, path: string, cookie: string) => app.request(path, { headers: { Cookie: cookie } });

  it("needs an admin session for every list and restore route, reads included", async () => {
    const { app, toolCalls } = await setup({ admin: true });
    const cookie = await signIn(app);
    for (const [method, path] of [
      ["GET", "/api/admin/access"],
      ["POST", "/api/admin/access/admins/add"],
      ["POST", "/api/admin/access/bans/remove"],
      ["GET", "/api/admin/restore"],
      ["POST", "/api/admin/restore"],
    ] as const) {
      const res = await app.request(path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: method === "GET" ? undefined : '{"id":"X_1"}' });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(toolCalls).toHaveLength(0);
    // Without a panel session at all, not even a 403.
    expect((await app.request("/api/admin/access")).status).toBe(401);
    // Platform ids never reach the public state.
    const state = await (await get(app, "/api/state", cookie)).text();
    expect(state).not.toContain("X_1234500000000001");
  });

  it("passes list changes through with the actor and checks the body", async () => {
    const { app, toolCalls } = await setup();
    const cookie = await signIn(app);
    const res = await get(app, "/api/admin/access", cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { admins: { entries: { id: string }[] } } }).data.admins.entries[0]!.id).toBe("X_1234500000000001");
    expect((await post(app, "/api/admin/access/admins/add", cookie, { id: "X_1234500000000002" }, { "X-Skald-Name": "Jarl" })).status).toBe(200);
    expect(toolCalls.at(-1)).toEqual({ op: "access-change", list: "admins", change: "add", body: { id: "X_1234500000000002" }, actor: "Jarl" });
    expect((await post(app, "/api/admin/access/bans/add", cookie, { player: "Ragnar" })).status).toBe(200);
    expect(toolCalls.at(-1)).toMatchObject({ list: "bans", body: { player: "Ragnar" } });
    expect((await post(app, "/api/admin/access/owners/add", cookie, { id: "X_1" })).status).toBe(404);
    expect((await post(app, "/api/admin/access/admins/wipe", cookie, { id: "X_1" })).status).toBe(404);
    expect((await post(app, "/api/admin/access/admins/add", cookie, {})).status).toBe(400);
    expect((await post(app, "/api/admin/access/admins/add", cookie, { id: "X_1", player: "Ragnar" })).status).toBe(400);
    expect((await post(app, "/api/admin/access/admins/add", cookie, "[1]")).status).toBe(400);
    expect((await post(app, "/api/admin/access/admins/add", cookie, { id: "x".repeat(5000) })).status).toBe(413);
    expect(toolCalls.filter((c) => c.op === "access-change")).toHaveLength(2);
  });

  it("starts a restore only with the world name typed and a known backup name", async () => {
    const { app, toolCalls } = await setup();
    const cookie = await signIn(app);
    expect((await get(app, "/api/admin/restore", cookie)).status).toBe(200);
    const body = { source: "image", backup: "worlds-20261010-100000.zip", confirm: "Testheim" };
    expect((await post(app, "/api/admin/restore", cookie, { ...body, confirm: "testheim" })).status).toBe(400);
    expect((await post(app, "/api/admin/restore", cookie, { ...body, confirm: undefined })).status).toBe(400);
    expect((await post(app, "/api/admin/restore", cookie, { ...body, backup: "../worlds-20261010-100000.zip" })).status).toBe(400);
    expect((await post(app, "/api/admin/restore", cookie, { ...body, source: "skald" })).status).toBe(400);
    expect((await post(app, "/api/admin/restore", cookie, { ...body, source: "nfs" })).status).toBe(400);
    expect(toolCalls.filter((c) => c.op === "restore")).toHaveLength(0);
    expect((await post(app, "/api/admin/restore", cookie, body)).status).toBe(202);
    expect((await post(app, "/api/admin/restore", cookie, { ...body, source: "skald", backup: "pre-restore-20261010-100000.zip" })).status).toBe(202);
    expect(toolCalls.filter((c) => c.op === "restore")).toHaveLength(2);
  });
});

describe("MockAgent tools", () => {
  it("lists, changes and restores like the agent, without ids in events", async () => {
    const m = new MockAgent();
    const seen: AgentEvent[] = [];
    const ctl = new AbortController();
    void m.stream(Number.MAX_SAFE_INTEGER, (e) => seen.push(e), ctl.signal);
    const access = (await m.tools({ op: "access" })).body as { data: { admins: { entries: { name?: string }[] } } };
    expect(access.data.admins.entries[0]!.name).toBe("Freya");
    expect((await m.tools({ op: "access-change", list: "admins", change: "add", body: { id: "nope" }, actor: "t" })).status).toBe(400);
    expect((await m.tools({ op: "access-change", list: "admins", change: "add", body: { id: "X_1234500000000077" }, actor: "t" })).status).toBe(200);
    expect(JSON.stringify(seen)).not.toContain("1234500000000077");
    expect((await m.tools({ op: "restore", body: { source: "image", backup: "x", confirm: "Midgard" }, actor: "t" })).status).toBe(400);
    ctl.abort();
    m.stop();
  });
});

describe("HttpAgent.bridge", () => {
  it("maps calls to the agent's /bridge routes", async () => {
    const { HttpAgent } = await import("../src/agent");
    const seen: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body as string | undefined });
      return new Response(JSON.stringify({ ok: true, data: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = new HttpAgent("http://agent:8080", "tok", fetchImpl);
    await a.bridge({ op: "status" });
    await a.bridge({ op: "players" });
    await a.bridge({ op: "read", name: "bans" });
    const res = await a.bridge({ op: "run", command: "heal", body: { player: "Ragnar" }, actor: "dashboard-abc123" });
    expect(res).toEqual({ status: 200, body: { ok: true, data: 1 } });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET http://agent:8080/bridge/status",
      "GET http://agent:8080/bridge/players",
      "GET http://agent:8080/bridge/bans",
      "POST http://agent:8080/bridge/heal",
    ]);
    expect(seen[3]!.headers).toMatchObject({ "X-Agent-Token": "tok", "X-Skald-Actor": "dashboard-abc123", "Content-Type": "application/json" });
    expect(seen[3]!.body).toBe('{"player":"Ragnar"}');
  });

  it("maps the file tools to /access and /restore", async () => {
    const { HttpAgent } = await import("../src/agent");
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method ?? "GET"} ${url} ${(init.headers as Record<string, string>)["X-Skald-Actor"] ?? ""} ${init.body ?? ""}`.trim());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = new HttpAgent("http://agent:8080", "tok", fetchImpl);
    await a.tools({ op: "access" });
    await a.tools({ op: "access-change", list: "bans", change: "remove", body: { id: "V_1" }, actor: "jarl" });
    await a.tools({ op: "restore-info" });
    await a.tools({ op: "restore", body: { source: "image" }, actor: "jarl" });
    expect(seen).toEqual([
      "GET http://agent:8080/access",
      'POST http://agent:8080/access/bans/remove jarl {"id":"V_1"}',
      "GET http://agent:8080/restore",
      'POST http://agent:8080/restore jarl {"source":"image"}',
    ]);
  });
});

describe("discord test notification", () => {
  it("says whether it is configured and needs an admin session to send", async () => {
    let sent = 0;
    const { app } = await setup({ admin: true, notifyTest: async () => (sent++, { ok: true }) });
    const cookie = await signIn(app);
    const st = (await (await app.request("/api/admin/status", { headers: { Cookie: cookie } })).json()) as AdminStatus;
    expect(st.notifyConfigured).toBe(true);
    expect(JSON.stringify(st)).not.toContain("webhook");
    expect((await post(app, "/api/notify/test", cookie)).status).toBe(403);
    expect(sent).toBe(0);
    const admin = adminCookie(await post(app, "/api/admin/unlock", cookie, { password: "jarl" }));
    const res = await post(app, "/api/notify/test", `${cookie}; ${admin}`);
    expect(res.status).toBe(200);
    expect(sent).toBe(1);
  });

  it("answers 404 when off and 502 with the redacted error when Discord fails", async () => {
    const off = await setup();
    const c1 = await signIn(off.app);
    expect(((await (await off.app.request("/api/admin/status", { headers: { Cookie: c1 } })).json()) as AdminStatus).notifyConfigured).toBe(false);
    expect((await post(off.app, "/api/notify/test", c1)).status).toBe(404);
    const failing = await setup({ notifyTest: async () => ({ ok: false, error: "HTTP 401" }) });
    const c2 = await signIn(failing.app);
    const res = await post(failing.app, "/api/notify/test", c2);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "HTTP 401" });
  });
});
