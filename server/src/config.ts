import { parseNotifyKinds, type NotifyKind } from "./notify";
import { normaliseOrigin } from "./origin";
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
  /**
   * PUBLIC_ORIGIN: where browsers open the panel (`https://panel.example`),
   * comma-separated for several. Empty: the request's own host.
   */
  publicOrigins: string[];
  /** Show every boss, trader and dungeon location, not only the ones someone found. */
  mapSpoilers: boolean;
  /** Mock mode only: how the fake bridge behaves (on, off, disabled, untested). */
  mockBridge: string;
  /** Discord webhook for notifications; empty means off. A secret: never logged. */
  discordWebhookUrl: string;
  /** Which notifications go to Discord (DISCORD_NOTIFY); all when unset. */
  discordNotify: NotifyKind[];
  /** Prometheus listener (METRICS_BIND, e.g. 0.0.0.0:9465); empty means off. */
  metricsBind: string;
  /** Ask GitHub for a newer Skald release (SKALD_UPDATE_CHECK, off with `off`). */
  updateCheck: boolean;
}

type Env = Record<string, string | undefined>;

/** Throws on anything Intl does not know, so a typo fails at startup instead of skewing streaks. */
export function validTimeZone(tz: string): string {
  new Intl.DateTimeFormat("en", { timeZone: tz });
  return tz;
}

/** What Bun.password.verify takes: argon2id/argon2i/argon2d or bcrypt. */
const HASH_FORMAT = /^\$(argon2(id|i|d)|2[abxy]?)\$/i;

/**
 * Throws when a set password hash can never match, so a hash mangled by `$`
 * expansion fails at startup instead of turning every login into "wrong
 * password". The error names the variable, never the value.
 */
export async function checkPasswordHash(
  name: string,
  hash: string,
  verify: (password: string, hash: string) => Promise<boolean> = (p, h) => Bun.password.verify(p, h),
): Promise<void> {
  if (!hash) return;
  let ok = HASH_FORMAT.test(hash);
  if (ok) {
    try {
      await verify("skald-startup-check", hash);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    throw new Error(
      `${name} is not a valid argon2 or bcrypt hash. Make one with "skald-web hash-password" and check that its $ signs survive your .env file or shell (in a Compose .env, keep it in single quotes).`,
    );
  }
}

/** PUBLIC_ORIGIN as a list of `scheme://host[:port]`; throws on anything else (a path, a query, no scheme). */
export function parsePublicOrigins(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (!v) continue;
    let u: URL | null = null;
    try {
      u = new URL(v);
    } catch {
      // reported below
    }
    const o = u && normaliseOrigin(v);
    if (!u || !o || u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
      throw new Error(`PUBLIC_ORIGIN must be scheme://host[:port] (http or https, no path), comma-separated: ${v}`);
    }
    if (!out.includes(o)) out.push(o);
  }
  return out;
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
    publicOrigins: parsePublicOrigins(opt("PUBLIC_ORIGIN", "")),
    mapSpoilers: ["1", "true", "yes", "on"].includes(opt("MAP_SPOILERS", "false").toLowerCase()),
    mockBridge: opt("MOCK_BRIDGE", "on").toLowerCase(),
    discordWebhookUrl,
    discordNotify,
    metricsBind: opt("METRICS_BIND", "").trim(),
    updateCheck: !["off", "false", "0", "no"].includes(opt("SKALD_UPDATE_CHECK", "on").trim().toLowerCase()),
  };
}
