// Phone push wire types. Kept free of Bun/Node imports: the web package
// compiles this file through its `@server/*` path alias.
import type { Locale } from "./types";

/** What a device can ask to be told about. */
export const PUSH_KINDS = ["join", "server", "boss", "raid", "death", "failure", "update"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/** Switched on for a device that just turned notifications on. */
export const PUSH_DEFAULT_KINDS: readonly PushKind[] = ["join", "server", "boss", "raid"];

/** Quiet hours as "HH:MM" in the device's time zone; `from` after `to` runs past midnight. */
export interface PushQuiet {
  from: string;
  to: string;
}

/** One device's choice, kept by the server with its subscription. */
export interface PushPrefs {
  kinds: PushKind[];
  /** A friend joining is news only when nobody was at the fire before. */
  firstJoinOnly: boolean;
  quiet: PushQuiet | null;
  /** IANA zone the quiet hours are read in. */
  timeZone: string;
  locale: Locale;
}

/** The browser's PushSubscription.toJSON(), the parts the server uses. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** GET /api/push. */
export interface PushInfo {
  ok: true;
  /** VAPID public key, base64url: the browser's applicationServerKey. */
  publicKey: string;
  kinds: PushKind[];
}

/** What the service worker gets in each push, as JSON. */
export interface PushPayload {
  title: string;
  body: string;
  /** One notification per tag on the device: a newer one replaces it. */
  tag: string;
  /** Where a tap opens the panel. */
  url: string;
}

export const QUIET_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
