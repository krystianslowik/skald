// Phone push on this device: the browser's subscription and the server's copy
// of this device's choice (/api/push). Every call is best effort: a browser
// without push, a missing service worker or a refused permission is a state
// to show, never an exception.
import { PUSH_DEFAULT_KINDS, type PushInfo, type PushPrefs } from "@server/pushtypes";
import type { Locale } from "../types";
import { Unauthorized } from "./api";

/**
 * - `ok`: this browser can take push.
 * - `install`: an iPhone or iPad in Safari: push works only from the panel on the Home Screen.
 * - `unsupported`: no push here (an old browser, a private window, a dev build without the service worker).
 */
export type PushSupport = "ok" | "install" | "unsupported";

const isAppleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "ok";
  return isAppleMobile() && !standalone() ? "install" : "unsupported";
}

/** Whether this device asked for push; kept so the panel does not wake the service worker for nothing. */
const ON_KEY = "skald_push_on";
const remember = (on: boolean) => {
  try {
    if (on) localStorage.setItem(ON_KEY, "1");
    else localStorage.removeItem(ON_KEY);
  } catch {
    // no storage: only the hint is lost
  }
};
export const pushRemembered = (): boolean => {
  try {
    return localStorage.getItem(ON_KEY) === "1";
  } catch {
    return false;
  }
};

/** The service worker that shows the notifications; null when there is none (a dev build) within a few seconds. */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    return await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
  } catch {
    return null;
  }
}

async function subscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  try {
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

async function send(path: string, method: string, body?: unknown): Promise<Response> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  return res;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

export function defaultPrefs(locale: Locale): PushPrefs {
  let timeZone = "UTC";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    // UTC
  }
  return { kinds: [...PUSH_DEFAULT_KINDS], firstJoinOnly: false, quiet: null, timeZone, locale };
}

/** This device's choice as the server keeps it; null when it gets no push. */
export async function loadDevice(): Promise<PushPrefs | null> {
  const sub = await subscription();
  if (!sub) {
    remember(false);
    return null;
  }
  const res = await send("/api/push/device", "POST", { endpoint: sub.endpoint });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const prefs = ((await res.json()) as { prefs: PushPrefs | null }).prefs;
  remember(prefs !== null);
  return prefs;
}

export type EnableResult = "ok" | "denied" | "unsupported" | "failed";

/**
 * Turns push on for this device. The permission prompt comes first, while
 * the tap that asked is still on the stack: Safari shows it only then.
 */
export async function enablePush(prefs: PushPrefs): Promise<EnableResult> {
  if (pushSupport() !== "ok") return "unsupported";
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return "denied";
  }
  if (permission !== "granted") return "denied";
  const reg = await registration();
  if (!reg) return "unsupported";
  try {
    const infoRes = await send("/api/push", "GET");
    if (!infoRes.ok) return "failed";
    const key = keyBytes(((await infoRes.json()) as PushInfo).publicKey);
    let sub = await reg.pushManager.getSubscription();
    // Made for another key (the panel's database was replaced): push services would refuse it.
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    return (await savePrefs(prefs, sub)) ? "ok" : "failed";
  } catch (e) {
    if (e instanceof Unauthorized) throw e;
    return "failed";
  }
}

/** Saves this device's choice; false when the server did not take it. */
export async function savePrefs(prefs: PushPrefs, sub?: PushSubscription | null): Promise<boolean> {
  const s = sub ?? (await subscription());
  if (!s) return false;
  const json = s.toJSON();
  const res = await send("/api/push", "PUT", { subscription: { endpoint: json.endpoint, keys: json.keys }, prefs });
  remember(res.ok);
  return res.ok;
}

/** Turns push off for this device, on the server and in the browser. */
export async function disablePush(): Promise<void> {
  remember(false);
  const sub = await subscription();
  if (!sub) return;
  try {
    await send("/api/push", "DELETE", { endpoint: sub.endpoint });
  } finally {
    await sub.unsubscribe().catch(() => false);
  }
}

export type TestResult = { ok: true } | { ok: false; retryAfter?: number };

export async function sendTestPush(): Promise<TestResult> {
  const sub = await subscription();
  if (!sub) return { ok: false };
  const res = await send("/api/push/test", "POST", { endpoint: sub.endpoint });
  if (res.ok) return { ok: true };
  return { ok: false, retryAfter: res.status === 429 ? Number(res.headers.get("Retry-After")) || 10 : undefined };
}

/**
 * After a sign-out the server ended: the browser drops its subscription, so
 * the push service answers the next notification with "gone" and the server
 * forgets the device. Never throws.
 */
export async function dropPushAfterLogout(): Promise<void> {
  if (!pushRemembered()) return;
  remember(false);
  try {
    await (await subscription())?.unsubscribe();
  } catch {
    // forgotten by the server at the latest after its 404/410
  }
}
