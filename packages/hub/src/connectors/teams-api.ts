import { MICROSOFT_GUID, teamsReference, teamsServiceUrl, type TeamsAppIdentity, type TeamsConversationReference } from "@xmatrix/db";
import { utf8ByteLength } from "@xmatrix/protocol";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from "jose";
import { providerJson, ProviderRequestError } from "./http";

const METADATA = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const KEYS = "https://login.botframework.com/v1/.well-known/keys";
const ISSUER = "https://api.botframework.com";
const SCOPE = "https://api.botframework.com/.default";

/** Commercial Teams Connector only: no Emulator, skills, delegated Graph or caller-selected JWKS. */
export async function verifyTeamsRequest(request: Request, app: TeamsAppIdentity, serviceUrl: unknown): Promise<void> {
  const denied = () => new ProviderRequestError(401, "Teams request authentication failed");
  const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u)?.[1];
  let kid: string;
  try {
    if (!token || token.length > 16_384 || typeof serviceUrl !== "string") throw denied();
    teamsServiceUrl(serviceUrl);
    const header = decodeProtectedHeader(token);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(header.kid)) throw denied();
    kid = header.kid;
  } catch { throw denied(); }
  let keys: Record<string, unknown>;
  try {
    const signal = AbortSignal.timeout(18_000);
    const metadata = await providerJson(METADATA, { signal });
    if (metadata.issuer !== ISSUER || metadata.jwks_uri !== KEYS ||
        !Array.isArray(metadata.id_token_signing_alg_values_supported) || !metadata.id_token_signing_alg_values_supported.includes("RS256")) throw new Error();
    keys = await providerJson(KEYS, { signal });
    if (!Array.isArray(keys.keys) || !keys.keys.length || keys.keys.length > 32) throw new Error();
  } catch { throw new ProviderRequestError(503, "Teams verification keys are unavailable"); }
  try {
    const matches = (keys.keys as Record<string, unknown>[]).filter(key => key.kid === kid);
    if (matches.length !== 1) throw denied();
    const endorsements = matches[0]!.endorsements;
    if (endorsements !== undefined && (!Array.isArray(endorsements) || (endorsements.length > 0 && !endorsements.includes("msteams")))) throw denied();
    const { payload } = await jwtVerify(token!, createLocalJWKSet(keys as unknown as JSONWebKeySet), {
      issuer: ISSUER, audience: app.appId, algorithms: ["RS256"], clockTolerance: 300,
      requiredClaims: ["iss", "aud", "exp", "nbf"],
    });
    // The published REST contract spells serviceUrl; production Connector tokens use serviceurl.
    // Either spelling must match byte-for-byte; conflicting evidence is rejected.
    const claim = payload.serviceurl ?? payload.serviceUrl;
    if (payload.aud !== app.appId || claim !== serviceUrl ||
        (payload.serviceurl !== undefined && payload.serviceUrl !== undefined && payload.serviceurl !== payload.serviceUrl) ||
        !Number.isSafeInteger(payload.nbf) || !Number.isSafeInteger(payload.exp) || payload.exp! <= payload.nbf!) throw denied();
  } catch { throw denied(); }
}

/** Tokens only reach Microsoft-owned, JWT-authenticated destinations persisted by the Hub. */
export function teamsBotClient(app: TeamsAppIdentity, secret: string) {
  if (!MICROSOFT_GUID.test(app.appId) || !MICROSOFT_GUID.test(app.tenantId) ||
      typeof secret !== "string" || secret.length < 8 || secret.length > 256 || /\s/u.test(secret)) {
    throw new ProviderRequestError(503, "Teams company bot is not configured");
  }
  async function headers(): Promise<Headers> {
    let token: Record<string, unknown>;
    try {
      token = await providerJson(`https://login.microsoftonline.com/${app.tenantId}/oauth2/v2.0/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: app.appId, client_secret: secret, scope: SCOPE }) });
    } catch { throw new ProviderRequestError(503, "Teams app authentication could not be confirmed"); }
    if (typeof token.access_token !== "string" || !/^[A-Za-z0-9_.-]{1,8192}$/u.test(token.access_token) ||
        token.token_type !== "Bearer" || !Number.isSafeInteger(token.expires_in) || Number(token.expires_in) <= 0 || Number(token.expires_in) > 86_400) {
      throw new ProviderRequestError(503, "Teams app authentication could not be confirmed");
    }
    return new Headers({ authorization: `Bearer ${token.access_token}` });
  }
  function base(input: TeamsConversationReference): string {
    const ref = teamsReference(input, app);
    return `${ref.serviceUrl}v3/conversations/${encodeURIComponent(ref.conversationId)}`;
  }
  return {
    async member(reference: TeamsConversationReference): Promise<void> {
      const url = `${base(reference)}/members/${encodeURIComponent(reference.userId)}`;
      const member = await providerJson(url, { headers: await headers() }).catch(() => {
        throw new ProviderRequestError(403, "Teams did not confirm the linked conversation member");
      });
      const objectId = member.objectId ?? member.aadObjectId;
      if (member.id !== reference.userId || objectId !== reference.userObjectId ||
          (member.objectId !== undefined && member.aadObjectId !== undefined && member.objectId !== member.aadObjectId) ||
          (member.tenantId !== undefined && member.tenantId !== app.tenantId)) {
        throw new ProviderRequestError(403, "Teams did not confirm the linked conversation member");
      }
    },
    async post(reference: TeamsConversationReference, text: string, beforeWrite: () => Promise<void>): Promise<void> {
      const url = `${base(reference)}/activities`;
      if (typeof text !== "string" || !text.trim() || utf8ByteLength(text) > 4_000 || [...text].some(character => {
        const code = character.charCodeAt(0);
        return code === 127 || code < 32 && ![9, 10, 13].includes(code);
      })) {
        throw new ProviderRequestError(400, "Write a Teams message up to 4000 bytes");
      }
      const authorization = await headers();
      await beforeWrite();
      // Exactly one dispatch; an ambiguous HTTP receipt must not cause another provider write.
      let result: Record<string, unknown>;
      try { result = await providerJson(url, { method: "POST", headers: authorization,
        json: { type: "message", text, textFormat: "plain", channelData: { tenant: { id: app.tenantId } } } }); }
      catch { throw new ProviderRequestError(502, "Teams did not confirm the message; check the conversation before retrying"); }
      if (typeof result.id !== "string" || !/^[A-Za-z0-9_:.-]{1,256}$/u.test(result.id)) {
        throw new ProviderRequestError(502, "Teams returned no message receipt; check the conversation before retrying");
      }
    },
  };
}
