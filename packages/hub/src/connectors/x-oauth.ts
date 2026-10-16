import { record } from "./command-support";
import { providerJson, ProviderRequestError } from "./http";
import type { OAuthClient } from "./oauth";
import { xAccountFields, type XAccount } from "./x-accounts";

/** Fixed diagnostics: token endpoint bodies must never enter Channel receipts or logs. */
export function xProviderJson(path: string, init: Parameters<typeof providerJson>[1] = {}) {
  return providerJson(`https://api.x.com${path}`, { ...init,
    describeError: () => "X rejected the request; check authorization, API balance and endpoint access" });
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

export async function xOAuthFields(client: OAuthClient, payload: Record<string, unknown>, ownerUserId: string, expectedAccountId?: string) {
  const tokens = xTokenGrant(client, payload);
  const profile = record((await xProviderJson("/2/users/me", { headers: { authorization: `Bearer ${tokens.accessToken}` } })).data);
  if (typeof profile.id !== "string" || !/^[1-9][0-9]{0,19}$/u.test(profile.id) ||
      typeof profile.username !== "string" || !/^[A-Za-z0-9_]{1,15}$/u.test(profile.username)) {
    throw new ProviderRequestError(502, "X did not confirm the connected account");
  }
  if (expectedAccountId !== undefined && profile.id !== expectedAccountId) {
    throw new ProviderRequestError(409, "A different X account was authorized; restart Reconnect and choose the intended account");
  }
  return xAccountFields([{ id: profile.id, username: profile.username, generation: crypto.randomUUID(), ownerUserId, ...tokens }]);
}
