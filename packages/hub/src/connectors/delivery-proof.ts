import { hmacHex, timingSafeEqual } from "@xmatrix/protocol";
import type { ConnectorDelivery, ConnectorDeliveryResult } from "./provider";
import { lowerHeader, parseJsonObject } from "./event-format";

/*
 * How a sender proves a webhook delivery is its own. Providers differ only in
 * data: the header that carries the proof, whether it echoes a shared token or
 * an HMAC of what was sent, the signature's prefix (several comma-separated
 * signatures are accepted, as during secret rotation), and whether a timestamp
 * was signed with the body. One check reads that data; nothing else in the Hub
 * compares a webhook secret itself.
 */

const MAX_SKEW_SECONDS = 300;

export type DeliveryProof =
  | { header: string; token: true; bearer?: true }
  | {
    header: string;
    hash?: "SHA-1" | "SHA-256";
    prefix?: string;
    /** Where the signed Unix timestamp is read; one more than five minutes off is a replay. */
    timestamp?: (headers: Headers) => string;
    /** What the sender signed; the raw body unless it also signs the timestamp. */
    signed?: (body: string, timestamp: string) => string;
  };

export const GITHUB_SIGNATURE: DeliveryProof = { header: "x-hub-signature-256", prefix: "sha256=" };

export const TELEGRAM_SECRET_TOKEN: DeliveryProof = { header: "x-telegram-bot-api-secret-token", token: true };

export const STRIPE_SIGNATURE: DeliveryProof = {
  header: "stripe-signature",
  prefix: "v1=",
  timestamp: (headers) => lowerHeader(headers, "stripe-signature").split(",")
    .map((part) => part.trim()).find((part) => part.startsWith("t="))?.slice(2) ?? "",
  signed: (body, timestamp) => `${timestamp}.${body}`,
};

export async function deliveryProven(proof: DeliveryProof, headers: Headers, body: string, secret: string | undefined,
  now: number = Date.now()): Promise<boolean> {
  const received = lowerHeader(headers, proof.header);
  if (!secret || !received) return false;
  if ("token" in proof) return timingSafeEqual(received, proof.bearer ? `Bearer ${secret}` : secret);
  const timestamp = proof.timestamp?.(headers) ?? "";
  if (proof.timestamp && !(Number.isSafeInteger(Number(timestamp)) && timestamp &&
    Math.abs(now / 1_000 - Number(timestamp)) <= MAX_SKEW_SECONDS)) return false;
  const expected = await hmacHex(proof.hash ?? "SHA-256", secret, proof.signed?.(body, timestamp) ?? body);
  const prefix = proof.prefix ?? "";
  return received.split(",").map((part) => part.trim().toLowerCase())
    .some((part) => part.startsWith(prefix) && timingSafeEqual(part.slice(prefix.length), expected));
}

/** Verify the provider's proof before decoding or normalizing its untrusted payload. */
export function createSignedJsonReceiver(options: {
  name: string;
  secretField: string;
  /** Data for `deliveryProven`, or a provider's own check when its scheme is not an HMAC or token header. */
  proof: DeliveryProof | ((delivery: ConnectorDelivery, secret: string | undefined) => Promise<boolean>);
}, normalize: (delivery: ConnectorDelivery, payload: Record<string, unknown>, now: number) =>
  ConnectorDeliveryResult | Promise<ConnectorDeliveryResult>) {
  const { name, secretField, proof } = options;
  return async (delivery: ConnectorDelivery, now: number = Date.now()): Promise<ConnectorDeliveryResult> => {
    const secret = delivery.credentials[secretField];
    const proven = typeof proof === "function"
      ? await proof(delivery, secret)
      : await deliveryProven(proof, delivery.headers, delivery.rawBody, secret, now);
    if (!proven) {
      return { ok: false, status: 401, error: `Invalid ${name} ${typeof proof !== "function" && "token" in proof ? "token" : "signature"}` };
    }
    const payload = parseJsonObject(delivery.rawBody);
    if (!payload) return { ok: false, status: 400, error: `${name} body must be JSON` };
    return normalize(delivery, payload, now);
  };
}
