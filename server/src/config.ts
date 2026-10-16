import { parseNotifyKinds, type NotifyKind } from "./notify";
import type { Locale } from "./types";

export const LOCALES: readonly Locale[] = ["en", "pl"];

export interface Config {
  bind: string;
  mock: boolean;
  agentUrl: string;
  agentToken: string;
  passwordHash: string;
  /**
   * argon2id hash of an admin password. Set, the panel password only views
   * and admin actions need an admin session; empty, everyone signed in is an
   * admin (the behaviour before 0.8.0).
   */
  adminPasswordHash: string;
  sessionSecret: string;
  /** Empty means "no Prometheus": the resource charts show how to enable them. */
  promUrl: string;
  /** Namespace, container and pod regex the cAdvisor queries filter on. */
  promNamespace: string;
  promContainer: string;
  promPodRegex: string;
  dbPath: string;
  webRoot: string;
  /** Default UI language; each viewer can switch in the header. */
  locale: Locale;
  /** IANA zone for calendar days (streaks, daily playtime, night-owl badge). */
  timeZone: string;
  /** Set the Secure flag on the session cookie. Turn off only for plain-http setups. */
  cookieSecure: boolean;
  /** Header carrying the real client IP (e.g. CF-Connecting-IP); empty = socket address. */
  trustedIpHeader: string;
  /** Show every boss, trader and dungeon location, not only the ones someone found. */
  mapSpoilers: boolean;
  /** Mock mode only: how the fake bridge behaves (on, off, disabled, untested). */
  mockBridge: string;
  /** Discord webhook for notifications; empty means off. A secret: never logged. */
  discordWebhookUrl: string;
  /** Which notifications go to Discord (DISCORD_NOTIFY); all when unset. */
  discordNotify: NotifyKind[];
}

type Env = Record<string, string | undefined>;

/** Throws on anything Intl does not know, so a typo fails at startup instead of skewing streaks. */
export function validTimeZone(tz: string): string {
  new Intl.DateTimeFormat("en", { timeZone: tz });
  return tz;
}

export function loadConfig(env: Env = process.env): Config {
  const mock = env.MOCK_AGENT === "1";
  const opt = (k: string, def: string): string => env[k] || def;
  // In mock mode everything has a dev default; in real mode the secrets are required.
  const req = (k: string, mockDef: string): string => {
    const v = env[k];
    if (v) return v;
    if (mock) return mockDef;
    throw new Error(`${k} is required`);
  };

  const locale = opt("SKALD_LOCALE", "en").toLowerCase();
  if (!LOCALES.includes(locale as Locale)) throw new Error(`SKALD_LOCALE must be one of ${LOCALES.join(", ")}`);

  let timeZone: string;
  try {
    timeZone = validTimeZone(opt("SKALD_TZ", opt("TZ", "UTC")));
  } catch {
    throw new Error(`SKALD_TZ is not a valid IANA time zone: ${env.SKALD_TZ || env.TZ}`);
  }

  const discordWebhookUrl = opt("DISCORD_WEBHOOK_URL", "").trim();
  // The URL is a secret: the error names the variable, never the value.
  if (discordWebhookUrl && !/^https?:\/\//.test(discordWebhookUrl)) throw new Error("DISCORD_WEBHOOK_URL must be an http(s) URL");
  const discordNotify = parseNotifyKinds(opt("DISCORD_NOTIFY", ""));

  return {
    bind: opt("BIND", "0.0.0.0:8080"),
    mock,
    agentUrl: req("AGENT_URL", "http://127.0.0.1:8081").replace(/\/+$/, ""),
    agentToken: req("AGENT_TOKEN", "mock"),
    // Empty in mock mode means "hash the dev password at startup".
    passwordHash: req("PANEL_PASSWORD_HASH", ""),
    adminPasswordHash: opt("ADMIN_PASSWORD_HASH", ""),
    sessionSecret: req("SESSION_SECRET", "mock-session-secret"),
    // Empty means no Prometheus (mock mode synthesizes metrics instead).
    promUrl: opt("PROM_URL", "").replace(/\/+$/, ""),
    promNamespace: opt("PROM_NAMESPACE", opt("POD_NAMESPACE", "valheim")),
    promContainer: opt("PROM_CONTAINER", "valheim"),
    promPodRegex: opt("PROM_POD_REGEX", "valheim-[a-z0-9]+-[a-z0-9]+"),
    dbPath: opt("DB_PATH", mock ? ":memory:" : "/data/skald.db"),
    webRoot: opt("WEB_ROOT", "../web/dist"),
    locale: locale as Locale,
    timeZone,
    cookieSecure: mock ? false : opt("COOKIE_SECURE", "true") !== "false",
    trustedIpHeader: opt("TRUSTED_IP_HEADER", ""),
    mapSpoilers: ["1", "true", "yes", "on"].includes(opt("MAP_SPOILERS", "false").toLowerCase()),
    mockBridge: opt("MOCK_BRIDGE", "on").toLowerCase(),
    discordWebhookUrl,
    discordNotify,
  };
}
