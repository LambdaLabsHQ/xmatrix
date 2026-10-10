import { base64UrlEncodeValue } from "../relay-v2-primitives";
import { pemPrivateKeyBytes, type PushOutcome } from "./apns";

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
const tokens = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(config: FcmConfig, nowSeconds: number, request: typeof fetch): Promise<string> {
  const cached = tokens.get(config.clientEmail);
  if (cached && cached.expiresAt - 60 > nowSeconds) return cached.token;
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
  const granted = response.ok ? await response.json().catch(() => ({})) as { access_token?: unknown; expires_in?: unknown } : {};
  if (typeof granted.access_token !== "string") throw new Error(`FCM token request failed (${response.status})`);
  const lifetime = typeof granted.expires_in === "number" ? granted.expires_in : 3600;
  tokens.set(config.clientEmail, { token: granted.access_token, expiresAt: nowSeconds + lifetime });
  return granted.access_token;
}

/** Send one notification to one Android device. `collapseKey` replaces an undelivered earlier one of the same conversation. */
export async function sendFcm(input: {
  config: FcmConfig; deviceToken: string; title: string; body: string;
  data: Record<string, string>; collapseKey: string; fetch?: typeof fetch; nowSeconds?: number;
}): Promise<PushOutcome> {
  const request = input.fetch ?? fetch;
  const token = await accessToken(input.config, input.nowSeconds ?? Math.floor(Date.now() / 1000), request);
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
  if (response.ok) return "sent";
  // Google answers 404 UNREGISTERED once the app is uninstalled. A 400 is not read as that: it is
  // also what a request the Hub built wrongly gets, and that must not cost anyone their devices.
  return response.status === 404 ? "gone" : "failed";
}
