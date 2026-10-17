import type { ActionName, ActionResult, ApiState, ApplyMode, LogLine, PlayerProfile, PublicConfig, SettingsInput, SettingsView } from "../types";

export class Unauthorized extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Public, works before login: the server's default language. */
export async function getConfig(): Promise<PublicConfig> {
  const res = await fetch("/api/config", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PublicConfig;
}

/**
 * Only a 401 means signed out. Anything else that is not a 2xx (no network, a
 * 502 while the server restarts) throws: the session is unknown, not gone.
 */
export async function me(): Promise<boolean> {
  const res = await fetch("/api/me", { credentials: "same-origin" });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

export type LoginResult = { ok: true } | { ok: false; retryAfter?: number; /** The server's origin check refused the request. */ refused?: boolean };

/** An answer's status and parsed body say the origin check refused it (see originRefused). */
export const isOriginRefusal = (status: number, body: unknown): boolean =>
  status === 403 && typeof body === "object" && body !== null && (body as { error?: unknown }).error === "cross_origin";

/** The server refused a request as coming from another origin: a proxy setting (PUBLIC_ORIGIN), not a wrong password. */
export async function originRefused(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    return isOriginRefusal(res.status, await res.clone().json());
  } catch {
    return false;
  }
}

export async function login(password: string): Promise<LoginResult> {
  const res = await fetch("/api/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.ok) return { ok: true };
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After")) || 900;
    return { ok: false, retryAfter };
  }
  if (await originRefused(res)) return { ok: false, refused: true };
  return { ok: false };
}

/**
 * Whether the server ended the session. The cookie is HttpOnly: only the
 * server's answer clears it, so anything else leaves the viewer signed in.
 */
export type LogoutResult = "ok" | "offline" | "refused" | "failed";

/** The terrain tiles the service worker keeps (sw.js), dropped on sign-out or when the session is gone: the world's land is for signed-in viewers. */
export async function dropTerrainTiles(): Promise<void> {
  const c = globalThis.caches;
  if (!c) return;
  try {
    const names = await c.keys();
    await Promise.all(names.filter((n) => n.startsWith("skald-terrain-")).map((n) => c.delete(n)));
  } catch {
    // no storage to clear
  }
}

export async function logout(): Promise<LogoutResult> {
  let res: Response;
  try {
    res = await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    return "offline";
  }
  // Only skald-web's own answer counts: a proxy's login page reached through a redirect is a 200 too.
  if (res.ok) {
    if (((await res.json().catch(() => null)) as { ok?: unknown } | null)?.ok !== true) return "failed";
    await dropTerrainTiles();
    return "ok";
  }
  if (await originRefused(res)) return "refused";
  // A proxy's error page while skald-web is down: as good as no connection.
  return res.status >= 500 ? "offline" : "failed";
}

export const getState = () => call<ApiState>("/api/state");
export const getLogs = (limit = 500) => call<{ lines: LogLine[] }>(`/api/logs?limit=${limit}`).then((r) => r.lines);

export async function runAction(name: ActionName): Promise<{ status: number; body: ActionResult }> {
  const res = await fetch(`/api/action/${name}`, { method: "POST", credentials: "same-origin" });
  if (res.status === 401) throw new Unauthorized();
  let body: ActionResult;
  try {
    body = (await res.json()) as ActionResult;
  } catch {
    body = { ok: false, message: `HTTP ${res.status}` };
  }
  return { status: res.status, body };
}

export const getPlayer = (name: string) => call<PlayerProfile>(`/api/players/${encodeURIComponent(name)}`);

/** Same-origin link: the session cookie rides along and the browser streams the zip to disk. */
export const backupHref = (name: string) => `/api/backups/${encodeURIComponent(name)}`;

/** A settings call's raw outcome: the status matters (400 carries field errors, 409 busy, 404 off). */
export interface SettingsResult<T> {
  status: number;
  body: T;
}

async function settingsCall<T>(path: string, init?: RequestInit): Promise<SettingsResult<T>> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 401) throw new Unauthorized();
  let body: T;
  try {
    body = (await res.json()) as T;
  } catch {
    body = { ok: false, message: `HTTP ${res.status}` } as T;
  }
  return { status: res.status, body };
}

export type SettingsFailure = { ok: false; message: string; errors?: Record<string, string> };

export const getSettings = () => settingsCall<SettingsView>("/api/settings");

/** Only on an explicit reveal or copy: the password never rides along otherwise. */
export const getServerPassword = () => settingsCall<{ password: string }>("/api/settings/password");

export const putSettings = (input: SettingsInput) =>
  settingsCall<SettingsView | SettingsFailure>("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const applySettings = (mode: ApplyMode) =>
  settingsCall<SettingsView | ActionResult | SettingsFailure>("/api/settings/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });

export const cancelApply = () => settingsCall<SettingsView | SettingsFailure>("/api/settings/apply", { method: "DELETE" });
