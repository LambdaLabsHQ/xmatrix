import { base64DecodeBytes, base64UrlEncodeValue } from "../relay-v2-primitives";

/** The Hub's identity with Apple's push service: a token-signing key and the app it speaks for. */
export interface ApnsConfig {
  /** The `.p8` signing key, PEM. */
  keyP8: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id. */
  topic: string;
}

export type PushOutcome = "sent" | "gone" | "failed";

const encoder = new TextEncoder();

/** The PKCS#8 bytes inside a PEM private key. */
export function pemPrivateKeyBytes(pem: string): ArrayBuffer {
  const bytes = base64DecodeBytes(pem.replace(/-----[A-Z ]+-----/gu, "").replace(/\s+/gu, ""));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Apple accepts a provider token for an hour; it is signed anew for each send, which is cheap and never stale. */
export async function apnsAuthorization(config: ApnsConfig, nowSeconds: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemPrivateKeyBytes(config.keyP8),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const unsigned = `${base64UrlEncodeValue(JSON.stringify({ alg: "ES256", kid: config.keyId }))}.${
    base64UrlEncodeValue(JSON.stringify({ iss: config.teamId, iat: nowSeconds }))}`;
  const signed = encoder.encode(unsigned);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key,
    signed.buffer.slice(signed.byteOffset, signed.byteOffset + signed.byteLength) as ArrayBuffer);
  return `bearer ${unsigned}.${base64UrlEncodeValue(signature)}`;
}

/** Send one alert to one iPhone. `collapseId` replaces an undelivered earlier alert of the same conversation. */
export async function sendApns(input: {
  config: ApnsConfig; deviceToken: string; title: string; body: string;
  data: Record<string, string>; collapseId: string; fetch?: typeof fetch; nowSeconds?: number;
}): Promise<PushOutcome> {
  const response = await (input.fetch ?? fetch)(`https://api.push.apple.com/3/device/${input.deviceToken}`, {
    method: "POST",
    headers: {
      authorization: await apnsAuthorization(input.config, input.nowSeconds ?? Math.floor(Date.now() / 1000)),
      "apns-topic": input.config.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": input.collapseId,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: { alert: { title: input.title, body: input.body }, sound: "default", "thread-id": input.collapseId },
      ...input.data,
    }),
  });
  if (response.ok) return "sent";
  if (response.status === 410) return "gone";
  const reason = response.status === 400
    ? (await response.json().catch(() => ({})) as { reason?: unknown }).reason : undefined;
  return reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic" ? "gone" : "failed";
}
