import { HttpAgent, type AgentSource } from "./agent";
import { createApp } from "./app";
import { readCookie, SESSION_COOKIE, verifySession } from "./auth";
import { checkPasswordHash, loadConfig, type Config } from "./config";
import { HistoryStore } from "./db";
import { hashPassword } from "./hash";
import { Hub } from "./hub";
import { MapCache } from "./map";
import { MockAgent, mockMetrics } from "./mock";
import { DiscordNotifier } from "./notify";
import { metricsFetch, VERSION } from "./buildinfo";
import { cachedMetrics, fetchMetrics } from "./prom";
import { mountStatic } from "./static";
import type { LiveMessage } from "./types";
import { UpdateChecker } from "./update";
import { isRelease } from "./version";

// `skald-web hash-password`: reads a password on stdin, prints an argon2id hash
// for PANEL_PASSWORD_HASH or ADMIN_PASSWORD_HASH. Handled before loadConfig, which needs the secrets.
if (process.argv[2] === "hash-password") {
  try {
    console.log(await hashPassword(await Bun.stdin.text()));
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

// A bad setting stops the server here with one line naming the variable.
let cfg: Config;
try {
  cfg = loadConfig();
  await checkPasswordHash("PANEL_PASSWORD_HASH", cfg.passwordHash);
  await checkPasswordHash("ADMIN_PASSWORD_HASH", cfg.adminPasswordHash);
} catch (e) {
  console.error(`skald-web: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

let agent: AgentSource;
let passwordHash = cfg.passwordHash;
let adminPasswordHash = cfg.adminPasswordHash;
if (cfg.mock) {
  const mock = new MockAgent(Date.now, cfg.timeZone, cfg.mockBridge);
  mock.start();
  agent = mock;
  if (!passwordHash) {
    passwordHash = await Bun.password.hash("ognisko");
    console.log('MOCK_AGENT=1: fake agent, dev password is "ognisko"');
  }
  if (!adminPasswordHash && process.env.MOCK_ADMIN === "1") {
    adminPasswordHash = await Bun.password.hash("jarl");
    console.log('MOCK_ADMIN=1: admin actions need the admin password "jarl"');
  }
} else {
  agent = new HttpAgent(cfg.agentUrl, cfg.agentToken);
}

const store = new HistoryStore(cfg.dbPath);
const hub = new Hub(agent, store, { timeZone: cfg.timeZone });
// Subscribed before start: the first state it sees is its baseline, and
// nothing that happened before boot is sent.
const notifier = cfg.discordWebhookUrl ? new DiscordNotifier({ url: cfg.discordWebhookUrl, kinds: cfg.discordNotify, locale: cfg.locale }) : null;
if (notifier) hub.subscribe((m) => notifier.handle(m));
hub.start();

const target = { namespace: cfg.promNamespace, container: cfg.promContainer, podRegex: cfg.promPodRegex };
const metricsConfigured = Boolean(cfg.promUrl) || cfg.mock;
const metrics = cachedMetrics(async () => {
  if (cfg.promUrl) return fetchMetrics(cfg.promUrl, target);
  return cfg.mock ? mockMetrics() : null;
});

// Once at boot, then again on the first admin status after 12 h. Release builds only.
const updates = cfg.updateCheck && isRelease(VERSION) ? new UpdateChecker({ current: VERSION }) : null;
void updates?.check();

const app = createApp({
  sessionSecret: cfg.sessionSecret,
  passwordHash,
  adminPasswordHash,
  secureCookie: cfg.cookieSecure,
  agent,
  hub,
  metrics,
  metricsConfigured,
  locale: cfg.locale,
  trustedIpHeader: cfg.trustedIpHeader,
  map: new MapCache((etag) => agent.map(etag), cfg.mapSpoilers),
  notifyTest: notifier ? () => notifier.test() : undefined,
  version: VERSION,
  update: updates ? () => updates.get() : undefined,
});

// Static SPA, resolved relative to the process CWD (image: /app/bin -> /app/web/dist).
mountStatic(app, cfg.webRoot);

type WsData = { unsubscribe?: () => void };

const [host, portStr] = cfg.bind.split(":");
const server = Bun.serve<WsData>({
  hostname: host || "0.0.0.0",
  port: Number.parseInt(portStr ?? "8080", 10),
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/live") {
      // Authenticate before the upgrade, never after.
      if (!verifySession(cfg.sessionSecret, readCookie(req.headers.get("cookie"), SESSION_COOKIE))) {
        return new Response("unauthorized", { status: 401 });
      }
      if (srv.upgrade(req, { data: {} })) return undefined;
      return new Response("ws upgrade failed", { status: 400 });
    }
    return app.fetch(req, { server: srv });
  },
  websocket: {
    open(ws) {
      const send = (m: LiveMessage) => ws.send(JSON.stringify(m));
      send({ type: "state", state: hub.getState(), online: hub.online });
      const positions = hub.latestPositions();
      if (positions) send(positions);
      ws.data.unsubscribe = hub.subscribe(send);
    },
    close(ws) {
      ws.data.unsubscribe?.();
    },
    message() {
      // clients never send anything
    },
  },
});

// skald_build_info on its own port, so the panel port carries no unauthenticated route.
if (cfg.metricsBind) {
  const [mHost, mPort] = cfg.metricsBind.split(":");
  const m = Bun.serve({ hostname: mHost || "0.0.0.0", port: Number.parseInt(mPort ?? "9465", 10), fetch: metricsFetch(VERSION) });
  console.log(`skald-web metrics on ${m.hostname}:${m.port}`);
}

console.log(
  `skald-web ${VERSION} listening on ${server.hostname}:${server.port} (locale ${cfg.locale}, tz ${cfg.timeZone}, metrics ${metricsConfigured ? "on" : "off"}, map spoilers ${cfg.mapSpoilers ? "on" : "off"}, admin password ${adminPasswordHash ? "on" : "off"}, discord ${notifier ? "on" : "off"}, update check ${updates ? "on" : "off"})${cfg.mock ? " (mock agent)" : ""}`,
);
