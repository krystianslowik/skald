import { describe, expect, it } from "bun:test";
import { createSession, RateLimiter, readCookie, SESSION_TTL_MS, verifySession } from "../src/auth";

describe("session", () => {
  it("round-trips and rejects tampering, wrong secret and expiry", () => {
    const now = 1_800_000_000_000;
    const tok = createSession("s3cret", now);
    expect(verifySession("s3cret", tok, now)).toBe(true);
    expect(verifySession("other", tok, now)).toBe(false);
    const parts = tok.split(".");
    parts[1] = String(Number(parts[1]) + 1000);
    expect(verifySession("s3cret", parts.join("."), now)).toBe(false);
    expect(verifySession("s3cret", tok, now + SESSION_TTL_MS + 1)).toBe(false);
    expect(verifySession("s3cret", undefined, now)).toBe(false);
    expect(verifySession("s3cret", "garbage", now)).toBe(false);
  });

  it("reads a cookie from a header", () => {
    expect(readCookie("a=1; skald_session=abc.def; b=2", "skald_session")).toBe("abc.def");
    expect(readCookie(null, "skald_session")).toBeUndefined();
  });
});

describe("RateLimiter", () => {
  it("allows 5 per minute, then locks for 15 minutes", () => {
    let t = 0;
    const rl = new RateLimiter(5, 60_000, 15 * 60_000, () => t);
    for (let i = 0; i < 5; i++) expect(rl.hit("1.2.3.4")).toBe(0);
    expect(rl.hit("1.2.3.4")).toBe(900);
    expect(rl.hit("5.6.7.8")).toBe(0);
    t += 61_000; // window passed, but the lockout has not
    expect(rl.hit("1.2.3.4")).toBeGreaterThan(0);
    t = 15 * 60_000 + 1;
    expect(rl.hit("1.2.3.4")).toBe(0);
  });

  it("spaced attempts never lock", () => {
    let t = 0;
    const rl = new RateLimiter(5, 60_000, 900_000, () => t);
    for (let i = 0; i < 20; i++) {
      expect(rl.hit("ip")).toBe(0);
      t += 13_000;
    }
  });
});
