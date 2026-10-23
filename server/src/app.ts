import { Hono, type Context } from "hono";
import { getConnInfo } from "hono/bun";
import { compress, COMPRESSIBLE_CONTENT_TYPE_REGEX } from "hono/compress";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { matchedRoutes, routePath } from "hono/route";
import type { AgentAsset, AgentSource, PiecesBox, ToolsRequest } from "./agent";
import { CATCHUP_SETTLE_MS, catchupSince, summarize } from "./catchup";
import { ADMIN_COOKIE, ADMIN_IDLE_MS, createAdminSession, createSession, RateLimiter, SESSION_COOKIE, SESSION_TTL_MS, sessionHash, verifyAdminSession, verifySession } from "./auth";
import type { Hub } from "./hub";
import { cause, log as defaultLog, type Logger } from "./log";
import type { MapCache, MapView } from "./map";
import type { NotifyChange, NotifySettings } from "./notify";
import { checkOrigin, type OriginPolicy } from "./origin";
import { pushRoutes, pushSessionTag, type PushService } from "./push";
import { mountTasks, type TaskRoutesDeps } from "./taskroutes";
import { mountPins, type PinRoutesDeps } from "./pins";
import {
  ACCESS_LISTS,
  ACCESS_OPS,
  ACTION_NAMES,
  ADMIN_COMMANDS,
  ADMIN_READS,
  BACKUP_NAME,
  NOTIFY_KINDS,
  SAFE_RESTART_MAX_DEADLINE,
  SAFE_RESTART_MAX_WARN,
  SKALD_BACKUP_NAME,
  type AccessListName,
  type AccessOp,
  type ActionName,
  type ApiCatchup,
  type AdminCatalog,
  type AdminCommand,
  type AdminRead,
  type AdminStatus,
  type BridgeStatus,
  type FillStations,
  type ApiState,
  type ApplyMode,
  type Locale,
  type Metrics,
  type NotifyKind,
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
  /** PUBLIC_ORIGIN: the origins browsers open the panel on; empty or unset: the request's own host. */
  publicOrigins?: readonly string[];
  limiter?: RateLimiter;
  /** argon2id hash of the admin password; empty or unset: everyone signed in is an admin. */
  adminPasswordHash?: string;
  /** Limits admin unlocks like logins (separate buckets). */
  adminLimiter?: RateLimiter;
  /** The world map; without it /api/map answers 404. */
  map?: MapCache;
  /** Discord notifications: the environment's or the panel's webhook. Unset: the feature is off. */
  notify?: Pick<NotifySettings, "on" | "fromEnv" | "view" | "update" | "clear" | "test">;
  /** Phone push notifications; unset: /api/push answers 404. */
  push?: Pick<PushService, "info" | "subscribe" | "device" | "unsubscribe" | "test" | "forgetSession">;
  /** Limits push subscribing and tests per client address; 20 a minute by default. */
  pushLimiter?: RateLimiter;
  verifyPassword?: (password: string, hash: string) => Promise<boolean>;
  clock?: () => number;
  /** This build's Skald release; "dev" when unset. */
  version?: string;
  /** A newer Skald release, from the update check; unset when it is off. */
  update?: () => { version: string; url: string } | null;
  /** Failure lines; the process-wide JSON logger by default. */
  log?: Logger;
  /** The shared task board; without it /api/tasks answers 404. */
  tasks?: TaskRoutesDeps;
  /** The shared web map pins; without them /api/pins answers 404. */
  pins?: PinRoutesDeps;
  /** Mock mode only (MOCK_WRITE_DELAY_MS): task, pin and push changes wait this long before they run. */
  writeDelayMs?: number;
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

/** The agent's limit on each side of a floor-plan box, in metres. */
export const PIECES_MAX_SIDE = 1024;
const WORLD_EDGE = 10_500;

/**
 * The box of a floor-plan request from x0, z0, x1, z1, clamped to the world
 * disc's square, or why it is refused.
 */
export function parsePiecesBox(query: (k: string) => string | undefined): PiecesBox | string {
  const v: number[] = [];
  for (const k of ["x0", "z0", "x1", "z1"]) {
    const raw = query(k)?.trim();
    const n = raw ? Number(raw) : Number.NaN;
    if (!Number.isFinite(n)) return "x0, z0, x1 and z1 must be numbers";
    v.push(Math.min(WORLD_EDGE, Math.max(-WORLD_EDGE, n)));
  }
  const [x0, z0, x1, z1] = v as [number, number, number, number];
  if (x1 < x0 || z1 < z0) return "the box needs x0 <= x1 and z0 <= z1";
  if (x1 - x0 > PIECES_MAX_SIDE || z1 - z0 > PIECES_MAX_SIDE) return `the box is limited to ${PIECES_MAX_SIDE} m a side`;
  return [x0, z0, x1, z1];
}

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** How the origin check finds the panel's own origin; shared with the /live upgrade. */
export function panelOriginPolicy(o: { publicOrigins?: readonly string[]; trustedIpHeader?: string }): OriginPolicy {
  return { publicOrigins: o.publicOrigins ?? [], trustForwardedHost: Boolean(o.trustedIpHeader) };
}

/** The admin routes a signed-in non-admin may call. */
const ADMIN_OPEN = new Set(["GET /api/admin/status", "POST /api/admin/unlock", "POST /api/admin/lock"]);
/**
 * Admin-only reads that a panel polls on its own (the players' links, every
 * 5 s while an admin view is open): checked like every admin call, but they
 * do not restart the idle timeout, or a tab left open would never lock.
 */
const ADMIN_NO_TOUCH = new Set(["GET /api/admin/players"]);

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const limiter = deps.limiter ?? new RateLimiter();
  const clock = deps.clock ?? Date.now;
  const verify = deps.verifyPassword ?? ((p: string, h: string) => Bun.password.verify(p, h));
  const authed = (c: Context) => verifySession(deps.sessionSecret, getCookie(c, SESSION_COOKIE), clock());

  // ---- failure log ------------------------------------------------------------
  // One line per failure, rate-limited per route by the logger. The route is
  // the registered pattern (`/api/backups/:name`), never the URL, so names and
  // ids in a path stay out of the log; bodies, cookies and tokens never go in.
  const logger = deps.log ?? defaultLog;
  const where = (c: Context) => ({ method: c.req.method, route: routePath(c) });
  /**
   * In a middleware: the route the request is headed for, i.e. the first
   * matching handler's pattern (middleware registers as ALL), so a refusal
   * names `/api/login` or `/api/admin/:command` rather than `/api/*`.
   */
  const headedFor = (c: Context) => ({ method: c.req.method, route: matchedRoutes(c).find((r) => r.method !== "ALL")?.path ?? routePath(c) });
  /**
   * An agent call threw; `status` is what the client gets. A request the
   * browser cancelled (a map pan drops tiles) aborts the agent call too: that
   * is not a failure.
   */
  const unreachable = (c: Context, e: unknown, status = 502) => {
    if (!c.req.raw.signal.aborted) logger.warn("agent unreachable", { ...where(c), status, cause: cause(e) });
  };
  /**
   * The agent answered with an error; `status` is what the client gets. Logged
   * when either side is a 5xx, so a 401 from a wrong AGENT_TOKEN that turns
   * into a 502 shows up too.
   */
  const agentFailed = (c: Context, upstream: number, status = upstream) => {
    if (upstream >= 500 || status >= 500) logger.warn("agent error", { ...where(c), status, upstream });
  };
  /** A wrong password or a lockout, with the client address the limiter keys on. */
  const loginFailed = (c: Context, ip: string, status: number, retryAfter?: number) =>
    logger.warn(status === 429 ? "login locked" : "login failed", { ...where(c), status, ip, retryAfter });

  // Gzip JSON and the built app (scripts, styles, HTML) for clients that take it.
  // Answers with an ETag are left as they are: compress() would weaken the tag,
  // and the map routes already send their own gzip.
  app.use("*", (c, next) =>
    compress({ contentTypeFilter: (type) => !c.res.headers.has("ETag") && COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type) })(c, next),
  );

  // ---- origin check ---------------------------------------------------------
  // Every request that changes something, login and logout included, must come
  // from the panel's own page (or from no browser at all). See origin.ts.
  const originPolicy = panelOriginPolicy(deps);
  let mismatchLogged = false;
  app.use("/api/*", async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const v = checkOrigin(c.req.raw, originPolicy);
    if (!v.ok) {
      logger.warn("cross-origin request refused", { ...headedFor(c), status: 403, origin: v.origin.slice(0, 200), expected: v.expected, hint: "set PUBLIC_ORIGIN to the address the panel is opened on" });
      return c.json({ ok: false, error: "cross_origin", message: "request from another origin refused; set PUBLIC_ORIGIN if the panel sits behind a proxy that rewrites Host" }, 403);
    }
    if (v.mismatch && !mismatchLogged) {
      mismatchLogged = true;
      logger.warn("origin differs from the request host", { ...headedFor(c), origin: v.mismatch.origin.slice(0, 200), expected: v.mismatch.expected, hint: "set PUBLIC_ORIGIN, or browsers without Sec-Fetch-Site are refused" });
    }
    return next();
  });

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
      loginFailed(c, ip, 429, wait);
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
      } catch (e) {
        // A broken PANEL_PASSWORD_HASH, not a wrong password; startup checks it too.
        logger.error("password check failed", { ...where(c), cause: cause(e) });
        ok = false;
      }
    }
    if (!ok) {
      loginFailed(c, ip, 401);
      return c.json({ ok: false, error: "invalid" }, 401);
    }
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
    // A signed-out session's phones get no more news.
    if (authed(c)) deps.push?.forgetSession(pushSessionTag(getCookie(c, SESSION_COOKIE)));
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: deps.secureCookie });
    deleteCookie(c, ADMIN_COOKIE, { path: "/", secure: deps.secureCookie });
    return c.json({ ok: true });
  });

  app.get("/api/me", (c) => (authed(c) ? c.json({ authenticated: true }) : c.json({ authenticated: false }, 401)));

  app.use("/api/*", async (c, next) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  // A slow link for trying the panel's instant changes on the mock: the change
  // waits before it runs, so neither its answer nor its /live frame comes early.
  const writeDelay = deps.writeDelayMs ?? 0;
  if (writeDelay > 0) {
    app.use("/api/*", async (c, next) => {
      if (!SAFE_METHODS.has(c.req.method) && /^\/api\/(tasks|pins|push)(\/|$)/.test(c.req.path)) await Bun.sleep(writeDelay);
      await next();
    });
  }

  // Phone push: each signed-in viewer turns it on for their own device.
  if (deps.push) {
    app.route(
      "/api/push",
      pushRoutes(deps.push, {
        limiter: deps.pushLimiter ?? new RateLimiter(20, 60_000, 60_000, clock),
        clientKey: (c) => clientIp(c, deps.trustedIpHeader ?? ""),
        session: (c) => pushSessionTag(getCookie(c, SESSION_COOKIE)),
      }),
    );
  }

  // ---- roles ---------------------------------------------------------------
  // With ADMIN_PASSWORD_HASH, changing anything (actions, settings, admin
  // commands) needs an admin session on top of the panel session; without
  // it, everyone signed in may, as before 0.8.0.
  const adminRequired = Boolean(deps.adminPasswordHash);
  const adminLimiter = deps.adminLimiter ?? new RateLimiter();
  const isAdmin = (c: Context) =>
    !adminRequired || verifyAdminSession(deps.sessionSecret, getCookie(c, ADMIN_COOKIE), getCookie(c, SESSION_COOKIE), clock());
  /** Issues a fresh admin token: each admin call restarts the idle timeout. */
  const touchAdmin = (c: Context) => {
    if (!adminRequired) return;
    setCookie(c, ADMIN_COOKIE, createAdminSession(deps.sessionSecret, getCookie(c, SESSION_COOKIE) ?? "", clock()), {
      httpOnly: true,
      secure: deps.secureCookie,
      sameSite: "Strict",
      path: "/",
      maxAge: Math.floor(ADMIN_IDLE_MS / 1000),
    });
  };
  /**
   * null when the caller may change things; otherwise the 403 to return.
   * `touch: false` checks without restarting the idle timeout (ADMIN_NO_TOUCH).
   */
  const needAdmin = (c: Context, { touch = true }: { touch?: boolean } = {}) => {
    if (isAdmin(c)) {
      if (touch) touchAdmin(c);
      return null;
    }
    return c.json({ ok: false, error: "admin_required", message: "admin session required" }, 403);
  };

  app.get("/api/state", async (c) => {
    const body: ApiState = {
      ...deps.hub.getState(),
      online: deps.hub.online,
      history: deps.hub.history(),
      metricsConfigured: deps.metricsConfigured ?? true,
      metrics: await deps.metrics(),
      webVersion: deps.version ?? "dev",
    };
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });

  app.get("/api/logs", async (c) => {
    const limit = Math.min(2000, Math.max(1, Number.parseInt(c.req.query("limit") ?? "500", 10) || 500));
    try {
      return c.json({ lines: await deps.agent.getLogs(limit) });
    } catch (e) {
      unreachable(c, e);
      return c.json({ lines: [], error: "agent unreachable" }, 502);
    }
  });

  // The world map, gated by MAP_SPOILERS, and the village stores cut from it.
  // Revalidated by ETag; gzip when accepted.
  const serveMap = async (c: Context, view: MapView) => {
    if (!deps.map) return c.json({ error: "world map off" }, 404);
    const res = await deps.map.get(view);
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
  };
  app.get("/api/map", (c) => serveMap(c, "map"));
  app.get("/api/storage", (c) => serveMap(c, "storage"));

  // Floor plans of what players built, and the nature the world generated,
  // inside a box, for close zoom. The box is checked here so a bad one never
  // reaches the agent; the answer passes through with the agent's ETag,
  // re-compressed for this client.
  const proxyBox = async (c: Context, ask: (box: PiecesBox, etag: string | null, signal: AbortSignal) => Promise<Response>) => {
    if (!deps.map) return c.json({ error: "world map off" }, 404);
    const box = parsePiecesBox((k) => c.req.query(k));
    if (typeof box === "string") return c.json({ error: box }, 400);
    let up: Response;
    try {
      up = await ask(box, c.req.header("If-None-Match") ?? null, c.req.raw.signal);
    } catch (e) {
      unreachable(c, e);
      return c.json({ error: "agent unreachable" }, 502);
    }
    const headers: Record<string, string> = { "Cache-Control": "private, no-cache", Vary: "Accept-Encoding" };
    const etag = up.headers.get("ETag");
    if (etag) headers.ETag = etag;
    if (up.status === 304) {
      await up.body?.cancel();
      return new Response(null, { status: 304, headers });
    }
    if (up.status !== 200) {
      await up.body?.cancel();
      if (up.status === 503) return c.json({ error: "world map not ready" }, 503, { "Retry-After": up.headers.get("Retry-After") ?? "30" });
      if (up.status === 404) return c.json({ error: "not available" }, 404);
      agentFailed(c, up.status, 502);
      return c.json({ error: "agent error" }, 502);
    }
    let json: string;
    try {
      // Read whole: fetch has already undone the agent's gzip.
      json = await up.text();
    } catch (e) {
      unreachable(c, e);
      return c.json({ error: "agent unreachable" }, 502);
    }
    headers["Content-Type"] = "application/json";
    if (/\bgzip\b/.test(c.req.header("Accept-Encoding") ?? "")) {
      headers["Content-Encoding"] = "gzip";
      return new Response(Bun.gzipSync(json), { status: 200, headers });
    }
    return new Response(json, { status: 200, headers });
  };
  app.get("/api/pieces", (c) => proxyBox(c, (box, etag, signal) => deps.agent.pieces(box, etag, signal)));
  // Nature beyond explored land is a spoiler: only MAP_SPOILERS asks for it,
  // never the client's query.
  app.get("/api/nature", (c) => proxyBox(c, (box, etag, signal) => deps.agent.nature(box, deps.map?.spoilers ?? false, etag, signal)));

  // Files the agent serves as they are, passed through with their ETag. The
  // URL of a sheet carries its build (?v=), so it can be cached for good.
  const proxyAsset = async (c: Context, path: AgentAsset, cache: string) => {
    let up: Response;
    try {
      up = await deps.agent.asset(path, c.req.header("If-None-Match") ?? null, c.req.raw.signal);
    } catch (e) {
      unreachable(c, e);
      return c.json({ error: "agent unreachable" }, 502);
    }
    const headers = new Headers({ "Cache-Control": cache });
    const etag = up.headers.get("ETag");
    if (etag) headers.set("ETag", etag);
    if (up.status === 304) {
      await up.body?.cancel();
      return new Response(null, { status: 304, headers });
    }
    if (up.status !== 200 || !up.body) {
      await up.body?.cancel();
      const status = up.status === 404 ? 404 : up.status === 503 ? 503 : 502;
      if (status === 502) agentFailed(c, up.status, status);
      return c.json({ error: status === 404 ? "not available" : "agent error" }, status);
    }
    headers.set("Content-Type", up.headers.get("Content-Type") ?? "application/octet-stream");
    const len = up.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len);
    return new Response(up.body, { status: 200, headers });
  };
  app.get("/api/icons/map.json", (c) => proxyAsset(c, "icons/map.json", "private, no-cache"));
  app.get("/api/icons/sheet.webp", (c) => proxyAsset(c, "icons/sheet.webp", "private, max-age=31536000, immutable"));
  // The world generator's terrain: the whole seed's land, so like the seed
  // itself it is only for signed-in viewers. The web draws it under the fog.
  app.get("/api/terrain.json", (c) => proxyAsset(c, "terrain.json", "private, no-cache"));
  app.get("/api/terrain.png", (c) => proxyAsset(c, "terrain.png", "private, max-age=31536000, immutable"));
  // The terrain as tiles sampled from the running server. A tile URL carries
  // its build (v), so it is cached for good; the body is a gzipped binary
  // tile the web decodes itself, passed through untouched.
  app.get("/api/terrain/tiles.json", (c) => proxyAsset(c, "terrain/tiles.json", "private, no-cache"));
  app.get("/api/terrain/tile", async (c) => {
    const int = (k: string) => {
      const v = c.req.query(k) ?? "";
      return /^\d{1,4}$/.test(v) ? Number(v) : -1;
    };
    const z = int("z");
    const x = int("x");
    const y = int("y");
    const v = c.req.query("v") ?? "";
    if (z < 0 || x < 0 || y < 0 || !/^[\w.-]{1,64}$/.test(v)) return c.json({ error: "bad tile" }, 400);
    let up: Response;
    try {
      if (!deps.agent.terrainTile) return c.json({ error: "not available" }, 404);
      up = await deps.agent.terrainTile({ z, x, y, v }, c.req.header("If-None-Match") ?? null, c.req.raw.signal);
    } catch (e) {
      unreachable(c, e);
      return c.json({ error: "agent unreachable" }, 502);
    }
    const headers = new Headers({ "Cache-Control": "private, max-age=31536000, immutable" });
    const etag = up.headers.get("ETag");
    if (etag) headers.set("ETag", etag);
    if (up.status === 304) {
      await up.body?.cancel();
      return new Response(null, { status: 304, headers });
    }
    if (up.status !== 200 || !up.body) {
      await up.body?.cancel();
      const status = up.status === 404 ? 404 : up.status === 429 || up.status === 503 ? 503 : 502;
      if (status === 502) agentFailed(c, up.status, status);
      // A missing or busy tile may be there later: never cache the refusal.
      return c.json({ error: status === 404 ? "not available" : "terrain busy" }, status, { "Cache-Control": "no-store" });
    }
    headers.set("Content-Type", "application/octet-stream");
    const len = up.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len);
    return new Response(up.body, { status: 200, headers });
  });

  if (deps.tasks) mountTasks(app, { clientKey: (c) => clientIp(c, deps.trustedIpHeader ?? ""), ...deps.tasks });
  if (deps.pins) mountPins(app, { clientKey: (c) => clientIp(c, deps.trustedIpHeader ?? ""), ...deps.pins });

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

  // What happened since the viewer's last visit (kept in their browser, sent
  // as `since`): the events of the window, and the world as it is now for the
  // browser to compare with what it saw.
  app.get("/api/catchup", async (c) => {
    const now = clock();
    const { since, clamped } = catchupSince(c.req.query("since"), now);
    const events = deps.hub.storedEvents();
    // A stream open for a while is past the backlog it replays first.
    const opened = deps.hub.liveSince();
    const live = opened !== null && now - opened >= CATCHUP_SETTLE_MS;
    const summary = summarize(events, since, now, live);
    const bosses = deps.hub.getState().world.meta?.bosses;
    const body: ApiCatchup = {
      ...summary,
      clamped,
      bosses: bosses ? bosses.filter((b) => b.defeated).map((b) => b.key) : null,
      world: deps.map ? await deps.map.facts() : null,
    };
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });

  // Streams the agent's zip straight through; nothing is buffered here.
  app.get("/api/backups/:name", async (c) => {
    const name = c.req.param("name");
    if (!BACKUP_NAME.test(name)) return c.json({ error: "bad backup name" }, 400);
    let upstream: Response;
    try {
      upstream = await deps.agent.backup(name, c.req.raw.signal);
    } catch (e) {
      unreachable(c, e);
      return c.json({ error: "agent unreachable" }, 502);
    }
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      if (upstream.status !== 404) agentFailed(c, upstream.status, 502);
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
    const denied = needAdmin(c);
    if (denied) return denied;
    if (!deps.hub.online) return c.json({ ok: false, message: "agent unreachable" }, 503);
    try {
      const res = await deps.agent.action(name);
      agentFailed(c, res.status);
      return c.json(res.body, res.status as 200);
    } catch (e) {
      unreachable(c, e);
      return c.json({ ok: false, message: "agent unreachable" }, 502);
    }
  });

  // A test message to the Discord webhook. Changes nothing, but it posts to a
  // channel in the server's name, so it is an admin action like the others.
  app.post("/api/notify/test", async (c) => {
    const denied = needAdmin(c);
    if (denied) return denied;
    if (!deps.notify) return c.json({ ok: false, error: "not_configured" }, 404);
    const res = await deps.notify.test();
    if (!res.ok && res.error === "not_configured") return c.json(res, 404);
    // One test at a time, then a short pause: each one posts to the channel.
    // After Discord's own 429 the pause lasts as long as Discord asked.
    if (!res.ok && (res.error === "busy" || res.error === "rate_limited")) {
      const retryAfter = res.retryAfter ?? 10;
      return c.json({ ok: false, error: res.error, retryAfter }, 429, { "Retry-After": String(retryAfter) });
    }
    // The notifier already strips the webhook URL out of its errors.
    if (!res.ok) logger.warn("discord test failed", { ...where(c), status: 502, cause: res.error });
    return res.ok ? c.json({ ok: true }) : c.json({ ok: false, error: res.error }, 502);
  });

  // Server settings, passed through to the agent with its status codes (400
  // with per-field `errors`, 404 when the feature is off, 409 when busy).
  const settings = async (c: Context, req: SettingsRequest) => {
    if (!deps.hub.online) return c.json({ ok: false, message: "agent unreachable" }, 503);
    c.header("Cache-Control", "no-store");
    try {
      const res = await deps.agent.settings(req);
      agentFailed(c, res.status);
      return c.json(res.body as object, res.status as 200);
    } catch (e) {
      unreachable(c, e);
      return c.json({ ok: false, message: "agent unreachable" }, 502);
    }
  };

  app.get("/api/settings", (c) => settings(c, { op: "get" }));
  // Separate on purpose: the password only travels when someone asks to see
  // it, and with an admin password only to an unlocked admin.
  app.get("/api/settings/password", async (c) => {
    const denied = needAdmin(c);
    if (denied) return denied;
    return settings(c, { op: "password" });
  });
  app.put("/api/settings", async (c) => {
    const denied = needAdmin(c);
    if (denied) return denied;
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
    const denied = needAdmin(c);
    if (denied) return denied;
    let mode: unknown;
    try {
      mode = ((await c.req.json()) as { mode?: unknown }).mode;
    } catch {
      mode = undefined;
    }
    if (!APPLY_MODES.includes(mode as ApplyMode)) return c.json({ ok: false, message: 'mode must be "now" or "when_empty"' }, 400);
    return settings(c, { op: "apply", mode: mode as ApplyMode });
  });
  app.delete("/api/settings/apply", async (c) => needAdmin(c) ?? settings(c, { op: "cancel" }));

  // ---- admin: the bridge plugin, through the agent ---------------------------

  let statusCache: { at: number; value: BridgeStatus } | null = null;
  const bridgeStatus = async (c: Context): Promise<BridgeStatus> => {
    const now = clock();
    if (statusCache && now - statusCache.at < 3_000) return statusCache.value;
    let value: BridgeStatus;
    try {
      const res = await deps.agent.bridge({ op: "status" });
      if (res.status === 404) value = offStatus("off");
      else if (res.status !== 200) {
        // Answered 200 with the bridge shown as off; logged like a 502.
        agentFailed(c, res.status, 502);
        value = offStatus("agent");
      } else value = res.body as BridgeStatus;
    } catch (e) {
      unreachable(c, e, 200);
      value = offStatus("agent");
    }
    statusCache = { at: now, value };
    return value;
  };

  /** Who clicked, for the plugin's audit line: the name this device gave, or a session hash. */
  const actorFor = (c: Context) => {
    // URI-encoded by the browser: header values are bytes, names are not.
    let raw = c.req.header("X-Skald-Name") ?? "";
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // not encoded; use it as it is
    }
    const name = foldActor(raw);
    return name || `dashboard-${sessionHash(getCookie(c, SESSION_COOKIE) ?? "")}`;
  };

  /** A bridge answer passed on: the plugin's own status, 502 when unreachable. */
  const passBridge = async (c: Context, req: Parameters<AgentSource["bridge"]>[0]) => {
    c.header("Cache-Control", "no-store");
    try {
      const res = await deps.agent.bridge(req);
      if (req.op === "run") statusCache = null;
      agentFailed(c, res.status);
      return c.json(res.body as object, res.status as 200);
    } catch (e) {
      unreachable(c, e);
      return c.json({ ok: false, error: "agent unreachable" }, 502);
    }
  };

  // Everything under /api/admin is for admins only, reads included, except
  // what a locked panel needs to show the lock and unlock it. Listed here, so
  // the order the routes are registered in does not decide who may call them.
  app.use("/api/admin/*", async (c, next) => {
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    const route = `${method} ${c.req.path}`;
    if (ADMIN_OPEN.has(route)) return next();
    const denied = needAdmin(c, { touch: !ADMIN_NO_TOUCH.has(route) });
    if (denied) return denied;
    await next();
  });

  app.get("/api/admin/status", async (c) => {
    c.header("Cache-Control", "no-store");
    const body: AdminStatus = { bridge: await bridgeStatus(c), required: adminRequired, unlocked: isAdmin(c), idleMs: ADMIN_IDLE_MS, notifyConfigured: deps.notify?.on ?? false };
    body.update = deps.update?.() ?? null;
    return c.json(body);
  });

  app.post("/api/admin/unlock", async (c) => {
    if (!adminRequired) return c.json({ ok: true });
    const ip = clientIp(c, deps.trustedIpHeader ?? "");
    const key = `${ip}:admin`;
    const wait = adminLimiter.hit(key);
    if (wait > 0) {
      loginFailed(c, ip, 429, wait);
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
    if (password) {
      try {
        ok = await verify(password, deps.adminPasswordHash!);
      } catch (e) {
        // A broken ADMIN_PASSWORD_HASH, not a wrong password; startup checks it too.
        logger.error("password check failed", { ...where(c), cause: cause(e) });
        ok = false;
      }
    }
    if (!ok) {
      loginFailed(c, ip, 401);
      return c.json({ ok: false, error: "invalid" }, 401);
    }
    adminLimiter.reset(key);
    touchAdmin(c);
    return c.json({ ok: true });
  });

  app.post("/api/admin/lock", (c) => {
    deleteCookie(c, ADMIN_COOKIE, { path: "/", secure: deps.secureCookie });
    return c.json({ ok: true });
  });

  app.get("/api/admin/players", (c) => passBridge(c, { op: "players" }));

  app.get("/api/admin/read/:name", async (c) => {
    const name = c.req.param("name") as AdminRead;
    if (!ADMIN_READS.includes(name)) return c.json({ ok: false, error: "unknown read" }, 404);
    return passBridge(c, { op: "read", name });
  });

  // Event names, global keys and teleport spots, for the pickers.
  let catalogCache: { at: number; value: AdminCatalog } | null = null;
  app.get("/api/admin/catalog", async (c) => {
    c.header("Cache-Control", "no-store");
    const now = clock();
    if (catalogCache && now - catalogCache.at < 60_000 && c.req.query("fresh") === undefined) return c.json(catalogCache.value);
    try {
      const [ev, keys, locs, st] = await Promise.all([
        deps.agent.bridge({ op: "read", name: "events" }),
        deps.agent.bridge({ op: "read", name: "globalkeys" }),
        deps.agent.bridge({ op: "read", name: "locations" }),
        // Bridge 0.3.0+; an older one answers 404 and the pickers go on without it.
        deps.agent.bridge({ op: "read", name: "stations" }),
      ]);
      if (ev.status !== 200) {
        agentFailed(c, ev.status);
        return c.json(ev.body as object, ev.status as 200);
      }
      const evd = (ev.body as { data?: { current?: { name: string; elapsed: number; duration: number } | null; available?: string[] } }).data;
      const keyd = (keys.body as { data?: string[] }).data;
      const locd = (locs.body as { data?: { aliases?: string[] } }).data;
      const value: AdminCatalog = {
        events: evd?.available ?? [],
        currentEvent: evd?.current ? { name: evd.current.name, elapsed: evd.current.elapsed, duration: evd.current.duration } : null,
        globalKeys: keys.status === 200 && Array.isArray(keyd) ? keyd : [],
        spots: locs.status === 200 && Array.isArray(locd?.aliases) ? locd.aliases : [],
        stations: st.status === 200 ? fillStations((st.body as { data?: unknown }).data) : { kilns: [], smelters: [], fermenters: [] },
      };
      // A world still loading answers the stations read with 503: not kept, so the next open asks again.
      if (st.status === 200 || st.status === 404) catalogCache = { at: now, value };
      return c.json(value);
    } catch (e) {
      unreachable(c, e);
      return c.json({ ok: false, error: "agent unreachable" }, 502);
    }
  });

  // ---- admin: the game's admin and ban lists, and world restore --------------
  // Agent file tools that work with or without the bridge. Behind the admin
  // middleware above, reads included: the lists carry raw platform ids.
  // Registered before /api/admin/:command, which would swallow them.

  const passTools = async (c: Context, req: ToolsRequest) => {
    c.header("Cache-Control", "no-store");
    if (!deps.hub.online) return c.json({ ok: false, error: "agent unreachable" }, 503);
    try {
      const res = await deps.agent.tools(req);
      agentFailed(c, res.status);
      return c.json(res.body as object, res.status as 200);
    } catch (e) {
      unreachable(c, e);
      return c.json({ ok: false, error: "agent unreachable" }, 502);
    }
  };

  /** A small JSON object body, or the 4xx to answer. */
  const objectBody = async (c: Context): Promise<Record<string, unknown> | Response> => {
    if (Number(c.req.header("Content-Length") ?? 0) > 4096) return c.json({ ok: false, error: "body too large" }, 413);
    let raw = "";
    try {
      raw = await c.req.text();
    } catch {
      raw = "";
    }
    if (raw.length > 4096) return c.json({ ok: false, error: "body too large" }, 413);
    try {
      const body: unknown = JSON.parse(raw || "{}");
      if (typeof body === "object" && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
    } catch {
      // fall through
    }
    return c.json({ ok: false, error: "bad request body" }, 400);
  };

  app.get("/api/admin/access", (c) => passTools(c, { op: "access" }));

  app.post("/api/admin/access/:list/:op", async (c) => {
    const list = c.req.param("list") as AccessListName;
    const change = c.req.param("op") as AccessOp;
    if (!ACCESS_LISTS.includes(list) || !ACCESS_OPS.includes(change)) return c.json({ ok: false, error: "unknown list or operation" }, 404);
    const body = await objectBody(c);
    if (body instanceof Response) return body;
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const player = typeof body.player === "string" ? body.player.trim() : "";
    if (!id === !player || id.length > 64 || player.length > 64) return c.json({ ok: false, error: "send an id or a player" }, 400);
    return passTools(c, { op: "access-change", list, change, body: id ? { id } : { player }, actor: actorFor(c) });
  });

  app.get("/api/admin/restore", (c) => passTools(c, { op: "restore-info" }));

  // ---- admin: the compatibility check -----------------------------------------
  // Everyone signed in sees the result (/api/state `compat`); running it again
  // is an admin's, audited by the agent. 202: the result comes as a live event.
  app.post("/api/admin/compat/run", (c) => passTools(c, { op: "compat-run", actor: actorFor(c) }));

  // ---- admin: Discord notifications ------------------------------------------
  // Behind the admin middleware. The webhook URL is a secret: it comes in on a
  // PUT and only ever goes out masked; it is never logged and never becomes an
  // event, so it stays out of the saga. With DISCORD_WEBHOOK_URL set, the
  // environment wins and these answer 409.

  const notifyAnswer = (c: Context, res: ReturnType<NonNullable<AppDeps["notify"]>["update"]>) => {
    if (res.ok) return c.json({ ok: true, ...res.config });
    if (res.error === "env") return c.json({ ok: false, error: "env", message: "set by the server environment" }, 409);
    // Never echoes the value: a mistyped webhook is still a token.
    return c.json({ ok: false, error: "bad_url", message: "not a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>)" }, 400);
  };

  app.get("/api/admin/notify", (c) => {
    c.header("Cache-Control", "no-store");
    if (!deps.notify) return c.json({ ok: false, error: "not_available" }, 404);
    return c.json({ ok: true, ...deps.notify.view() });
  });

  app.put("/api/admin/notify", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!deps.notify) return c.json({ ok: false, error: "not_available" }, 404);
    // JSON only: a cross-site form cannot send it without a CORS preflight.
    if (!/^application\/json\b/i.test(c.req.header("Content-Type") ?? "")) return c.json({ ok: false, error: "bad request body" }, 415);
    const body = await objectBody(c);
    if (body instanceof Response) return body;
    const change: NotifyChange = {};
    if (body.url !== undefined) {
      if (typeof body.url !== "string") return c.json({ ok: false, error: "bad request body" }, 400);
      change.url = body.url;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return c.json({ ok: false, error: "bad request body" }, 400);
      change.enabled = body.enabled;
    }
    if (body.kinds !== undefined) {
      if (!Array.isArray(body.kinds) || !body.kinds.every((k) => NOTIFY_KINDS.includes(k as NotifyKind))) return c.json({ ok: false, error: "unknown kind" }, 400);
      change.kinds = body.kinds as NotifyKind[];
    }
    const res = deps.notify.update(change);
    if (res.ok) logger.info("discord settings changed", { ...where(c), webhook: change.url !== undefined, enabled: res.config.enabled, kinds: res.config.kinds.join(",") });
    return notifyAnswer(c, res);
  });

  app.delete("/api/admin/notify", (c) => {
    c.header("Cache-Control", "no-store");
    if (!deps.notify) return c.json({ ok: false, error: "not_available" }, 404);
    const res = deps.notify.clear();
    if (res.ok) logger.info("discord webhook removed", where(c));
    return notifyAnswer(c, res);
  });

  app.post("/api/admin/restore", async (c) => {
    const body = await objectBody(c);
    if (body instanceof Response) return body;
    const { source, backup, confirm } = body;
    if (source !== "image" && source !== "skald") return c.json({ ok: false, error: "unknown backup source" }, 400);
    if (typeof backup !== "string" || !(source === "image" ? BACKUP_NAME : SKALD_BACKUP_NAME).test(backup)) return c.json({ ok: false, error: "bad backup name" }, 400);
    // Typed by hand: the world name, exactly. The agent checks it again.
    const world = deps.hub.getState().server.world;
    if (typeof confirm !== "string" || !world || confirm !== world) return c.json({ ok: false, error: "type the world name to confirm" }, 400);
    return passTools(c, { op: "restore", body: { source, backup, confirm }, actor: actorFor(c) });
  });

  // ---- admin: safe restart ----------------------------------------------------
  // The run lives in the agent (it survives a restart of this server); these
  // pass it on. The in-game warnings speak the server's language.
  const minutes = (v: unknown, max: number) => (v === undefined ? 0 : Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : null);
  app.post("/api/admin/safe-restart", async (c) => {
    const body = await objectBody(c);
    if (body instanceof Response) return body;
    const whenEmpty = body.whenEmpty === undefined ? false : body.whenEmpty;
    const deadlineMinutes = minutes(body.deadlineMinutes, SAFE_RESTART_MAX_DEADLINE);
    const warnMinutes = minutes(body.warnMinutes, SAFE_RESTART_MAX_WARN);
    if (typeof whenEmpty !== "boolean" || deadlineMinutes === null || warnMinutes === null) return c.json({ ok: false, error: "bad request body" }, 400);
    return passTools(c, { op: "safe-restart", body: { whenEmpty, deadlineMinutes: whenEmpty ? deadlineMinutes : 0, warnMinutes, locale: deps.locale ?? "en" }, actor: actorFor(c) });
  });
  app.delete("/api/admin/safe-restart", (c) => passTools(c, { op: "safe-restart-cancel", actor: actorFor(c) }));

  app.post("/api/admin/:command", async (c) => {
    const command = c.req.param("command") as AdminCommand;
    if (!ADMIN_COMMANDS.includes(command)) return c.json({ ok: false, error: "unknown command" }, 404);
    if (!deps.hub.online) return c.json({ ok: false, error: "agent unreachable" }, 503);
    if (Number(c.req.header("Content-Length") ?? 0) > 4096) return c.json({ ok: false, error: "body too large" }, 413);
    let raw = "";
    try {
      raw = await c.req.text();
    } catch {
      raw = "";
    }
    if (raw.length > 4096) return c.json({ ok: false, error: "body too large" }, 413);
    let body: unknown = {};
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return c.json({ ok: false, error: "bad request body" }, 400);
      }
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ ok: false, error: "bad request body" }, 400);
    // The world changed: the next catalog read goes to the plugin.
    catalogCache = null;
    return passBridge(c, { op: "run", command, body: body as Record<string, unknown>, actor: actorFor(c) });
  });

  return app;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The bridge's station list, keeping only well-formed entries. */
export function fillStations(data: unknown): FillStations {
  const d = (data ?? {}) as { kilns?: unknown; smelters?: unknown; fermenters?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as { prefab?: unknown }).prefab === "string") : []);
  return {
    kilns: list(d.kilns).map((s) => ({ prefab: s.prefab as string, inputs: strings(s.inputs) })),
    smelters: list(d.smelters).map((s) => ({ prefab: s.prefab as string, fuel: typeof s.fuel === "string" ? s.fuel : null, inputs: strings(s.inputs) })),
    fermenters: list(d.fermenters).map((s) => ({ prefab: s.prefab as string, inputs: strings(s.inputs) })),
  };
}

function offStatus(reason: BridgeStatus["reason"]): BridgeStatus {
  return { available: false, reason, worldLoaded: false, timeFrozen: false, tested: false, acknowledged: false, testedBuilds: [], commands: [] };
}

/** A device's name for the audit line: ASCII letters, digits and -_.@ only (the plugin's rule). */
export function foldActor(name: string): string {
  return name
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_.@-]/g, "")
    .slice(0, 40);
}

const APPLY_MODES: readonly ApplyMode[] = ["now", "when_empty"];
