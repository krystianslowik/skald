import { Hono, type Context } from "hono";
import { getConnInfo } from "hono/bun";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AgentSource } from "./agent";
import { createSession, RateLimiter, SESSION_COOKIE, SESSION_TTL_MS, verifySession } from "./auth";
import type { Hub } from "./hub";
import { ACTION_NAMES, BACKUP_NAME, type ActionName, type ApiState, type Locale, type Metrics, type PublicConfig } from "./types";

export interface AppDeps {
  sessionSecret: string;
  passwordHash: string;
  secureCookie: boolean;
  agent: AgentSource;
  hub: Hub;
  metrics: () => Promise<Metrics | null>;
  /** False when no Prometheus is configured; defaults to true. */
  metricsConfigured?: boolean;
  /** Default UI language handed to the SPA before login. */
  locale?: Locale;
  /** Header holding the real client IP behind a trusted proxy; empty = socket address. */
  trustedIpHeader?: string;
  limiter?: RateLimiter;
  verifyPassword?: (password: string, hash: string) => Promise<boolean>;
  clock?: () => number;
}

/**
 * The rate-limit key. A forwarding header is only honoured when configured:
 * trusted unconditionally, any client could rotate it to dodge the limiter.
 */
function clientIp(c: Context, trustedHeader: string): string {
  if (trustedHeader) {
    // X-Forwarded-For style lists: the left-most entry is the original client.
    const v = c.req.header(trustedHeader)?.split(",")[0]?.trim();
    if (v) return v;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const limiter = deps.limiter ?? new RateLimiter();
  const clock = deps.clock ?? Date.now;
  const verify = deps.verifyPassword ?? ((p: string, h: string) => Bun.password.verify(p, h));
  const authed = (c: Context) => verifySession(deps.sessionSecret, getCookie(c, SESSION_COOKIE), clock());

  app.get("/healthz", (c) => c.text("ok"));

  // Public on purpose: the login screen is translated before anyone signs in.
  // Never put anything here that should stay behind the password.
  app.get("/api/config", (c) => {
    const body: PublicConfig = { locale: deps.locale ?? "en" };
    return c.json(body);
  });

  app.post("/api/login", async (c) => {
    // Limit first: argon2 is deliberately slow and must not be a free oracle.
    const ip = clientIp(c, deps.trustedIpHeader ?? "");
    const wait = limiter.hit(ip);
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ ok: false, error: "locked", retryAfter: wait }, 429);
    }
    let password = "";
    try {
      const body = (await c.req.json()) as { password?: unknown };
      if (typeof body.password === "string") password = body.password;
    } catch {
      // empty or malformed body counts as a wrong password
    }
    let ok = false;
    if (password && deps.passwordHash) {
      try {
        ok = await verify(password, deps.passwordHash);
      } catch {
        ok = false;
      }
    }
    if (!ok) return c.json({ ok: false, error: "invalid" }, 401);
    limiter.reset(ip);
    setCookie(c, SESSION_COOKIE, createSession(deps.sessionSecret, clock()), {
      httpOnly: true,
      secure: deps.secureCookie,
      sameSite: "Strict",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.json({ ok: true });
  });

  app.post("/api/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: deps.secureCookie });
    return c.json({ ok: true });
  });

  app.get("/api/me", (c) => (authed(c) ? c.json({ authenticated: true }) : c.json({ authenticated: false }, 401)));

  app.use("/api/*", async (c, next) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/api/state", async (c) => {
    const body: ApiState = {
      ...deps.hub.getState(),
      online: deps.hub.online,
      history: deps.hub.history(),
      metricsConfigured: deps.metricsConfigured ?? true,
      metrics: await deps.metrics(),
    };
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });

  app.get("/api/logs", async (c) => {
    const limit = Math.min(2000, Math.max(1, Number.parseInt(c.req.query("limit") ?? "500", 10) || 500));
    try {
      return c.json({ lines: await deps.agent.getLogs(limit) });
    } catch {
      return c.json({ lines: [], error: "agent unreachable" }, 502);
    }
  });

  app.get("/api/players", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ players: deps.hub.profiles() });
  });

  app.get("/api/players/:name", (c) => {
    const name = c.req.param("name");
    const profile = deps.hub.profiles().find((p) => p.name === name);
    if (!profile) return c.json({ error: "not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(profile);
  });

  // Streams the agent's zip straight through; nothing is buffered here.
  app.get("/api/backups/:name", async (c) => {
    const name = c.req.param("name");
    if (!BACKUP_NAME.test(name)) return c.json({ error: "bad backup name" }, 400);
    let upstream: Response;
    try {
      upstream = await deps.agent.backup(name, c.req.raw.signal);
    } catch {
      return c.json({ error: "agent unreachable" }, 502);
    }
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      return c.json({ error: upstream.status === 404 ? "not found" : "agent error" }, upstream.status === 404 ? 404 : 502);
    }
    const headers = new Headers({
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/zip",
      "Content-Disposition": upstream.headers.get("Content-Disposition") ?? `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    });
    const len = upstream.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len);
    return new Response(upstream.body, { status: 200, headers });
  });

  app.post("/api/action/:name", async (c) => {
    const name = c.req.param("name") as ActionName;
    if (!ACTION_NAMES.includes(name)) return c.json({ ok: false, message: "unknown action" }, 404);
    if (!deps.hub.online) return c.json({ ok: false, message: "agent unreachable" }, 503);
    try {
      const res = await deps.agent.action(name);
      return c.json(res.body, res.status as 200);
    } catch {
      return c.json({ ok: false, message: "agent unreachable" }, 502);
    }
  });

  return app;
}
