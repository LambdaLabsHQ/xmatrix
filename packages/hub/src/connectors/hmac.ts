import { hmacHex, timingSafeEqual } from "@xmatrix/protocol";
import type { ConnectorDelivery, ConnectorDeliveryResult } from "./provider";
import { lowerHeader, parseJsonObject } from "./event-format";

/** Whether `received` (hex, any case, optional prefix stripped by the caller) is the HMAC of the body. */
export async function hmacMatches(hash: "SHA-1" | "SHA-256", secret: string | undefined, message: string,
  received: string): Promise<boolean> {
  if (!secret || !received) return false;
  return timingSafeEqual(received.trim().toLowerCase(), await hmacHex(hash, secret, message));
}

/** Verify the provider's signature before decoding or normalizing its untrusted payload. */
export function createSignedJsonReceiver(options: {
  name: string;
  secretField: string;
  signatureHeader: string;
  stripSha256Prefix?: boolean;
}, normalize: (delivery: ConnectorDelivery, payload: Record<string, unknown>, now: number) => ConnectorDeliveryResult) {
  return async (delivery: ConnectorDelivery, now: number = Date.now()): Promise<ConnectorDeliveryResult> => {
    const received = lowerHeader(delivery.headers, options.signatureHeader);
    const signature = options.stripSha256Prefix ? received.replace(/^sha256=/iu, "") : received;
    if (!await hmacMatches("SHA-256", delivery.credentials[options.secretField], delivery.rawBody, signature)) {
      return { ok: false, status: 401, error: `Invalid ${options.name} signature` };
    }
    const payload = parseJsonObject(delivery.rawBody);
    if (!payload) return { ok: false, status: 400, error: `${options.name} body must be JSON` };
    return normalize(delivery, payload, now);
  };
}
