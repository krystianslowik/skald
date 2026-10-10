import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "skald_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const b64url = (buf: Buffer): string => buf.toString("base64url");

function sign(secret: string, payload: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

/** Token format: `v1.<expiresAtMs>.<nonce>.<hmac>`. Stateless; logout clears the cookie. */
export function createSession(secret: string, now = Date.now()): string {
  const payload = `v1.${now + SESSION_TTL_MS}.${b64url(randomBytes(12))}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySession(secret: string, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const payload = parts.slice(0, 3).join(".");
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(parts[3] ?? "");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const exp = Number(parts[1]);
  return Number.isFinite(exp) && exp > now;
}

export const ADMIN_COOKIE = "skald_admin";
/** An admin session ends after this long without an admin call. */
export const ADMIN_IDLE_MS = 30 * 60 * 1000;

/** The part of a session token that ties an admin token to it. */
function sessionTag(session: string): string {
  return b64url(createHmac("sha256", "skald-admin-tag").update(session).digest()).slice(0, 16);
}

/**
 * Admin token: `a1.<expiresAtMs>.<sessionTag>.<hmac>`. Valid only next to the
 * session it was issued with, and only until it has been idle for
 * ADMIN_IDLE_MS: every admin call issues a fresh one.
 */
export function createAdminSession(secret: string, session: string, now = Date.now()): string {
  const payload = `a1.${now + ADMIN_IDLE_MS}.${sessionTag(session)}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyAdminSession(secret: string, token: string | undefined, session: string | undefined, now = Date.now()): boolean {
  if (!token || !session) return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "a1") return false;
  const payload = parts.slice(0, 3).join(".");
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(parts[3] ?? "");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  if (parts[2] !== sessionTag(session)) return false;
  const exp = Number(parts[1]);
  return Number.isFinite(exp) && exp > now;
}

/** A short, stable, non-reversible name for a session in the audit log. */
export function sessionHash(session: string): string {
  return createHmac("sha256", "skald-actor").update(session).digest("hex").slice(0, 6);
}

/** Reads one cookie out of a Cookie header (used for the WebSocket upgrade). */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

interface Bucket {
  attempts: number[];
  lockedUntil: number;
}

/**
 * Login limiter: at most `max` attempts per `windowMs` per key; the attempt
 * after that locks the key for `lockMs`. Checked BEFORE the (slow) argon2 verify.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 60_000,
    private readonly lockMs = 15 * 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Records an attempt. Returns 0 if allowed, otherwise seconds until retry. */
  hit(key: string): number {
    const now = this.clock();
    const b = this.buckets.get(key) ?? { attempts: [], lockedUntil: 0 };
    this.buckets.set(key, b);
    if (b.lockedUntil > now) return Math.ceil((b.lockedUntil - now) / 1000);
    b.attempts = b.attempts.filter((t) => now - t < this.windowMs);
    if (b.attempts.length >= this.max) {
      b.lockedUntil = now + this.lockMs;
      b.attempts = [];
      return Math.ceil(this.lockMs / 1000);
    }
    b.attempts.push(now);
    this.prune(now);
    return 0;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private prune(now: number): void {
    if (this.buckets.size < 1000) return;
    for (const [k, b] of this.buckets) {
      if (b.lockedUntil <= now && b.attempts.every((t) => now - t >= this.windowMs)) this.buckets.delete(k);
    }
  }
}
