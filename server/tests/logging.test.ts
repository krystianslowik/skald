import { describe, expect, it } from "bun:test";
import type { AgentSource } from "../src/agent";
import { createApp } from "../src/app";
import { RateLimiter } from "../src/auth";
import { checkPasswordHash } from "../src/config";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { cause, createLogger, type Logger } from "../src/log";
import { fetchMetrics } from "../src/prom";
import { emptyAgentState } from "../src/types";

const HASH = await Bun.password.hash("ognisko");

/** A logger that keeps its lines, parsed, and a clock the test moves. */
function capture(windowMs = 60_000) {
  const lines: Record<string, unknown>[] = [];
  let t = Date.parse("2026-10-17T12:00:00Z");
  const log = createLogger({ write: (l) => lines.push(JSON.parse(l)), clock: () => t, windowMs });
  return { log, lines, advance: (ms: number) => (t += ms) };
}

const down = () => Promise.reject(new Error("Unable to connect. Is the computer able to access the url?"));

/** An agent that refuses every connection. */
function deadAgent(): AgentSource {
  return {
    getState: down,
    getLogs: down,
    action: down,
    backup: down,
    stream: down,
    map: down,
    pieces: down,
    nature: down,
    asset: down,
    bridge: down,
    tools: down,
    settings: down,
  };
}

function setup(log: Logger, agent: AgentSource = deadAgent(), adminPasswordHash?: string, verifyPassword?: (p: string, h: string) => Promise<boolean>) {
  const hub = new Hub(agent, new HistoryStore(":memory:"), { log });
  Object.defineProperty(hub, "online", { get: () => true });
  return createApp({
    sessionSecret: "secret",
    passwordHash: HASH,
    adminPasswordHash,
    secureCookie: true,
    agent,
    hub,
    metrics: async () => null,
    trustedIpHeader: "CF-Connecting-IP",
    limiter: new RateLimiter(5, 60_000, 900_000, () => 0),
    adminLimiter: new RateLimiter(5, 60_000, 900_000, () => 0),
    verifyPassword,
    log,
  });
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers },
    body: JSON.stringify(body),
  });

async function cookieFor(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await post(app, "/api/login", { password: "ognisko" });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

describe("logger", () => {
  it("writes one JSON line with time, level, msg and fields", () => {
    const c = capture();
    c.log.warn("agent unreachable", { route: "/api/logs", status: 502, cause: "refused", skipped: undefined });
    expect(c.lines).toEqual([{ time: "2026-10-17T12:00:00.000Z", level: "WARN", msg: "agent unreachable", route: "/api/logs", status: 502, cause: "refused" }]);
  });

  it("prints a repeated failure once per window and counts the rest", () => {
    const c = capture();
    for (let i = 0; i < 50; i++) c.log.warn("agent unreachable", { route: "/api/logs" });
    c.log.warn("agent unreachable", { route: "/api/settings" });
    expect(c.lines).toHaveLength(2);
    c.advance(60_000);
    c.log.warn("agent unreachable", { route: "/api/logs" });
    expect(c.lines).toHaveLength(3);
    expect(c.lines[2]!.suppressed).toBe(49);
  });

  it("keeps different client addresses apart", () => {
    const c = capture();
    c.log.warn("login failed", { route: "/api/login", ip: "203.0.113.1" });
    c.log.warn("login failed", { route: "/api/login", ip: "203.0.113.2" });
    c.log.warn("login failed", { route: "/api/login", ip: "203.0.113.1" });
    expect(c.lines.map((l) => l.ip)).toEqual(["203.0.113.1", "203.0.113.2"]);
  });

  it("strips credentials out of URLs in a cause and keeps it short", () => {
    expect(cause(new Error("fetch http://user:hunter2@prom:9090/api failed"))).toBe("fetch http://prom:9090/api failed");
    expect(cause(new Error("fetch https://u:p/ss@prom/api failed"))).toBe("fetch https://prom/api failed");
    expect(cause(new Error("GET https://prom/api?token=hunter2 failed"))).toBe("GET https://prom/api?... failed");
    expect(cause(new Error("x".repeat(500))).length).toBeLessThan(210);
    expect(cause("plain")).toBe("plain");
  });
});

describe("app failure log", () => {
  it("logs an unreachable agent with the route pattern, never the path", async () => {
    const c = capture();
    const app = setup(c.log);
    const cookie = await cookieFor(app);
    expect((await app.request("/api/logs", { headers: { cookie } })).status).toBe(502);
    expect((await app.request("/api/backups/worlds-20261017-120000.zip", { headers: { cookie } })).status).toBe(502);
    expect((await post(app, "/api/admin/access/bans/add", { id: "Steam_76561190000000000" }, { cookie })).status).toBe(502);
    const agent = c.lines.filter((l) => l.msg === "agent unreachable");
    expect(agent.map((l) => l.route)).toEqual(["/api/logs", "/api/backups/:name", "/api/admin/access/:list/:op"]);
    expect(agent[0]).toMatchObject({ level: "WARN", method: "GET", status: 502, cause: "Unable to connect. Is the computer able to access the url?" });
    const all = JSON.stringify(c.lines);
    expect(all).not.toContain("worlds-20261017");
    expect(all).not.toContain("Steam_");
    expect(all).not.toContain("skald_session");
  });

  it("logs agent 5xx answers it passes on", async () => {
    const c = capture();
    const agent = { ...deadAgent(), settings: async () => ({ status: 500, body: { ok: false, message: "boom" } }) };
    const app = setup(c.log, agent);
    const cookie = await cookieFor(app);
    expect((await app.request("/api/settings", { headers: { cookie } })).status).toBe(500);
    expect(c.lines).toContainEqual(expect.objectContaining({ msg: "agent error", route: "/api/settings", status: 500, upstream: 500 }));
  });

  it("logs a refused agent answer that becomes a 502, but not a request the browser cancelled", async () => {
    const c = capture();
    const agent: AgentSource = {
      ...deadAgent(),
      asset: async () => new Response(null, { status: 401 }),
      getLogs: async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    };
    const app = setup(c.log, agent);
    const cookie = await cookieFor(app);
    expect((await app.request("/api/icons/map.json", { headers: { cookie } })).status).toBe(502);
    expect(c.lines).toContainEqual(expect.objectContaining({ msg: "agent error", route: "/api/icons/map.json", status: 502, upstream: 401 }));
    const cancelled = new AbortController();
    cancelled.abort();
    await app.request("/api/logs", { headers: { cookie }, signal: cancelled.signal });
    expect(c.lines.filter((l) => l.msg === "agent unreachable")).toHaveLength(0);
  });

  it("logs wrong passwords and lockouts with the address, never the password", async () => {
    const c = capture(0);
    const app = setup(c.log);
    for (let i = 0; i < 5; i++) expect((await post(app, "/api/login", { password: "hunter2" })).status).toBe(401);
    expect((await post(app, "/api/login", { password: "hunter2" })).status).toBe(429);
    expect(c.lines.filter((l) => l.msg === "login failed")).toHaveLength(5);
    expect(c.lines.at(-1)).toMatchObject({ msg: "login locked", route: "/api/login", status: 429, ip: "203.0.113.7", retryAfter: 900 });
    expect(JSON.stringify(c.lines)).not.toContain("hunter2");
  });

  it("logs a password check that throws as an error, not as a wrong password only", async () => {
    const c = capture();
    const broken = async () => {
      throw new Error('Password verification failed with error "InvalidEncoding"');
    };
    const app = setup(c.log, deadAgent(), "$argon2id$broken", broken);
    expect((await post(app, "/api/login", { password: "ognisko" })).status).toBe(401);
    expect(c.lines[0]).toMatchObject({ level: "ERROR", msg: "password check failed", route: "/api/login" });
    expect(JSON.stringify(c.lines)).not.toContain("ognisko");
  });
});

describe("hub and prometheus failure log", () => {
  it("logs a lost agent stream once a minute, then the recovery", async () => {
    const c = capture();
    let fail = true;
    const agent: AgentSource = {
      ...deadAgent(),
      getState: async () => {
        if (fail) throw new Error("Unable to connect");
        return emptyAgentState();
      },
      stream: (_since, onEvent, signal) => {
        onEvent({ seq: 1, ts: "2026-10-17T12:00:00Z", type: "log", data: { line: "x" } });
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
      },
    };
    const hub = new Hub(agent, new HistoryStore(":memory:"), { log: c.log, maxBackoffMs: 1 });
    hub.start();
    await Bun.sleep(30);
    const lost = c.lines.filter((l) => l.msg === "agent stream lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ level: "WARN", cause: "Unable to connect" });
    fail = false;
    await Bun.sleep(10);
    hub.stop();
    expect(c.lines.at(-1)).toMatchObject({ level: "INFO", msg: "agent reachable again" });
  });

  it("logs an unreachable Prometheus", async () => {
    const c = capture();
    const refused = (() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;
    expect(await fetchMetrics("http://p", undefined, 200_000, refused, c.log)).toBeNull();
    expect(c.lines[0]).toMatchObject({ msg: "prometheus unreachable", cause: "connection refused" });
  });
});

describe("password hash startup check", () => {
  const message = async (name: string, hash: string) => {
    try {
      await checkPasswordHash(name, hash);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  it("accepts argon2 and bcrypt hashes, and an unset one", async () => {
    expect(await message("PANEL_PASSWORD_HASH", HASH)).toBe("");
    expect(await message("ADMIN_PASSWORD_HASH", await Bun.password.hash("jarl", { algorithm: "bcrypt" }))).toBe("");
    expect(await message("ADMIN_PASSWORD_HASH", "")).toBe("");
  });

  it("rejects a hash mangled by $ expansion, a truncated one and a placeholder, naming only the variable", async () => {
    const mangled = HASH.replace(/\$[a-z0-9]+/g, "");
    for (const bad of [mangled, HASH.slice(0, 40), "$argon2id$replace-me", "ognisko"]) {
      const m = await message("PANEL_PASSWORD_HASH", bad);
      expect(m).toContain("PANEL_PASSWORD_HASH");
      expect(m).not.toContain(bad);
    }
    expect(await message("ADMIN_PASSWORD_HASH", "$2b$10$short")).toContain("ADMIN_PASSWORD_HASH");
  });
});
