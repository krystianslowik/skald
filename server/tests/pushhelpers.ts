// The browser's side of Web Push, for tests: a subscription's keys and the
// decryption a user agent does on receipt (RFC 8291).
import { b64url, type SubscriptionKeys } from "../src/webpush";

type Bytes = Uint8Array<ArrayBuffer>;

export interface BrowserKeys {
  keys: SubscriptionKeys;
  pair: CryptoKeyPair;
  publicRaw: Bytes;
  auth: Bytes;
}

export async function newBrowserKeys(): Promise<BrowserKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { keys: { p256dh: b64url(publicRaw), auth: b64url(auth) }, pair, publicRaw, auth };
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export async function decryptPush(input: Uint8Array, ua: BrowserKeys): Promise<string> {
  const body = new Uint8Array(input);
  const salt = body.slice(0, 16);
  const idLen = body[20]!;
  const serverRaw = body.slice(21, 21 + idLen);
  const sealed = body.slice(21 + idLen);
  const serverPub = await crypto.subtle.importKey("raw", serverRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: serverPub }, ua.pair.privateKey, 256));
  const enc = new TextEncoder();
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...ua.publicRaw, ...serverRaw]);
  const ikm = await hkdf(ua.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed));
  // Strip the padding and the 0x02 last-record delimiter.
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error("no last-record delimiter");
  return new TextDecoder().decode(plain.slice(0, end));
}
