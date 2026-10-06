import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { base64UrlEncodeBytes, isBoundedTrimmedUtf8String } from "../relay-v2-primitives";
import { timingSafeEqual } from "@xmatrix/protocol";
import { providerJson, ProviderRequestError } from "./http";

export const PAGERDUTY_SCOPES = ["abilities.read", "incidents.read", "incidents.write"];
// Current fixed provider discovery issuer differs from the prose ID-token guide.
const ISSUER = "https://app.pagerduty.com/global/oauth/anonymous";
const JWKS = "https://identity.pagerduty.com/global/oauth/anonymous/jwks";
const API_REGIONS: Record<string, string> = { "https://api.pagerduty.com": "us", "https://api.eu.pagerduty.com": "eu" };

function fail(): never {
  throw new ProviderRequestError(502, "PagerDuty did not confirm the scoped, rotating user grant; reconnect");
}

/** Classic read/write or partial openid-only grants must not masquerade as Scoped OAuth. */
export function validatePagerDutyGrant(payload: Record<string, unknown>): void {
  const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/u).filter(Boolean) : [];
  const seconds = typeof payload.expires_in === "number" || typeof payload.expires_in === "string" ? Number(payload.expires_in) : NaN;
  if (!isBoundedTrimmedUtf8String(payload.scope, 512) || !isBoundedTrimmedUtf8String(payload.access_token, 4_096) ||
      !isBoundedTrimmedUtf8String(payload.refresh_token, 4_096) ||
      typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer" ||
      !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86_400 ||
      !PAGERDUTY_SCOPES.every(scope => scopes.includes(scope)) ||
      scopes.some(scope => scope !== "openid" && !PAGERDUTY_SCOPES.includes(scope)) || new Set(scopes).size !== scopes.length) fail();
}

/** Only provider-signed claims choose the OAuth REST region and account. Profiles are discarded. */
export async function pagerDutyGrantContext(clientId: string, payload: Record<string, unknown>,
  previous?: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  if (payload.id_token === undefined && previous) return {};
  if (!isBoundedTrimmedUtf8String(payload.id_token, 16_384)) fail();
  const jwks = await providerJson(JWKS);
  if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 32) fail();
  try {
    const { payload: claims } = await jwtVerify(payload.id_token, createLocalJWKSet(jwks as unknown as JSONWebKeySet), {
      issuer: ISSUER, audience: clientId, algorithms: ["RS256"], maxTokenAge: "1d", clockTolerance: 30,
      requiredClaims: ["iss", "aud", "sub", "exp", "iat", "at_hash"],
    });
    const audiences = Array.isArray(claims.aud) ? claims.aud : [];
    const api = audiences.find(value => Object.hasOwn(API_REGIONS, value));
    const region = api ? API_REGIONS[api] : undefined;
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(payload.access_token))));
    if (!region || audiences.length !== 2 || !audiences.includes(clientId) ||
        typeof claims.sub !== "string" || !claims.sub || claims.azp !== clientId || claims.purpose !== "id" || typeof claims.at_hash !== "string" ||
        !timingSafeEqual(claims.at_hash, base64UrlEncodeBytes(hash.slice(0, 16))) ||
        typeof claims.account_id !== "string" || !/^[A-Z0-9]{1,32}$/u.test(claims.account_id) ||
        typeof claims.subdomain !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(claims.subdomain)) fail();
    const fields = { oauthRegion: region, oauthAccountId: claims.account_id, oauthSubdomain: claims.subdomain,
      oauthClientId: clientId };
    if (previous && Object.entries(fields).some(([name, value]) => previous[name] !== value)) fail();
    return fields;
  } catch { return fail(); }
}

export function validatePagerDutyCredentials(values: Readonly<Record<string, string>>): void {
  if (!values.oauthToken) return;
  if (!isBoundedTrimmedUtf8String(values.oauthToken, 4_096) || !isBoundedTrimmedUtf8String(values.oauthRefreshToken, 4_096) ||
      !Number.isSafeInteger(Number(values.oauthExpiresAt)) || Number(values.oauthExpiresAt) <= 0 ||
      !["us", "eu"].includes(values.oauthRegion ?? "") || !/^[A-Z0-9]{1,32}$/u.test(values.oauthAccountId ?? "") ||
      !isBoundedTrimmedUtf8String(values.oauthClientId, 128) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(values.oauthSubdomain ?? "") || !PAGERDUTY_SCOPES.every(scope => (values.oauthScopes ?? "").split(/\s+/u).includes(scope))) {
    throw new ProviderRequestError(401, "PagerDuty OAuth credentials are incomplete; reconnect");
  }
}

/** OAuth region is managed evidence; manual metadata never overrides it. */
export function pagerDutyApiOrigin(values: Readonly<Record<string, string>>): string {
  if (values.oauthToken) validatePagerDutyCredentials(values);
  const region = values.oauthToken ? values.oauthRegion : values.apiRegion || "us";
  if (!["us", "eu"].includes(region ?? "")) throw new ProviderRequestError(400, "PagerDuty region must be us or eu");
  return region === "eu" ? "https://api.eu.pagerduty.com" : "https://api.pagerduty.com";
}
