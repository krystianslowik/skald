import { describe, expect, it } from "bun:test";
import { b64url, buildPushRequest, checkKeys, encryptPayload, fromB64url, generateVapidKeys, loadVapidKeys, vapidAuthorization } from "../src/webpush";
import { decryptPush, newBrowserKeys } from "./pushhelpers";

/** A key pair from its private scalar and public point (RFC 8291 gives both). */
async function pair(d: string, pub: string): Promise<CryptoKeyPair> {
  const raw = fromB64url(pub);
  const jwk = { kty: "EC", crv: "P-256", d, x: b64url(raw.slice(1, 33)), y: b64url(raw.slice(33, 65)), ext: true };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { privateKey, publicKey };
}

describe("encryptPayload", () => {
  it("matches the example of RFC 8291, appendix A", async () => {
    const server = await pair("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    const body = await encryptPayload(
      new TextEncoder().encode("When I grow up, I want to be a watermelon"),
      { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
      { salt: fromB64url("DGv6ra1nlYgDCS1FRnbzlw"), serverKeys: server },
    );
    expect(b64url(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("round-trips through a browser's keys, with a fresh salt and key each time", async () => {
    const ua = await newBrowserKeys();
    const a = await encryptPayload(new TextEncoder().encode('{"title":"Ragnar"}'), ua.keys);
    const b = await encryptPayload(new TextEncoder().encode('{"title":"Ragnar"}'), ua.keys);
    expect(b64url(a.slice(0, 16))).not.toBe(b64url(b.slice(0, 16)));
    expect(await decryptPush(a, ua)).toBe('{"title":"Ragnar"}');
  });

  it("refuses payloads that do not fit one record, and malformed keys", async () => {
    const ua = await newBrowserKeys();
    await expect(encryptPayload(new Uint8Array(4000), ua.keys)).rejects.toThrow("too large");
    await expect(checkKeys({ p256dh: "AAAA", auth: ua.keys.auth })).rejects.toThrow();
    await expect(checkKeys({ p256dh: ua.keys.p256dh, auth: "AAAA" })).rejects.toThrow("16 bytes");
    await checkKeys(ua.keys);
  });
});

describe("VAPID", () => {
  it("signs a JWT for the endpoint's origin that the public key verifies", async () => {
    const keys = await generateVapidKeys();
    const auth = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "mailto:jarl@example.com", Date.parse("2026-10-19T12:00:00Z"));
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)!;
    expect(m[4]).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(m[1]!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(Buffer.from(m[2]!, "base64url").toString());
    expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: Date.parse("2026-10-19T12:00:00Z") / 1000 + 12 * 3600, sub: "mailto:jarl@example.com" });
    const pub = await crypto.subtle.importKey("raw", fromB64url(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(m[3]!), new TextEncoder().encode(`${m[1]}.${m[2]}`));
    expect(ok).toBe(true);
  });

  it("loads stored keys back and rejects broken ones", async () => {
    const keys = await generateVapidKeys();
    expect(await loadVapidKeys(JSON.stringify(keys))).toEqual(keys);
    expect(await loadVapidKeys(null)).toBeNull();
    expect(await loadVapidKeys("{")).toBeNull();
    expect(await loadVapidKeys(JSON.stringify({ publicKey: keys.publicKey, privateJwk: { kty: "EC" } }))).toBeNull();
  });

  it("builds the push request with the aes128gcm headers and a clean topic", async () => {
    const ua = await newBrowserKeys();
    const keys = await generateVapidKeys();
    const { url, init } = await buildPushRequest({ endpoint: "https://web.push.apple.com/abc", keys: ua.keys, payload: "hi", topic: "join.fire!", ttl: 60, urgency: "high" }, keys, "https://skald.example", 0);
    const h = init.headers as Record<string, string>;
    expect(url).toBe("https://web.push.apple.com/abc");
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(h.TTL).toBe("60");
    expect(h.Urgency).toBe("high");
    expect(h.Topic).toBe("joinfire");
    expect(h.Authorization).toStartWith("vapid t=");
    expect(await decryptPush(init.body as Uint8Array, ua)).toBe("hi");
  });
});
