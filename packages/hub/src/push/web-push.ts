import { concatenateBytes } from "@xmatrix/protocol";

import { base64UrlDecodeBytes, base64UrlEncodeBytes, base64UrlEncodeValue } from "../relay-v2-primitives";

/** The Hub's own Web Push identity (RFC 8292): browsers accept a push only from the key they subscribed to. */
export interface VapidKeys {
  /** The uncompressed P-256 public key, base64url (65 bytes): what a browser subscribes with. */
  publicKey: string;
  /** Its private scalar, base64url (32 bytes). */
  privateKey: string;
  /** How a push service reaches the sender: a `mailto:` or `https:` URL. */
  subject: string;
}

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** `sent`, or `gone` when the push service says the subscription no longer exists. */
export type WebPushOutcome = "sent" | "gone" | "failed";

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;
/** A push service drops what was not delivered within a day; a day-old "needs you" is found in the list. */
const TTL_SECONDS = 24 * 60 * 60;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** RFC 8291 `aes128gcm`: only the subscribed browser can read what the push service relays. */
export async function encryptWebPush(subscription: WebPushSubscription, plaintext: Uint8Array): Promise<Uint8Array> {
  const clientPublic = base64UrlDecodeBytes(subscription.keys.p256dh);
  const authSecret = base64UrlDecodeBytes(subscription.keys.auth);
  if (clientPublic.length !== 65 || clientPublic[0] !== 4 || authSecret.length < 16) throw new TypeError("invalid subscription keys");
  if (plaintext.length > RECORD_SIZE - 16 - 1 - 86) throw new TypeError("push payload too large");
  const server = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", server.publicKey) as ArrayBuffer);
  const clientKey = await crypto.subtle.importKey("raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, server.privateKey, 256));
  const ikm = await hkdf(authSecret, shared,
    concatenateBytes([encoder.encode("WebPush: info\0"), clientPublic, serverPublic]), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  // One record: the payload, then the delimiter that marks the last record.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key,
    concatenateBytes([plaintext, new Uint8Array([2])])));
  const header = new Uint8Array(16 + 4 + 1 + serverPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = serverPublic.length;
  header.set(serverPublic, 21);
  return concatenateBytes([header, sealed]);
}

/** RFC 8292: a short-lived token, signed with the Hub's key, naming the push service it is for. */
export async function vapidAuthorization(vapid: VapidKeys, endpoint: string, nowSeconds: number): Promise<string> {
  const publicKey = base64UrlDecodeBytes(vapid.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new TypeError("invalid VAPID public key");
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: vapid.privateKey,
    x: base64UrlEncodeBytes(publicKey.slice(1, 33)), y: base64UrlEncodeBytes(publicKey.slice(33, 65)),
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const unsigned = `${base64UrlEncodeValue(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${
    base64UrlEncodeValue(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 60 * 60, sub: vapid.subject }))}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned));
  return `vapid t=${unsigned}.${base64UrlEncodeValue(signature)}, k=${vapid.publicKey}`;
}

/**
 * Send one notification to one browser. `topic` replaces an undelivered
 * earlier push of the same conversation, so a sleeping laptop wakes to one.
 */
export async function sendWebPush(input: {
  vapid: VapidKeys; subscription: WebPushSubscription; payload: string; topic?: string;
  fetch?: typeof fetch; nowSeconds?: number;
}): Promise<WebPushOutcome> {
  const body = await encryptWebPush(input.subscription, encoder.encode(input.payload));
  const response = await (input.fetch ?? fetch)(input.subscription.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuthorization(input.vapid, input.subscription.endpoint,
        input.nowSeconds ?? Math.floor(Date.now() / 1000)),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(TTL_SECONDS),
      urgency: "high",
      ...(input.topic ? { topic: input.topic } : {}),
    },
    body,
  });
  if (response.ok) return "sent";
  return response.status === 404 || response.status === 410 ? "gone" : "failed";
}
