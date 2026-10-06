import { utf8ByteLength } from "@xmatrix/protocol";
import { createLocalJWKSet, decodeProtectedHeader, importPKCS8, jwtVerify, SignJWT, type JSONWebKeySet } from "jose";
import { isBoundedTrimmedUtf8String } from "../relay-v2-primitives";
import { providerJson, ProviderRequestError } from "./http";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_KEYS = "https://www.googleapis.com/oauth2/v3/certs";
const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const ACCOUNT_EMAIL = /^[A-Za-z0-9_.-]{1,128}@[a-z0-9-]{4,63}\.iam\.gserviceaccount\.com$/u;
const SPACE_NAME = /^spaces\/[A-Za-z0-9_-]{1,128}$/u;
const MAX_CONFIG_BYTES = 16_384;

interface ChatServiceAccount {
  email: string;
  keyId: string;
  privateKey: string;
}

function configurationError(): never {
  throw new ProviderRequestError(503, "Google Chat application authentication is not configured");
}

/** Parse only Google's service-account credential shape; never follow its URL fields. */
function serviceAccount(value: string): ChatServiceAccount {
  if (typeof value !== "string" || utf8ByteLength(value) > MAX_CONFIG_BYTES) configurationError();
  let parsed: Record<string, unknown>;
  try {
    const object: unknown = JSON.parse(value);
    if (!object || typeof object !== "object" || Array.isArray(object)) configurationError();
    parsed = object as Record<string, unknown>;
  } catch { return configurationError(); }
  const { type, project_id: project, client_email: email, private_key_id: keyId, private_key: key } = parsed;
  if (type !== "service_account" || typeof project !== "string" || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project) ||
      typeof email !== "string" || !ACCOUNT_EMAIL.test(email) || !email.endsWith(`@${project}.iam.gserviceaccount.com`) ||
      typeof keyId !== "string" || !/^[a-f0-9]{40}$/u.test(keyId) ||
      typeof key !== "string" || key.length > 8_192 ||
      !/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----\r?\n?$/u.test(key) ||
      parsed.token_uri !== TOKEN_ENDPOINT ||
      parsed.universe_domain !== undefined && parsed.universe_domain !== "googleapis.com") configurationError();
  return { email, keyId, privateKey: key };
}

/** The app acts only as itself. No user subject, delegated scope, or provider URL is accepted. */
async function appHeaders(account: ChatServiceAccount): Promise<Headers> {
  let assertion: string;
  try {
    const key = await importPKCS8(account.privateKey, "RS256");
    assertion = await new SignJWT({ scope: CHAT_SCOPE })
      .setProtectedHeader({ alg: "RS256", kid: account.keyId })
      .setIssuer(account.email).setAudience(TOKEN_ENDPOINT).setIssuedAt().setExpirationTime("1h").sign(key);
  } catch { return configurationError(); }
  let payload: Record<string, unknown>;
  try {
    payload = await providerJson(TOKEN_ENDPOINT, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  } catch { throw new ProviderRequestError(503, "Google Chat app authentication could not be confirmed"); }
  if (!isBoundedTrimmedUtf8String(payload.access_token, 4_096) || /\s/u.test(payload.access_token) ||
      payload.token_type !== "Bearer" || typeof payload.expires_in !== "number" ||
      !Number.isSafeInteger(payload.expires_in) || payload.expires_in <= 0 || payload.expires_in > 3_600 ||
      payload.scope !== undefined && payload.scope !== CHAT_SCOPE) {
    throw new ProviderRequestError(503, "Google Chat app authentication could not be confirmed");
  }
  return new Headers({ authorization: `Bearer ${payload.access_token}` });
}

/** Server-only client. Membership and xMatrix authorization must be checked by the caller. */
export function googleChatAppClient(serviceAccountJson: string) {
  const account = serviceAccount(serviceAccountJson);
  const spaceUrl = (name: string) => {
    if (!SPACE_NAME.test(name)) throw new ProviderRequestError(400, "Name an explicit Google Chat space");
    return `https://chat.googleapis.com/v1/${name}`;
  };
  return {
    serviceAccountEmail: account.email,
    async getSpace(name: string): Promise<{ name: string; displayName?: string }> {
      const url = spaceUrl(name);
      const response = await providerJson(url, { headers: await appHeaders(account) });
      if (response.name !== name || !["SPACE", "GROUP_CHAT", "DIRECT_MESSAGE"].includes(String(response.spaceType))) {
        throw new ProviderRequestError(502, "Google Chat did not confirm the selected space");
      }
      return { name, ...(typeof response.displayName === "string" ? { displayName: response.displayName.slice(0, 250) } : {}) };
    },
    async postMessage(name: string, text: string, beforeWrite?: () => Promise<void>): Promise<{ name: string }> {
      const url = `${spaceUrl(name)}/messages`;
      if (typeof text !== "string" || !text.trim() || utf8ByteLength(text) > 4_000 ||
          Array.from(text).some(character => {
            const code = character.charCodeAt(0);
            return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
          })) {
        throw new ProviderRequestError(400, "Write a Google Chat message up to 4000 bytes");
      }
      // One request only. An ambiguous provider receipt is not a reason to replay a write.
      const headers = await appHeaders(account);
      await beforeWrite?.();
      const response = await providerJson(url, { method: "POST", headers, json: { text } });
      if (typeof response.name !== "string" || !response.name.startsWith(`${name}/messages/`) ||
          !/^[A-Za-z0-9_.-]{1,128}$/u.test(response.name.slice(`${name}/messages/`.length))) {
        throw new ProviderRequestError(502, "Google Chat returned no matching message receipt; check the space before retrying");
      }
      return { name: response.name };
    },
  };
}

/** Verify the HTTP add-on's system identity, independently of its outbound app service account. */
export async function verifyGoogleChatAddonRequest(request: Request, input: {
  endpoint: string; systemServiceAccountEmail: string;
}): Promise<void> {
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint); } catch { return configurationError(); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== "/api/connectors/googlechat/events" || !ACCOUNT_EMAIL.test(input.systemServiceAccountEmail)) configurationError();
  // Audience comes from trusted deployment settings, never the incoming Host or payload.
  const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u)?.[1];
  const denied = () => new ProviderRequestError(401, "Google Chat request authentication failed");
  if (!token || token.length > 16_384) throw denied();
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "RS256" || !isBoundedTrimmedUtf8String(header.kid, 128)) throw denied();
  } catch { throw denied(); }
  let keys: Record<string, unknown>;
  try { keys = await providerJson(GOOGLE_KEYS); }
  catch { throw new ProviderRequestError(503, "Google Chat verification keys are unavailable"); }
  if (!Array.isArray(keys.keys) || keys.keys.length === 0 || keys.keys.length > 32) {
    throw new ProviderRequestError(503, "Google Chat verification keys are unavailable");
  }
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet(keys as unknown as JSONWebKeySet), {
      issuer: ["https://accounts.google.com", "accounts.google.com"], audience: input.endpoint,
      algorithms: ["RS256"], maxTokenAge: "1h", clockTolerance: 30,
      requiredClaims: ["iss", "aud", "sub", "exp", "iat", "email", "email_verified"],
    });
    if (payload.aud !== input.endpoint || payload.email !== input.systemServiceAccountEmail || payload.email_verified !== true ||
        !isBoundedTrimmedUtf8String(payload.sub, 128) || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
        payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 3_600) throw denied();
  } catch { throw denied(); }
}
