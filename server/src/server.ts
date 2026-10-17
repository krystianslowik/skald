import { HttpAgent, type AgentSource } from "./agent";
import { createApp } from "./app";
import { upgradeLive } from "./auth";
import { checkPasswordHash, loadConfig, type Config } from "./config";
import { HistoryStore } from "./db";
import { hashPassword } from "./hash";
import { Hub } from "./hub";
import { MapCache } from "./map";
import { DiscordNotifier, NotifySettings } from "./notify";
import { metricsFetch, VERSION } from "./buildinfo";
import { cachedMetrics, fetchMetrics } from "./prom";
import { mountStatic } from "./static";
import type { Metrics } from "./types";
import { liveSocket, liveSocketData, type LiveSocketData } from "./live";
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
let mockMetrics: (() => Metrics) | null = null;
if (cfg.mock) {
  // Release builds pass `--define process.env.SKALD_NO_MOCK='"1"'`. The test then
  // folds to a constant and the bundler drops the else branch, and with it the
  // dynamic import of the mock agent, from the binary.
  if (process.env.SKALD_NO_MOCK === "1") {
    console.error("MOCK_AGENT=1: this skald-web build has no mock agent. Unset MOCK_AGENT, or run `bun run dev` from a source checkout.");
    process.exit(1);
  } else {
    const m = await import("./mock");
    const mock = new m.MockAgent(Date.now, cfg.timeZone, cfg.mockBridge);
    mock.start();
    agent = mock;
    mockMetrics = m.mockMetrics;
    if (!passwordHash) {
      passwordHash = await Bun.password.hash("ognisko");
      console.log('MOCK_AGENT=1: fake agent, dev password is "ognisko"');
    }
    if (!adminPasswordHash && process.env.MOCK_ADMIN === "1") {
      adminPasswordHash = await Bun.password.hash("jarl");
      console.log('MOCK_ADMIN=1: admin actions need the admin password "jarl"');
    }
  }
} else {
  agent = new HttpAgent(cfg.agentUrl, cfg.agentToken);
}

const store = new HistoryStore(cfg.dbPath);
const hub = new Hub(agent, store, { timeZone: cfg.timeZone });
// Subscribed before start: the first state it sees is its baseline, and
// nothing that happened before boot is sent.
// Always there, so a webhook saved in the admin sheet later starts from the same
// baseline; it sends nothing until DISCORD_WEBHOOK_URL or the panel gives it one.
const notifier = new DiscordNotifier({ url: "", kinds: cfg.discordNotify, locale: cfg.locale });
hub.subscribe((m) => notifier.handle(m));
const notify = new NotifySettings({ notifier, store, envUrl: cfg.discordWebhookUrl, envKinds: cfg.discordNotify });
hub.start();

const target = { namespace: cfg.promNamespace, container: cfg.promContainer, podRegex: cfg.promPodRegex };
const metricsConfigured = Boolean(cfg.promUrl) || mockMetrics !== null;
const metrics = cachedMetrics(async () => {
  if (cfg.promUrl) return fetchMetrics(cfg.promUrl, target);
  return mockMetrics ? mockMetrics() : null;
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
  notify,
  version: VERSION,
  update: updates ? () => updates.get() : undefined,
});

// Static SPA, resolved relative to the process CWD (image: /app/bin -> /app/web/dist).
mountStatic(app, cfg.webRoot, cfg.locale);

const live = liveSocket(hub);

const [host, portStr] = cfg.bind.split(":");
const server = Bun.serve<LiveSocketData>({
  hostname: host || "0.0.0.0",
  port: Number.parseInt(portStr ?? "8080", 10),
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/live") return upgradeLive(req, cfg.sessionSecret, () => srv.upgrade(req, { data: liveSocketData(url) }));
    return app.fetch(req, { server: srv });
  },
  websocket: {
    // Clients only ever send a short subscribe or unsubscribe.
    maxPayloadLength: 4096,
    open: (ws) => live.open(ws),
    message: (ws, raw) => live.message(ws, raw),
    close: (ws) => live.close(ws),
  },
});

// skald_build_info on its own port, so the panel port carries no unauthenticated route.
if (cfg.metricsBind) {
  const [mHost, mPort] = cfg.metricsBind.split(":");
  const m = Bun.serve({ hostname: mHost || "0.0.0.0", port: Number.parseInt(mPort ?? "9465", 10), fetch: metricsFetch(VERSION) });
  console.log(`skald-web metrics on ${m.hostname}:${m.port}`);
}

console.log(
  `skald-web ${VERSION} listening on ${server.hostname}:${server.port} (locale ${cfg.locale}, tz ${cfg.timeZone}, metrics ${metricsConfigured ? "on" : "off"}, map spoilers ${cfg.mapSpoilers ? "on" : "off"}, admin password ${adminPasswordHash ? "on" : "off"}, discord ${notify.fromEnv ? "env" : notify.on ? "panel" : "off"}, update check ${updates ? "on" : "off"})${cfg.mock ? " (mock agent)" : ""}`,
);
