import { isPlainRecord } from "@xmatrix/protocol";
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

/** One access token per service account, reused until shortly before Google expires it. */
type TokenState = { privateKey: string; token?: string; expiresAt: number; pending?: Promise<string> };
const tokens = new Map<string, TokenState>();

async function accessToken(config: FcmConfig, nowSeconds: number, request: typeof fetch, signal: AbortSignal): Promise<string> {
  let state = tokens.get(config.clientEmail);
  if (!state || state.privateKey !== config.privateKey) {
    state = { privateKey: config.privateKey, expiresAt: 0 };
    tokens.set(config.clientEmail, state);
  }
  if (state.token && state.expiresAt - 60 > nowSeconds) return state.token;
  if (state.pending) return state.pending;
  state.pending = withPushBudget(refreshSignal => grantToken(config, nowSeconds, request, refreshSignal, state), signal);
  try { return await state.pending; } finally { state.pending = undefined; }
}

async function grantToken(config: FcmConfig, nowSeconds: number, request: typeof fetch, signal: AbortSignal,
  state: TokenState): Promise<string> {
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
  state.token = granted.access_token;
  state.expiresAt = nowSeconds + lifetime;
  return granted.access_token;
}

/** Send one notification to one Android device. `collapseKey` replaces an undelivered earlier one of the same conversation. */
export async function sendFcm(input: {
  config: FcmConfig; deviceToken: string; title: string; body: string;
  data: Record<string, string>; collapseKey: string; fetch?: typeof fetch; nowSeconds?: number; signal?: AbortSignal;
}): Promise<PushOutcome> {
  return withPushDelivery(input.fetch ?? fetch, async (request, signal) => {
    const token = await accessToken(input.config, input.nowSeconds ?? Math.floor(Date.now() / 1000), request, signal);
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
