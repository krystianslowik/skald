import { Hono, type Context } from "hono";
import { getConnInfo } from "hono/bun";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AgentSource } from "./agent";
import { createSession, RateLimiter, SESSION_COOKIE, SESSION_TTL_MS, verifySession } from "./auth";
import type { Hub } from "./hub";
import type { MapCache } from "./map";
import {
  ACTION_NAMES,
  BACKUP_NAME,
  type ActionName,
  type ApiState,
  type ApplyMode,
  type Locale,
  type Metrics,
  type PublicConfig,
  type SettingsRequest,
} from "./types";

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
  /** The world map; without it /api/map answers 404. */
  map?: MapCache;
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

  // The world map, gated by MAP_SPOILERS. Revalidated by ETag; gzip when accepted.
  app.get("/api/map", async (c) => {
    if (!deps.map) return c.json({ error: "world map off" }, 404);
    const res = await deps.map.get();
    if (!res.ok) return c.json({ error: res.message }, res.status as 404);
    const headers: Record<string, string> = { ETag: res.etag, "Cache-Control": "private, no-cache", Vary: "Accept-Encoding" };
    if (res.stale) headers["X-Skald-Stale"] = "1";
    if ((c.req.header("If-None-Match") ?? "").split(",").some((t) => t.trim().replace(/^W\//, "") === res.etag)) {
      return new Response(null, { status: 304, headers });
    }
    headers["Content-Type"] = "application/json";
    if (/\bgzip\b/.test(c.req.header("Accept-Encoding") ?? "")) {
      headers["Content-Encoding"] = "gzip";
      return new Response(res.gzip, { status: 200, headers });
    }
    return new Response(res.json, { status: 200, headers });
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

  // Server settings, passed through to the agent with its status codes (400
  // with per-field `errors`, 404 when the feature is off, 409 when busy).
  const settings = async (c: Context, req: SettingsRequest) => {
    if (!deps.hub.online) return c.json({ ok: false, message: "agent unreachable" }, 503);
    c.header("Cache-Control", "no-store");
    try {
      const res = await deps.agent.settings(req);
      return c.json(res.body as object, res.status as 200);
    } catch {
      return c.json({ ok: false, message: "agent unreachable" }, 502);
    }
  };

  app.get("/api/settings", (c) => settings(c, { op: "get" }));
  // Separate on purpose: the password only travels when someone asks to see it.
  app.get("/api/settings/password", (c) => settings(c, { op: "password" }));
  app.put("/api/settings", async (c) => {
    if (Number(c.req.header("Content-Length") ?? 0) > 16_384) return c.json({ ok: false, message: "body too large" }, 413);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, message: "bad request body" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ ok: false, message: "bad request body" }, 400);
    return settings(c, { op: "put", body });
  });
  app.post("/api/settings/apply", async (c) => {
    let mode: unknown;
    try {
      mode = ((await c.req.json()) as { mode?: unknown }).mode;
    } catch {
      mode = undefined;
    }
    if (!APPLY_MODES.includes(mode as ApplyMode)) return c.json({ ok: false, message: 'mode must be "now" or "when_empty"' }, 400);
    return settings(c, { op: "apply", mode: mode as ApplyMode });
  });
  app.delete("/api/settings/apply", (c) => settings(c, { op: "cancel" }));

  return app;
}

const APPLY_MODES: readonly ApplyMode[] = ["now", "when_empty"];
