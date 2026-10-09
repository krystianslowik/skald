import type { ActionName, ActionResult, ApiState, LogLine, PlayerProfile, PublicConfig } from "../types";

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

export async function me(): Promise<boolean> {
  const res = await fetch("/api/me", { credentials: "same-origin" });
  return res.ok;
}

export type LoginResult = { ok: true } | { ok: false; retryAfter?: number };

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
  return { ok: false };
}

export async function logout(): Promise<void> {
  await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
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
