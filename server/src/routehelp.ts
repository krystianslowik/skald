import type { Context } from "hono";
import type { RateLimiter } from "./auth";

/**
 * A JSON request body, or the 4xx to answer. JSON only: a cross-site form
 * cannot send it without a preflight. `max`: bytes, checked on the header and
 * on what arrives.
 */
export async function jsonBody(c: Context, max: number): Promise<unknown | Response> {
  if (!/^application\/json\b/i.test(c.req.header("Content-Type") ?? "")) return c.json({ ok: false, error: "bad request body" }, 415);
  if (Number(c.req.header("Content-Length") ?? 0) > max) return c.json({ ok: false, error: "body too large" }, 413);
  let raw = "";
  try {
    raw = await c.req.text();
  } catch {
    return c.json({ ok: false, error: "bad request body" }, 400);
  }
  if (raw.length > max) return c.json({ ok: false, error: "body too large" }, 413);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return c.json({ ok: false, error: "bad request body" }, 400);
  }
}

/**
 * A write limit for one feature: `limited(c)` counts the call against
 * `<scope>:<client>` and returns the 429 to answer, or null when the client
 * may go on. Call it after the request has been parsed, so a malformed one
 * is not counted.
 */
export function writeLimit(limiter: RateLimiter, scope: string, clientKey?: (c: Context) => string): (c: Context) => Response | null {
  return (c) => {
    const wait = limiter.hit(`${scope}:${clientKey?.(c) ?? "all"}`);
    return wait > 0 ? c.json({ ok: false, error: "rate_limited", retryAfter: wait }, 429, { "Retry-After": String(wait) }) : null;
  };
}
