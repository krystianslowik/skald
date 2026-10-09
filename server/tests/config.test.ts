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

  it("only turns the Secure cookie off when asked", () => {
    expect(loadConfig({ ...base, COOKIE_SECURE: "false" }).cookieSecure).toBe(false);
    expect(loadConfig({ ...base, COOKIE_SECURE: "0" }).cookieSecure).toBe(true);
  });
});
