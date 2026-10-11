import type { PushPlatform } from "@xmatrix/db";
import { isPlainRecord, readBoundedStream } from "@xmatrix/protocol";

/** Only `gone` authorizes removing a device; other failures preserve its registration. */
export type PushOutcome = "sent" | "gone" | "failed";

// A status is evidence only in its provider's protocol. Phone services must
// also name token retirement; a wrong project/topic is a sending failure.
const TERMINAL: Record<PushPlatform, Record<number, readonly string[] | null>> = {
  fcm: { 404: ["UNREGISTERED"] },
  apns: { 410: ["ExpiredToken", "Unregistered"] },
  webpush: { 404: null, 410: null },
};
const FCM_ERROR_TYPE = "type.googleapis.com/google.firebase.fcm.v1.FcmError";

/** Decode provider evidence once, with unknown or malformed replies failing closed. */
export async function pushResponseOutcome(platform: PushPlatform, response: Response): Promise<PushOutcome> {
  if (response.ok) return "sent";
  const allowed = TERMINAL[platform][response.status];
  if (allowed === undefined) return "failed";
  if (allowed === null) return "gone";
  try {
    const bytes = await readBoundedStream(response.body, 16_384, () => new Error("Push error response too large"));
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isPlainRecord(body)) return "failed";
    const error = isPlainRecord(body.error) ? body.error : {};
    const codes = platform === "apns" ? [body.reason]
      : Array.isArray(error.details) ? error.details
        .filter((detail): detail is Record<string, unknown> => isPlainRecord(detail) && detail["@type"] === FCM_ERROR_TYPE)
        .map(detail => detail.errorCode) : [];
    return codes.length > 0 && codes.every(code => typeof code === "string" && allowed.includes(code)) ? "gone" : "failed";
  } catch {
    return "failed";
  }
}
