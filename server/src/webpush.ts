// Web Push on WebCrypto alone: message encryption (RFC 8291, aes128gcm from
// RFC 8188) and VAPID (RFC 8292). No dependency: Bun's crypto.subtle has
// ECDH, ECDSA, HKDF and AES-GCM on P-256, which is all the protocol needs.

const subtle = crypto.subtle;
/** Bytes on a plain ArrayBuffer, as WebCrypto takes them. */
type Bytes = Uint8Array<ArrayBuffer>;
type Jwk = Parameters<typeof subtle.importKey>[1] & { kty?: string };
const enc = new TextEncoder();

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
}

/** Decodes base64url (or plain base64, padded or not); throws on anything else. */
export function fromB64url(text: string): Bytes {
  if (!/^[A-Za-z0-9_+/-]*={0,2}$/.test(text)) throw new Error("not base64url");
  return new Uint8Array(Buffer.from(text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "base64url"));
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** An uncompressed P-256 point (65 bytes, 0x04 || x || y) as a public key. */
function importPublic(raw: Bytes, alg: "ECDH" | "ECDSA"): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("not an uncompressed P-256 key");
  return subtle.importKey("raw", raw, { name: alg, namedCurve: "P-256" }, true, alg === "ECDH" ? [] : ["verify"]);
}

/** A browser subscription's keys: `p256dh` (65-byte point) and `auth` (16-byte secret), base64url. */
export interface SubscriptionKeys {
  p256dh: string;
  auth: string;
}

/** Throws unless the keys have the shapes RFC 8291 requires. */
export async function checkKeys(keys: SubscriptionKeys): Promise<void> {
  await importPublic(fromB64url(keys.p256dh), "ECDH");
  if (fromB64url(keys.auth).length !== 16) throw new Error("auth secret must be 16 bytes");
}

/** Records are one per message; the payload must fit one 4096-byte record. */
const RECORD_SIZE = 4096;
/** 16 tag bytes, 1 delimiter byte; RFC 8291 caps the plaintext at 3993 bytes. */
export const PAYLOAD_MAX = 3993;

/**
 * Encrypts one push message for a subscription (RFC 8291). `salt` and
 * `serverKeys` are fresh per message; tests pass fixed ones to check the
 * RFC's example.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  keys: SubscriptionKeys,
  fixed: { salt?: Bytes; serverKeys?: CryptoKeyPair } = {},
): Promise<Bytes> {
  if (plaintext.length > PAYLOAD_MAX) throw new Error("payload too large");
  const uaPublicRaw = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  const uaPublic = await importPublic(uaPublicRaw, "ECDH");
  const server = fixed.serverKeys ?? ((await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const serverPublicRaw = new Uint8Array(await subtle.exportKey("raw", server.publicKey));
  const salt = fixed.salt ?? crypto.getRandomValues(new Uint8Array(16));

  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: uaPublic }, server.privateKey, 256));
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublicRaw, serverPublicRaw);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record, so it is the last one: the 0x02 delimiter, no padding.
  const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + serverPublicRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = serverPublicRaw.length;
  header.set(serverPublicRaw, 21);
  return concat(header, sealed);
}

/** The panel's VAPID key pair, kept as JWKs in the panel database. */
export interface VapidKeys {
  /** The public key as the browser's applicationServerKey wants it: a raw point, base64url. */
  publicKey: string;
  privateJwk: Jwk;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { publicKey: b64url(await subtle.exportKey("raw", pair.publicKey)), privateJwk: (await subtle.exportKey("jwk", pair.privateKey)) as Jwk };
}

/** Reads stored keys; null when missing or unusable (then new ones are made). */
export async function loadVapidKeys(raw: string | null): Promise<VapidKeys | null> {
  if (!raw) return null;
  try {
    const k = JSON.parse(raw) as VapidKeys;
    if (typeof k.publicKey !== "string" || !k.privateJwk || k.privateJwk.kty !== "EC") return null;
    await subtle.importKey("jwk", k.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    await importPublic(fromB64url(k.publicKey), "ECDSA");
    return k;
  } catch {
    return null;
  }
}

/** Apple refuses tokens that live longer than a day; 12 h leaves room for clock skew. */
const VAPID_TTL_S = 12 * 60 * 60;

/**
 * The `Authorization` header for one push service (RFC 8292): a JWT for the
 * endpoint's origin, signed ES256 with the VAPID key. WebCrypto's ECDSA
 * signature is already the raw r || s that JWS wants.
 */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, contact: string, nowMs: number): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + VAPID_TTL_S, sub: contact })));
  const key = await subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`;
}

export interface PushRequest {
  endpoint: string;
  keys: SubscriptionKeys;
  payload: string;
  /** Replaces an undelivered message with the same topic at the push service (max 32 base64url characters). */
  topic?: string;
  /** Seconds the push service keeps the message for a device that is offline. */
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
}

/** Signed tokens kept per key, push service and contact until an hour before they expire. */
const tokens = new Map<string, { header: string; until: number }>();

async function cachedAuthorization(endpoint: string, keys: VapidKeys, contact: string, nowMs: number): Promise<string> {
  const id = `${keys.publicKey}|${new URL(endpoint).origin}|${contact}`;
  const hit = tokens.get(id);
  if (hit && nowMs < hit.until) return hit.header;
  const header = await vapidAuthorization(endpoint, keys, contact, nowMs);
  if (tokens.size > 64) tokens.clear();
  tokens.set(id, { header, until: nowMs + (VAPID_TTL_S - 3600) * 1000 });
  return header;
}

/** The HTTP request a push service expects for one message. */
export async function buildPushRequest(r: PushRequest, vapid: VapidKeys, contact: string, nowMs: number): Promise<{ url: string; init: RequestInit }> {
  const body = await encryptPayload(enc.encode(r.payload), r.keys);
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    TTL: String(r.ttl ?? 6 * 60 * 60),
    Urgency: r.urgency ?? "normal",
    Authorization: await cachedAuthorization(r.endpoint, vapid, contact, nowMs),
  };
  if (r.topic) headers.Topic = r.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return { url: r.endpoint, init: { method: "POST", headers, body } };
}
