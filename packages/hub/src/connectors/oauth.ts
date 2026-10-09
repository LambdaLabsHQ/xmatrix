import { APP_CONNECTOR_PROVIDER_MANIFESTS, type AppConnectorProviderManifest } from "@xmatrix/protocol";
import { base64UrlDecode, signGitHubAppState, verifyGitHubAppState } from "../index-shared";
import type { Env } from "../types";
import { providerJson, ProviderRequestError } from "./http";
import { vercelEventScopeId, vercelOAuthFields } from "./vercel-api";
import { pkceChallenge, pkceGrantProof, validPkceClaims, oauthGrantState } from "./oauth-pkce";
import { pagerDutyGrantContext, validatePagerDutyCredentials, validatePagerDutyGrant } from "./pagerduty-oauth";
import { discordCompanyApp, discordGrantContext, isDiscordInstallationGrant, validateDiscordCredentials } from "./discord-oauth";
import type { AppOAuthInstallation } from "@xmatrix/db";
import { isSentryInstallationGrant, refreshSentryInstallation } from "./sentry-installation";
import { cloudflareGrantContext } from "./cloudflare-api";
import { composioConnectedAccount, composioConnectUrl, composioUserId } from "./composio";

/*
 * One-click OAuth for connectors (docs/design/connector-platform.md §3.2).
 * A provider offers it only when the Hub has `CONNECTOR_<ID>_CLIENT_ID` and
 * `CONNECTOR_<ID>_CLIENT_SECRET`; the signed state binds the Space, the
 * provider and the admin who started it, and expires in ten minutes. The
 * tokens land in the connection's encrypted credentials; expiring tokens are
 * refreshed by the Hub before an action uses them.
 */

const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 2 * 60_000;
/* Each Google provider holds exactly one scope, on its own connection and token. */
const GOOGLE_GRANTS: Record<string, { scope: string; name: string }> = {
  google: { scope: "https://www.googleapis.com/auth/drive.file", name: "per-file" },
  googlesearchconsole: { scope: "https://www.googleapis.com/auth/webmasters", name: "Search Console" },
  googleadsense: { scope: "https://www.googleapis.com/auth/adsense.readonly", name: "AdSense" },
  gcp: { scope: "https://www.googleapis.com/auth/cloud-platform", name: "Google Cloud" },
};

/**
 * Disconnecting a Google connection, or a Composio one such as Gmail, deletes its stored grant
 * (Google API Services User Data Policy), so connecting again signs in anew. Other providers keep theirs.
 */
export function grantFieldsForgottenOnDisconnect(providerId: string): Record<string, null> | undefined {
  const manifest = APP_CONNECTOR_PROVIDER_MANIFESTS.find((candidate) => candidate.id === providerId);
  if (!GOOGLE_GRANTS[providerId] && manifest?.oauth?.flow !== "composio") return undefined;
  return Object.fromEntries((manifest?.credentials ?? []).filter((field) => field.managed).map((field) => [field.id, null]));
}

/* Providers that sign in with another provider's company OAuth client. */
const SHARED_OAUTH_CLIENTS: Record<string, string> = { googlesearchconsole: "google", googleadsense: "google", gcp: "google" };

function validateGoogleGrant(providerId: string, payload: Record<string, unknown>, initial: boolean): void {
  const { scope, name } = GOOGLE_GRANTS[providerId]!;
  const expires = Number(payload.expires_in);
  const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/u).filter(Boolean) : [];
  if (!Number.isFinite(expires) || expires <= 0 || expires > 86_400 ||
      typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer" ||
      ((initial || payload.scope !== undefined) && (scopes.length !== 1 || scopes[0] !== scope)) ||
      (initial && (typeof payload.refresh_token !== "string" || !payload.refresh_token))) {
    throw new ProviderRequestError(502, `Google did not confirm an offline, ${name} OAuth grant; reconnect with the requested permission`);
  }
}

function validateBitbucketGrant(payload: Record<string, unknown>, initial: boolean): void {
  const seconds = Number(payload.expires_in);
  const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/u) : [];
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86_400 ||
      typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer" ||
      (typeof payload.refresh_token !== "string" || !payload.refresh_token) ||
      ((initial || payload.scope !== undefined) && (!scopes.includes("account") || !scopes.includes("pullrequest")))) {
    throw new ProviderRequestError(502, "Bitbucket did not confirm an expiring account/pullrequest OAuth grant");
  }
}

export interface OAuthClient {
  manifest: AppConnectorProviderManifest & { oauth: NonNullable<AppConnectorProviderManifest["oauth"]> };
  clientId: string;
  clientSecret: string;
}

function envValue(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

export function oauthClient(env: Env, providerId: string): OAuthClient | undefined {
  // Public Integration installs have their own UUID exchange and Human confirmation.
  // Never offer the legacy user-OAuth button for a configured Public Integration.
  if (providerId === "sentry" && (envValue(env, "CONNECTOR_SENTRY_APP_UUID") || envValue(env, "CONNECTOR_SENTRY_APP_SLUG"))) {
    return undefined;
  }
  const manifest = APP_CONNECTOR_PROVIDER_MANIFESTS.find((candidate) => candidate.id === providerId);
  if (!manifest?.oauth || manifest.status !== "available") return undefined;
  if (providerId === "discord" && !discordCompanyApp(env)) return undefined;
  const prefix = `CONNECTOR_${(SHARED_OAUTH_CLIENTS[manifest.id] ?? manifest.id).toUpperCase()}`;
  const clientId = envValue(env, `${prefix}_CLIENT_ID`);
  /* Composio providers share the company Composio project key; their client id is the provider's auth config. */
  const clientSecret = envValue(env, manifest.oauth.flow === "composio" ? "CONNECTOR_COMPOSIO_API_KEY" : `${prefix}_CLIENT_SECRET`);
  if (!clientId || !clientSecret) return undefined;
  return { manifest: manifest as OAuthClient["manifest"], clientId, clientSecret };
}

/** Providers whose one-click OAuth is configured on this Hub. */
export function oauthProviderIds(env: Env): string[] {
  return APP_CONNECTOR_PROVIDER_MANIFESTS.filter((manifest) => oauthClient(env, manifest.id)).map((manifest) => manifest.id);
}

export function oauthRedirectUri(hubOrigin: string): string {
  return `${hubOrigin.replace(/\/+$/u, "")}/api/connectors/oauth/callback`;
}

export async function oauthAuthorizeUrl(client: OAuthClient, input: { spaceId: string; userId: string;
  redirectUri: string; now?: number; connectionSnapshot?: { connectionVersion: number; credentialVersion: number; connectionGeneration: string } }): Promise<string> {
  const { oauth } = client.manifest;
  const claims = { providerId: client.manifest.id, spaceId: input.spaceId, userId: input.userId,
    nonce: crypto.randomUUID(), expiresAt: (input.now ?? Date.now()) + STATE_TTL_MS,
    ...(oauth.pkce || client.manifest.id === "discord" ? { clientId: client.clientId, redirectUri: input.redirectUri } : {}),
    ...(client.manifest.id === "discord" ? { connectionSnapshot: input.connectionSnapshot, authorizationStartedAt: input.now ?? Date.now() } : {}) };
  const state = await signGitHubAppState(claims, client.clientSecret);
  if (oauth.flow === "composio") {
    const callback = new URL(input.redirectUri);
    callback.searchParams.set("state", state);
    return composioConnectUrl(client, composioUserId(input.spaceId, claims.nonce), callback.toString());
  }
  const url = new URL(oauth.authorizeUrl);
  if (oauth.flow === "vercel-integration") {
    url.searchParams.set("state", state);
    return url.toString();
  }
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (oauth.scopes.length > 0) url.searchParams.set("scope", oauth.scopes.join(oauth.scopeSeparator ?? " "));
  for (const [key, value] of Object.entries(oauth.extraAuthorizeParams ?? {})) url.searchParams.set(key, value);
  if (oauth.pkce) {
    url.searchParams.set("code_challenge", await pkceChallenge(client, claims));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** The state's claims, verified with the provider's own client secret; undefined when forged or expired. */
export async function verifyOAuthState(env: Env, state: string):
  Promise<{ client: OAuthClient; spaceId: string; userId: string; connectionSnapshot?: { connectionVersion: number; credentialVersion: number; connectionGeneration: string } } | undefined> {
  if (!state || state.length > 4_096) return undefined;
  let providerId = "";
  try {
    providerId = String((JSON.parse(base64UrlDecode(state.split(".")[0] ?? "")) as Record<string, unknown>).providerId ?? "");
  } catch {
    return undefined;
  }
  const client = oauthClient(env, providerId);
  if (!client) return undefined;
  const claims = await verifyGitHubAppState(state, client.clientSecret).catch(() => undefined);
  if (!claims || claims.providerId !== client.manifest.id || typeof claims.spaceId !== "string" ||
      typeof claims.userId !== "string" || ((client.manifest.oauth.pkce || client.manifest.id === "discord") && !validPkceClaims(client, claims))) return undefined;
  const snapshot = claims.connectionSnapshot as { connectionVersion: number; credentialVersion: number; connectionGeneration: string } | undefined;
  if (client.manifest.id === "discord" && (!snapshot || !Number.isSafeInteger(snapshot.connectionVersion) || snapshot.connectionVersion < 1 ||
      !Number.isSafeInteger(snapshot.credentialVersion) || snapshot.credentialVersion < 0 ||
      typeof snapshot.connectionGeneration !== "string" || !snapshot.connectionGeneration || snapshot.connectionGeneration.length > 1024)) return undefined;
  return { client, spaceId: claims.spaceId, userId: claims.userId, ...(client.manifest.id === "discord" ? { connectionSnapshot: snapshot } : {}) };
}

async function tokenRequest(client: OAuthClient, grant: Record<string, string>): Promise<Record<string, unknown>> {
  const { oauth } = client.manifest;
  if (oauth.flow === "vercel-integration") {
    const { grant_type: _grantType, ...integrationGrant } = grant;
    grant = integrationGrant;
  }
  const body: Record<string, string> = { ...grant,
    ...(oauth.clientAuth === "basic" ? {} : { client_id: client.clientId, client_secret: client.clientSecret }) };
  const headers: Record<string, string> = oauth.clientAuth === "basic"
    ? { authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}` } : {};
  const payload = await (oauth.tokenRequest === "json"
    ? providerJson(oauth.tokenUrl, { method: "POST", headers, json: body })
    : providerJson(oauth.tokenUrl, { method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) })).catch(error => {
      if (["pagerduty", "discord"].includes(client.manifest.id) && error instanceof ProviderRequestError) {
        throw new ProviderRequestError(error.status, `${client.manifest.name} token exchange failed (${error.status})`);
      }
      throw error;
    });
  if (payload.ok === false || typeof payload.access_token !== "string" || !payload.access_token) {
    throw new ProviderRequestError(400, `${client.manifest.name} did not issue a token${["pagerduty", "discord"].includes(client.manifest.id) ? "" : `: ${String(payload.error ?? "unknown")}`}`);
  }
  return payload;
}

/** The credential values a token response sets. */
export function oauthTokenFields(client: OAuthClient, payload: Record<string, unknown>, now = Date.now()):
  Record<string, string | null> {
  const fields: Record<string, string | null> = { [client.manifest.oauth.tokenField]: String(payload.access_token) };
  const managed = (id: string) => client.manifest.credentials?.some((field) => field.id === id && field.managed);
  if (managed("oauthRefreshToken")) {
    fields.oauthRefreshToken = typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : null;
  }
  if (managed("oauthExpiresAt")) {
    const seconds = Number(payload.expires_in);
    fields.oauthExpiresAt = Number.isFinite(seconds) && seconds > 0 ? String(now + seconds * 1_000) : null;
  }
  if (client.manifest.id === "pagerduty") {
    validatePagerDutyGrant(payload);
    fields.oauthScopes = String(payload.scope);
  }
  return fields;
}

/* What a provider needs beyond the token to call its API. */
async function providerContext(client: OAuthClient, token: string): Promise<Record<string, string>> {
  if (client.manifest.id === "sentry") {
    const organizations = await providerJson("https://sentry.io/api/0/organizations/", {
      headers: { authorization: `Bearer ${token}` } });
    const list = Array.isArray(organizations.items) ? organizations.items as Record<string, unknown>[] : [];
    return list.length === 1 && typeof list[0]!.slug === "string" ? { organization: list[0]!.slug } : {};
  }
  if (client.manifest.id === "jira") {
    const resources = await providerJson("https://api.atlassian.com/oauth/token/accessible-resources", {
      headers: { authorization: `Bearer ${token}` } });
    const site = (Array.isArray(resources.items) ? resources.items as Record<string, unknown>[] : [])[0];
    return site && typeof site.id === "string"
      ? { cloudId: site.id, ...(typeof site.url === "string" ? { siteUrl: site.url } : {}) } : {};
  }
  if (client.manifest.id === "cloudflare") return cloudflareGrantContext(token);
  return {};
}

/** Provider-authenticated workspace evidence stays separate from user-editable metadata. */
export async function exchangeOAuthGrant(client: OAuthClient, code: string, redirectUri: string, state?: string):
  Promise<{ fields: Record<string, string | null>; installation?: AppOAuthInstallation }> {
  if (client.manifest.oauth.flow === "composio") {
    const claims = state && state.length <= 4_096 ? await verifyGitHubAppState(state, client.clientSecret).catch(() => undefined) : undefined;
    if (!claims || claims.providerId !== client.manifest.id || typeof claims.spaceId !== "string" || typeof claims.nonce !== "string") {
      throw new ProviderRequestError(400, "Invalid or expired connect request; restart Connect");
    }
    return { fields: { [client.manifest.oauth.tokenField]: await composioConnectedAccount(client, composioUserId(claims.spaceId, claims.nonce)) } };
  }
  let discordStartedAt: string | undefined;
  if (client.manifest.id === "discord") {
    if (!code || code.length > 4096 || /\s/u.test(code)) throw new ProviderRequestError(400, "Invalid Discord authorization code");
    const claims = await oauthGrantState(client, state, redirectUri);
    if (!Number.isSafeInteger(claims.authorizationStartedAt) || Number(claims.authorizationStartedAt) > Date.now() ||
        Number(claims.authorizationStartedAt) < Date.now() - STATE_TTL_MS) throw new ProviderRequestError(400, "Restart Discord Connect");
    discordStartedAt = new Date(Number(claims.authorizationStartedAt)).toISOString();
  }
  const proof = client.manifest.oauth.pkce ? await pkceGrantProof(client, state, redirectUri) : undefined;
  const payload = await tokenRequest(client, { grant_type: "authorization_code", code, redirect_uri: redirectUri,
    ...(proof ? { code_verifier: proof } : {}) });
  if (GOOGLE_GRANTS[client.manifest.id]) validateGoogleGrant(client.manifest.id, payload, true);
  if (client.manifest.id === "bitbucket") validateBitbucketGrant(payload, true);
  const fields = oauthTokenFields(client, payload);
  const vercelFields = client.manifest.oauth.flow === "vercel-integration" ? await vercelOAuthFields(client.clientId, payload) : {};
  let installationId: unknown;
  if (client.manifest.id === "slack") {
    // This route supports workspace installs, not organization-wide Enterprise Grid installs.
    if (payload.is_enterprise_install === true) throw new ProviderRequestError(400, "Connect a Slack workspace");
    const team = payload.team;
    installationId = team && typeof team === "object" ? (team as Record<string, unknown>).id : undefined;
  } else if (client.manifest.id === "linear") {
    const result = await providerJson("https://api.linear.app/graphql", { method: "POST",
      headers: { authorization: `Bearer ${String(payload.access_token)}` }, json: { query: "query { organization { id } }" } });
    if (Array.isArray(result.errors) && result.errors.length) {
      throw new ProviderRequestError(400, "Linear did not confirm the OAuth workspace");
    }
    const data = result.data as { organization?: { id?: unknown } } | undefined;
    installationId = data?.organization?.id;
  }
  const routed = client.manifest.id === "slack" || client.manifest.id === "linear";
  if (routed && (typeof installationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(installationId))) {
    throw new ProviderRequestError(400, "Provider did not confirm the OAuth workspace");
  }
  const discordContext = client.manifest.id === "discord" ? await discordGrantContext(client.clientId, payload) : undefined;
  return { fields: { ...fields, ...await providerContext(client, String(payload.access_token)),
    ...(client.manifest.id === "pagerduty" ? await pagerDutyGrantContext(client.clientId, payload) : {}),
    ...(client.manifest.id === "discord" ? { ...discordContext, botToken: null } : {}),
    ...vercelFields },
    ...(client.manifest.id === "vercel" ? { installation: { appClientId: client.clientId,
      installationId: vercelFields.oauthConfigurationId!,
      eventScopeId: vercelEventScopeId(vercelFields.oauthTeamId, vercelFields.oauthUserId)! } } : {}),
    ...(discordContext ? { installation: { appClientId: client.clientId, installationId: discordContext.oauthGuildId,
      eventScopeId: discordContext.oauthUserId, discordAuthorizedAt: discordStartedAt! } } : {}),
    ...(routed ? { installation: { appClientId: client.clientId, installationId: installationId as string } } : {}) };
}

/**
 * Credentials whose OAuth token is about to expire, refreshed; `undefined`
 * when nothing needs refreshing. The caller stores the returned fields.
 */
export async function refreshOAuthFields(env: Env, providerId: string, values: Readonly<Record<string, string>>,
  now = Date.now(), options: { unauthorized?: boolean } = {}): Promise<Record<string, string | null> | undefined> {
  if (providerId === "sentry" && isSentryInstallationGrant(values)) {
    return refreshSentryInstallation(env, values, now, options.unauthorized === true);
  }
  const expiresAt = Number(values.oauthExpiresAt);
  if (providerId === "discord" && isDiscordInstallationGrant(values)) {
    const configured = discordCompanyApp(env);
    if (!configured) throw new ProviderRequestError(503, "Discord company application is unavailable; reconnect");
    validateDiscordCredentials(values, configured.clientId);
  }
  if (providerId === "pagerduty" && values.oauthToken) {
    validatePagerDutyCredentials(values);
    const configured = oauthClient(env, providerId);
    if (!configured || configured.clientId !== values.oauthClientId) {
      throw new ProviderRequestError(503, "PagerDuty OAuth application changed or is unavailable; reconnect");
    }
  }
  const afterNotionUnauthorized = providerId === "notion" && options.unauthorized === true;
  if (providerId === "gcp" && values.oauthToken &&
      (!values.oauthRefreshToken || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)) {
    throw new ProviderRequestError(401, "Google Cloud OAuth requires a complete expiring grant; reconnect");
  }
  if (providerId === "bitbucket" && values.oauthToken &&
      (!values.oauthRefreshToken || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)) {
    throw new ProviderRequestError(401, "Bitbucket OAuth requires a complete expiring grant; reconnect");
  }
  if (!values.oauthRefreshToken || (!afterNotionUnauthorized &&
      (!Number.isFinite(expiresAt) || expiresAt - now > REFRESH_MARGIN_MS))) return undefined;
  const client = oauthClient(env, providerId);
  if (!client) {
    if (providerId === "gcp") throw new ProviderRequestError(503, "Google Cloud OAuth application is unavailable for refresh; reconnect");
    if (providerId === "bitbucket") throw new ProviderRequestError(503, "Bitbucket OAuth consumer is unavailable for refresh");
    if (providerId === "sentry") throw new ProviderRequestError(503, "Sentry user OAuth is unavailable for refresh; reconnect");
    return undefined;
  }
  const payload = await tokenRequest(client, { grant_type: "refresh_token", refresh_token: values.oauthRefreshToken });
  if (GOOGLE_GRANTS[providerId]) validateGoogleGrant(providerId, payload, false);
  if (providerId === "bitbucket") validateBitbucketGrant(payload, false);
  if (providerId === "notion" && (typeof payload.refresh_token !== "string" || !payload.refresh_token)) {
    throw new ProviderRequestError(502, "Notion did not return its rotated refresh token");
  }
  const fields = oauthTokenFields(client, payload, now);
  if (providerId === "discord") Object.assign(fields, await discordGrantContext(client.clientId, payload, values));
  if (providerId === "pagerduty") Object.assign(fields, await pagerDutyGrantContext(client.clientId, payload, values));
  /* Providers that do not rotate refresh tokens keep the one they issued. */
  if (fields.oauthRefreshToken === null) delete fields.oauthRefreshToken;
  return fields;
}
