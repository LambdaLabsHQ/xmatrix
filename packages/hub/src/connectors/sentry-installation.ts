import { SENTRY_PUBLIC_INTEGRATION_SCOPES } from "@xmatrix/protocol";
import type { Env } from "../types";
import { providerJson, ProviderRequestError } from "./http";

// Public Integrations authorize an installation UUID, not a user OAuth grant.
// https://github.com/getsentry/integration-platform-example/blob/main/backend-ts/src/api/sentry/setup.ts
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/u;
const ID = /^[1-9][0-9]{0,31}$/u;
const TOKEN = /^[\x21-\x7e]{1,8192}$/u;
const SCOPES = SENTRY_PUBLIC_INTEGRATION_SCOPES;
const CONTEXT_FIELDS = ["oauthClientId", "oauthAppUuid", "oauthAppSlug", "oauthInstallationId",
  "oauthOrganization", "oauthOrganizationId", "oauthScopes"];

export interface SentryInstallationClient {
  clientId: string;
  clientSecret: string;
  appUuid: string;
  appSlug: string;
}

function invalidGrant(): never {
  throw new ProviderRequestError(502, "Sentry did not confirm the scoped installation grant; reconnect");
}

function validClient(client: SentryInstallationClient): boolean {
  return /^[A-Za-z0-9._-]{1,256}$/u.test(client.clientId) && TOKEN.test(client.clientSecret) &&
    !/https?:\/\//iu.test(client.clientSecret) && UUID.test(client.appUuid) && SLUG.test(client.appSlug);
}

/** Configured identity is required even when the saved access token has not expired. */
export function sentryInstallationClient(env: Env): SentryInstallationClient | undefined {
  const vars = env as unknown as Record<string, unknown>;
  const read = (suffix: string): string => typeof vars[`CONNECTOR_SENTRY_${suffix}`] === "string"
    ? vars[`CONNECTOR_SENTRY_${suffix}`] as string : "";
  const client = { clientId: read("CLIENT_ID"), clientSecret: read("CLIENT_SECRET"),
    appUuid: read("APP_UUID"), appSlug: read("APP_SLUG") };
  return validClient(client) ? client : undefined;
}

export function isSentryInstallationGrant(values: Readonly<Record<string, string>>): boolean {
  return CONTEXT_FIELDS.some(field => values[field] !== undefined);
}

function scopes(value: unknown): string {
  if (!Array.isArray(value) || value.length !== SCOPES.length || value.some(scope => typeof scope !== "string") ||
      [...value].sort().join(" ") !== SCOPES.join(" ")) invalidGrant();
  return SCOPES.join(" ");
}

function grantFields(payload: Record<string, unknown>, now: number): Record<string, string> {
  const expiration = typeof payload.expiresAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/u.test(payload.expiresAt)
    ? Date.parse(payload.expiresAt) : NaN;
  if (typeof payload.token !== "string" || !TOKEN.test(payload.token) ||
      typeof payload.refreshToken !== "string" || !TOKEN.test(payload.refreshToken) ||
      payload.token === payload.refreshToken || !Number.isSafeInteger(expiration) || expiration <= now ||
      expiration - now > 86_400_000 ||
      String(payload.expiresAt).slice(0, 19) !== new Date(expiration).toISOString().slice(0, 19)) invalidGrant();
  return { oauthToken: payload.token, oauthRefreshToken: payload.refreshToken,
    oauthExpiresAt: String(expiration), oauthScopes: scopes(payload.scopes) };
}

export function validateSentryInstallationCredentials(values: Readonly<Record<string, string>>,
  client?: SentryInstallationClient): void {
  if (!TOKEN.test(values.oauthToken ?? "") || !TOKEN.test(values.oauthRefreshToken ?? "") ||
      !/^[A-Za-z0-9._-]{1,256}$/u.test(values.oauthClientId ?? "") ||
      !UUID.test(values.oauthAppUuid ?? "") || !UUID.test(values.oauthInstallationId ?? "") ||
      !SLUG.test(values.oauthAppSlug ?? "") || !SLUG.test(values.oauthOrganization ?? "") ||
      !ID.test(values.oauthOrganizationId ?? "") || values.oauthScopes !== SCOPES.join(" ") ||
      !/^[1-9][0-9]{0,15}$/u.test(values.oauthExpiresAt ?? "") ||
      !Number.isSafeInteger(Number(values.oauthExpiresAt))) invalidGrant();
  if (client && (client.clientId !== values.oauthClientId || client.appUuid !== values.oauthAppUuid ||
      client.appSlug !== values.oauthAppSlug)) {
    throw new ProviderRequestError(503, "Sentry Public Integration changed; reconnect");
  }
}

function installationUrl(id: string): string {
  if (!UUID.test(id)) invalidGrant();
  return `https://sentry.io/api/0/sentry-app-installations/${id}/`;
}

/** Provider errors must not copy an authorization code or token into an Apps error or log. */
async function request(url: string, init: Parameters<typeof providerJson>[1]): Promise<Record<string, unknown>> {
  try { return await providerJson(url, init); }
  catch (error) {
    if (error instanceof ProviderRequestError) {
      throw new ProviderRequestError(error.status, `Sentry installation request failed (${error.status})`);
    }
    throw new ProviderRequestError(502, "Sentry installation request could not complete");
  }
}

function installationIdentity(payload: Record<string, unknown>, client: SentryInstallationClient,
  installationId: string, organization: string, organizationId?: string): { organizationId: string; status: string } {
  const app = payload.app as Record<string, unknown> | undefined;
  const org = payload.organization as Record<string, unknown> | undefined;
  // The installation serializer currently returns a numeric id. Reject unsafe
  // JSON integers rather than silently binding an id rounded by the browser.
  const id = typeof org?.id === "number" && Number.isSafeInteger(org.id) && org.id > 0 ? String(org.id) :
    typeof org?.id === "string" && ID.test(org.id) ? org.id : "";
  if (payload.uuid !== installationId || app?.uuid !== client.appUuid || app?.slug !== client.appSlug ||
      org?.slug !== organization || !id ||
      (organizationId !== undefined && id !== organizationId) ||
      (payload.status !== "pending" && payload.status !== "installed")) invalidGrant();
  return { organizationId: id, status: payload.status };
}

/** The caller must obtain an explicit Human confirmation of the organization and target Space first.
 * Sentry's callback contains no xMatrix signed state; callback metadata cannot select a Space.
 * This provider adapter neither persists credentials nor activates a connection.
 */
export async function exchangeSentryInstallation(client: SentryInstallationClient,
  input: { code: string; installationId: string; organization: string }, now = Date.now()): Promise<Record<string, string>> {
  if (!validClient(client) || !TOKEN.test(input.code) || !SLUG.test(input.organization)) invalidGrant();
  const url = installationUrl(input.installationId);
  const token = await request(`${url}authorizations/`, { method: "POST", json: {
    grant_type: "authorization_code", code: input.code, client_id: client.clientId, client_secret: client.clientSecret } });
  const fields = grantFields(token, now);
  const headers = { authorization: `Bearer ${fields.oauthToken}` };
  const identity = installationIdentity(await request(url, { headers }), client, input.installationId, input.organization);
  if (identity.status === "pending") {
    const installed = installationIdentity(await request(url, { method: "PUT", headers, json: { status: "installed" } }),
      client, input.installationId, input.organization, identity.organizationId);
    if (installed.status !== "installed") invalidGrant();
  }
  return { ...fields, oauthClientId: client.clientId, oauthAppUuid: client.appUuid, oauthAppSlug: client.appSlug,
    oauthInstallationId: input.installationId, oauthOrganization: input.organization,
    oauthOrganizationId: identity.organizationId };
}

export async function verifySentryInstallation(values: Readonly<Record<string, string>>): Promise<void> {
  validateSentryInstallationCredentials(values);
  const client = { clientId: values.oauthClientId!, clientSecret: "", appUuid: values.oauthAppUuid!, appSlug: values.oauthAppSlug! };
  const identity = installationIdentity(await request(installationUrl(values.oauthInstallationId!), {
    headers: { authorization: `Bearer ${values.oauthToken}` } }), client,
    values.oauthInstallationId!, values.oauthOrganization!, values.oauthOrganizationId!);
  if (identity.status !== "installed") invalidGrant();
}

export async function refreshSentryInstallation(env: Env, values: Readonly<Record<string, string>>,
  now = Date.now()): Promise<Record<string, string> | undefined> {
  validateSentryInstallationCredentials(values);
  const client = sentryInstallationClient(env);
  if (!client) throw new ProviderRequestError(503, "Sentry Public Integration is unavailable; reconnect");
  validateSentryInstallationCredentials(values, client);
  if (Number(values.oauthExpiresAt) - now > 86_400_000) invalidGrant();
  if (Number(values.oauthExpiresAt) - now > 120_000) return undefined;
  const payload = await request(`${installationUrl(values.oauthInstallationId!)}authorizations/`, { method: "POST", json: {
    grant_type: "refresh_token", refresh_token: values.oauthRefreshToken,
    client_id: client.clientId, client_secret: client.clientSecret } });
  // Save this complete pair with credential-version CAS before any other provider request.
  // The installation-specific authorization endpoint authenticates the same installation.
  const fields = grantFields(payload, now);
  if (fields.oauthToken === values.oauthToken || fields.oauthRefreshToken === values.oauthRefreshToken) invalidGrant();
  return fields;
}

export function sentryOrganization(values: Readonly<Record<string, string>>): string {
  if (!isSentryInstallationGrant(values)) return values.organization ?? "";
  validateSentryInstallationCredentials(values);
  return values.oauthOrganization!;
}
