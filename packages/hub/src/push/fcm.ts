import { isPlainRecord, SettledCache } from "@xmatrix/protocol";
import { base64UrlEncodeValue } from "../relay-v2-primitives";
import { pemPrivateKeyBytes } from "./apns";
import { pushResponseJson, withPushBudget, withPushDelivery } from "./delivery";
import { pushResponseOutcome, type PushOutcome } from "./outcome";

/** The Firebase service account the Hub sends as: the fields of its JSON key that sending needs. */
export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** The account's RSA private key, PEM. */
  privateKey: string;
}

const encoder = new TextEncoder();
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/** Access tokens per service account and key, reused until shortly before Google expires them. */
const tokens = new SettledCache<string, string>(8);

/**
 * One push batch's token grants still in flight, keyed like `tokens`: the
 * batch's sends share one grant. It belongs to that batch alone, since a
 * Worker request cannot await another request's unsettled grant (HUB-DJ).
 */
export type FcmGrants = Map<string, Promise<string>>;

async function accessToken(config: FcmConfig, nowSeconds: number, request: typeof fetch, signal: AbortSignal,
  grants: FcmGrants): Promise<string> {
  const key = `${config.clientEmail}\u0000${config.privateKey}`;
  const kept = tokens.get(key, nowSeconds * 1000);
  if (kept) return kept;
  let grant = grants.get(key);
  if (!grant) {
    grant = withPushBudget(refreshSignal => grantToken(config, nowSeconds, request, refreshSignal), signal)
      .then(({ token, expiresAt }) => { tokens.set(key, token, expiresAt); return token; })
      .finally(() => grants.delete(key));
    grants.set(key, grant);
  }
  return grant;
}

/** A new grant and when to stop using it (epoch ms), a minute before Google expires it. A grant
 * whose delivery was cancelled throws, so a late reply never replaces a newer token. */
async function grantToken(config: FcmConfig, nowSeconds: number, request: typeof fetch,
  signal: AbortSignal): Promise<{ token: string; expiresAt: number }> {
  const key = await crypto.subtle.importKey("pkcs8", pemPrivateKeyBytes(config.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const unsigned = `${base64UrlEncodeValue(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${
    base64UrlEncodeValue(JSON.stringify({ iss: config.clientEmail, scope: SCOPE, aud: TOKEN_URL,
      iat: nowSeconds, exp: nowSeconds + 3600 }))}`;
  const signed = encoder.encode(unsigned);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key,
    signed.buffer.slice(signed.byteOffset, signed.byteOffset + signed.byteLength) as ArrayBuffer);
  const response = await request(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64UrlEncodeValue(signature)}` }).toString(),
  });
  const parsed = response.ok ? await pushResponseJson(response, signal).catch(() => ({})) : {};
  signal.throwIfAborted();
  const granted = isPlainRecord(parsed) ? parsed : {};
  if (typeof granted.access_token !== "string") throw new Error(`FCM token request failed (${response.status})`);
  const lifetime = typeof granted.expires_in === "number" ? granted.expires_in : 3600;
  return { token: granted.access_token, expiresAt: (nowSeconds + lifetime - 60) * 1000 };
}

/** Send one notification to one Android device. `collapseKey` replaces an undelivered earlier one of the same conversation. */
export async function sendFcm(input: {
  config: FcmConfig; deviceToken: string; title: string; body: string;
  data: Record<string, string>; collapseKey: string; fetch?: typeof fetch; nowSeconds?: number; signal?: AbortSignal;
  /** The batch's grants in flight, shared by its sends; a lone send has its own. */
  grants?: FcmGrants;
}): Promise<PushOutcome> {
  return withPushDelivery(input.fetch ?? fetch, async (request, signal) => {
    const token = await accessToken(input.config, input.nowSeconds ?? Math.floor(Date.now() / 1000), request, signal,
      input.grants ?? new Map());
    const response = await request(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(input.config.projectId)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: {
          token: input.deviceToken,
          notification: { title: input.title, body: input.body },
          data: input.data,
          android: { collapse_key: input.collapseKey, priority: "HIGH", notification: { tag: input.collapseKey } },
        } }),
      });
    return pushResponseOutcome("fcm", response, signal);
  }, input.signal);
}
