import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config";

const base = { AGENT_URL: "http://agent:8080", AGENT_TOKEN: "t", PANEL_PASSWORD_HASH: "h", SESSION_SECRET: "s" };

describe("config", () => {
  it("has safe, generic defaults", () => {
    const c = loadConfig(base);
    expect(c.locale).toBe("en");
    expect(c.timeZone).toBe("UTC");
    expect(c.promUrl).toBe("");
    expect(c.cookieSecure).toBe(true);
    expect(c.trustedIpHeader).toBe("");
    expect(c.dbPath).toBe("/data/skald.db");
  });

  it("requires the agent URL and secrets outside mock mode", () => {
    expect(() => loadConfig({ ...base, AGENT_URL: "" })).toThrow("AGENT_URL is required");
    expect(() => loadConfig({ ...base, SESSION_SECRET: undefined })).toThrow("SESSION_SECRET is required");
    expect(loadConfig({ MOCK_AGENT: "1" }).mock).toBe(true);
  });

  it("reads locale and time zone, falling back from SKALD_TZ to TZ", () => {
    expect(loadConfig({ ...base, SKALD_LOCALE: "PL" }).locale).toBe("pl");
    expect(() => loadConfig({ ...base, SKALD_LOCALE: "de" })).toThrow("SKALD_LOCALE");
    expect(loadConfig({ ...base, TZ: "Asia/Tokyo" }).timeZone).toBe("Asia/Tokyo");
    expect(loadConfig({ ...base, TZ: "Asia/Tokyo", SKALD_TZ: "Europe/Warsaw" }).timeZone).toBe("Europe/Warsaw");
    expect(() => loadConfig({ ...base, SKALD_TZ: "Mars/Olympus" })).toThrow("SKALD_TZ");
  });

  it("checks for updates unless SKALD_UPDATE_CHECK is off", () => {
    expect(loadConfig(base).updateCheck).toBe(true);
    expect(loadConfig(base).metricsBind).toBe("");
    expect(loadConfig({ ...base, METRICS_BIND: "0.0.0.0:9465" }).metricsBind).toBe("0.0.0.0:9465");
    expect(loadConfig({ ...base, SKALD_UPDATE_CHECK: "off" }).updateCheck).toBe(false);
    expect(loadConfig({ ...base, SKALD_UPDATE_CHECK: "OFF " }).updateCheck).toBe(false);
    expect(loadConfig({ ...base, SKALD_UPDATE_CHECK: "on" }).updateCheck).toBe(true);
  });

  it("only turns the Secure cookie off when asked", () => {
    expect(loadConfig({ ...base, COOKIE_SECURE: "false" }).cookieSecure).toBe(false);
    expect(loadConfig({ ...base, COOKIE_SECURE: "0" }).cookieSecure).toBe(true);
  });

  it("names a push contact: PUSH_CONTACT, else the https public origin, else the project", () => {
    expect(loadConfig(base).pushContact).toBe("https://github.com/krystianslowik/skald");
    expect(loadConfig({ ...base, PUBLIC_ORIGIN: "http://lan.example:8080,https://skald.example" }).pushContact).toBe("https://skald.example");
    expect(loadConfig({ ...base, PUSH_CONTACT: "mailto:jarl@example.com" }).pushContact).toBe("mailto:jarl@example.com");
    expect(() => loadConfig({ ...base, PUSH_CONTACT: "jarl@example.com" })).toThrow("PUSH_CONTACT");
    expect(() => loadConfig({ ...base, PUSH_CONTACT: "http://skald.example" })).toThrow("PUSH_CONTACT");
  });

  it("keeps Discord off unless a webhook is set, and checks the kinds", () => {
    const c = loadConfig(base);
    expect(c.discordWebhookUrl).toBe("");
    expect(c.discordNotify).toContain("join_code");
    expect(loadConfig({ ...base, DISCORD_NOTIFY: "join, Join_Code" }).discordNotify).toEqual(["join", "join_code"]);
    expect(() => loadConfig({ ...base, DISCORD_NOTIFY: "join,saves" })).toThrow("DISCORD_NOTIFY");
    const secret = "discord.example/api/webhooks/1/abc";
    let message = "";
    try {
      loadConfig({ ...base, DISCORD_WEBHOOK_URL: secret });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("DISCORD_WEBHOOK_URL");
    expect(message).not.toContain("abc");
  });
});

describe("MOCK_WRITE_DELAY_MS", () => {
  it("holds writes only on the mock", () => {
    expect(loadConfig({ MOCK_AGENT: "1", MOCK_WRITE_DELAY_MS: "1000" }).mockWriteDelayMs).toBe(1000);
    expect(loadConfig({ MOCK_AGENT: "1", MOCK_WRITE_DELAY_MS: "soon" }).mockWriteDelayMs).toBe(0);
    expect(loadConfig({ MOCK_AGENT: "1", MOCK_WRITE_DELAY_MS: "-5" }).mockWriteDelayMs).toBe(0);
    expect(loadConfig({ MOCK_AGENT: "1", MOCK_WRITE_DELAY_MS: "1e9" }).mockWriteDelayMs).toBe(60_000);
    expect(loadConfig({ MOCK_AGENT: "1" }).mockWriteDelayMs).toBe(0);
    expect(loadConfig({ ...base, MOCK_WRITE_DELAY_MS: "1000" }).mockWriteDelayMs).toBe(0);
  });
});
