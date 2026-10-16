import { metered, type UpstreamMeter } from "../usage-cost-metering";
import { record } from "./command-support";
import { providerJson, ProviderRequestError } from "./http";
import type { OAuthClient } from "./oauth";
import { xAccountFields, type XAccount } from "./x-accounts";
import twitterText from "twitter-text";
import type { UpstreamCallPrice } from "../usage-cost-metering";

/** The X API operations the Hub calls, by method and path; ids never become labels. */
const X_OPERATIONS: ReadonlyArray<readonly [string, RegExp, string]> = [
  ["POST", /^\/2\/tweets$/u, "posts_create"],
  ["GET", /^\/2\/tweets\/\d+(?:\?|$)/u, "posts_read"],
  ["GET", /^\/2\/users\/\d+\/tweets(?:\?|$)/u, "user_posts_read"],
  ["GET", /^\/2\/users\/me$/u, "users_me"],
  ["POST", /^\/2\/media\/upload\/initialize$/u, "media_initialize"],
  ["POST", /^\/2\/media\/upload\/\d+\/append$/u, "media_append"],
  ["POST", /^\/2\/media\/upload\/\d+\/finalize$/u, "media_finalize"],
  ["GET", /^\/2\/media\/upload\?command=STATUS&/u, "media_status"],
  ["POST", /^\/2\/oauth2\/token$/u, "oauth_token"],
];

function xOperation(method: string, path: string): string {
  return X_OPERATIONS.find(([verb, pattern]) => verb === method && pattern.test(path))?.[2] ?? "other";
}

/** Only public metadata enters pricing: no text, tokens or resource ids. */
export function xCallPrice(operation: string, json?: unknown): UpstreamCallPrice | undefined {
  const body = record(json);
  const text = typeof body.text === "string" ? body.text : "";
  // Follow X's URL extraction instead of treating every extension as a TLD.
  const linked = twitterText.extractUrls(text).length > 0 || /https?:\/\/\S+/iu.test(text);
  if (operation === "oauth_token") return undefined;
  if (operation === "posts_create") return { kind: body.quote_tweet_id !== undefined || body.media !== undefined ||
    linked ? "x_post_url" : "x_post", maximumUnits: 1 };
  if (operation === "posts_read") return { kind: "x_post_read", maximumUnits: 1 };
  if (operation === "user_posts_read") return { kind: "x_post_read", maximumUnits: 10 };
  if (operation === "users_me") return { kind: "x_profile_read", maximumUnits: 1 };
  if (operation.startsWith("media_")) return { kind: "x_media", maximumUnits: 1 };
  throw new ProviderRequestError(503, "This X operation has no configured credit price");
}

/**
 * Fixed diagnostics: token endpoint bodies must never enter Channel receipts or logs.
 * Every call goes to the company X app's account, so a caller's meter records it.
 */
export function xProviderJson(path: string, init: Parameters<typeof providerJson>[1] = {}, meter?: UpstreamMeter) {
  const operation = xOperation(init.method ?? "GET", path);
  return metered(meter, "x", operation, () => providerJson(`https://api.x.com${path}`, { ...init,
    describeError: () => "X rejected the request; check authorization, API balance and endpoint access" }),
  xCallPrice(operation, init.json));
}

export function xTokenGrant(client: OAuthClient, payload: Record<string, unknown>, previous?: XAccount):
  Pick<XAccount, "accessToken" | "refreshToken" | "expiresAt" | "scopes" | "clientId"> {
  const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/u).filter(Boolean) : [];
  const expected = client.manifest.oauth.scopes;
  const token = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,2048}$/u.test(value);
  if (!token(payload.access_token) || !token(payload.refresh_token) ||
      typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer" ||
      !Number.isSafeInteger(payload.expires_in) || Number(payload.expires_in) <= 0 || Number(payload.expires_in) > 86_400 ||
      ((!previous || payload.scope !== undefined) && (scopes.length !== expected.length || new Set(scopes).size !== scopes.length ||
        scopes.some(scope => !expected.includes(scope))))) {
    throw new ProviderRequestError(502, "X did not confirm the complete offline grant; reconnect X");
  }
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token,
    expiresAt: Date.now() + Number(payload.expires_in) * 1000, scopes: expected.join(" "), clientId: client.clientId };
}

export async function xOAuthFields(client: OAuthClient, payload: Record<string, unknown>, ownerUserId: string,
  expectedAccountId?: string, meter?: UpstreamMeter) {
  const tokens = xTokenGrant(client, payload);
  const profile = record((await xProviderJson("/2/users/me", { headers: { authorization: `Bearer ${tokens.accessToken}` } }, meter)).data);
  if (typeof profile.id !== "string" || !/^[1-9][0-9]{0,19}$/u.test(profile.id) ||
      typeof profile.username !== "string" || !/^[A-Za-z0-9_]{1,15}$/u.test(profile.username)) {
    throw new ProviderRequestError(502, "X did not confirm the connected account");
  }
  if (expectedAccountId !== undefined && profile.id !== expectedAccountId) {
    throw new ProviderRequestError(409, "A different X account was authorized; restart Reconnect and choose the intended account");
  }
  return xAccountFields([{ id: profile.id, username: profile.username, generation: crypto.randomUUID(), ownerUserId, ...tokens }]);
}
