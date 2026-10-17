/**
 * Which origin a state-changing request (or the /live socket) came from, as
 * far as the browser tells. Session cookies are SameSite=Strict, which is per
 * site, not per origin: a page on another port or another subdomain of the
 * same site is "same-site" and gets the cookies sent along. This check closes
 * that gap with the headers a page cannot set itself.
 */

export interface OriginPolicy {
  /** PUBLIC_ORIGIN, normalised to `scheme://host[:port]`; empty: the request's own host. */
  publicOrigins: readonly string[];
  /** Behind a proxy (TRUSTED_IP_HEADER set): X-Forwarded-Host also counts as the panel's host. */
  trustForwardedHost: boolean;
}

export type OriginVerdict =
  | { ok: true; /** The browser vouched for it, but Origin did not match what the server thinks it is. */ mismatch?: { origin: string; expected: string } }
  | { ok: false; origin: string; expected: string };

/** `scheme://host[:port]` with the default port dropped, or null when it is not an http(s) origin. */
export function normaliseOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * host[:port] of a URL with :80 and :443 dropped whatever the scheme: behind a
 * TLS-terminating proxy the request URL says http, so a Host of
 * `panel.example:443` keeps its port there.
 */
function hostOf(url: string): string | null {
  try {
    return normaliseHost(new URL(url).host);
  } catch {
    return null;
  }
}

/** A Host-style value with a default port dropped, so `panel.example:443` equals `panel.example`. */
function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/:(80|443)$/, "");
}

/**
 * Whether `req` may change something. Safe methods are not checked (the
 * caller decides which requests to ask about).
 *
 * - `Sec-Fetch-Site: same-origin` (or `none`, typed by the user): the browser
 *   itself says the page is the panel's, which no page can fake. Allowed even
 *   when Origin does not match what this server thinks its origin is (a proxy
 *   that rewrites Host); the mismatch is returned for a warning.
 * - Any other Sec-Fetch-Site (`same-site`, `cross-site`): refused.
 * - No Sec-Fetch-Site (an older browser): Origin must match the panel's origin,
 *   PUBLIC_ORIGIN exactly when set, else the request's host (and port). The
 *   scheme is not compared then: behind a TLS-terminating proxy the server
 *   cannot tell it.
 * - Neither header: not a browser (curl, scripts), allowed.
 */
export function checkOrigin(req: Request, policy: OriginPolicy): OriginVerdict {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  const expected = expectedOrigin(req, policy);
  const matches = origin !== null && originMatches(origin, req, policy);

  if (site === "same-origin" || site === "none") {
    if (origin !== null && !matches) return { ok: true, mismatch: { origin, expected } };
    return { ok: true };
  }
  if (site) return { ok: false, origin: origin ?? `(Sec-Fetch-Site: ${site})`, expected };
  if (origin === null) return { ok: true };
  return matches ? { ok: true } : { ok: false, origin, expected };
}

function originMatches(origin: string, req: Request, policy: OriginPolicy): boolean {
  const o = normaliseOrigin(origin);
  if (!o) return false; // "null" (sandboxed frames, file://) and anything that is no http(s) origin
  if (policy.publicOrigins.length > 0) return policy.publicOrigins.includes(o);
  const host = hostOf(o);
  return host !== null && requestHosts(req, policy).includes(host);
}

/** The hosts the panel answers on for this request: the URL's (built from Host) and, behind a trusted proxy, X-Forwarded-Host. */
function requestHosts(req: Request, policy: OriginPolicy): string[] {
  const hosts: string[] = [];
  const own = hostOf(req.url);
  if (own) hosts.push(own);
  if (policy.trustForwardedHost) {
    const fwd = req.headers.get("x-forwarded-host")?.split(",")[0];
    if (fwd) hosts.push(normaliseHost(fwd));
  }
  return hosts;
}

/** What the panel's origin was taken to be, for the log line. */
function expectedOrigin(req: Request, policy: OriginPolicy): string {
  if (policy.publicOrigins.length > 0) return policy.publicOrigins.join(", ");
  return requestHosts(req, policy).join(" or ") || "(unknown host)";
}
