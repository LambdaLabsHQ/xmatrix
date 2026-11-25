import { ConnectorRemedy, providerJson, providerUrl, ProviderRequestError } from "./http";

const INSTALLATION = /^icfg_[A-Za-z0-9]{1,80}$/u;
const TOKEN_URL = "https://api.vercel.com/v2/oauth/access_token";
/* Vercel recommends reusing a cached token only while more than a few minutes remain. */
const RENEW_MARGIN_MS = 5 * 60_000;

/*
 * Vercel's describeError for the token endpoint: each OAuth error names who can
 * fix it. https://vercel.com/docs/integrations/create-integration/short-lived-access-tokens
 */
function tokenError(payload: Record<string, unknown>): string {
  if (payload.error === "unauthorized_client") return "the xMatrix Vercel integration does not have Access Tokens (client credentials) enabled in the Vercel Integration Console";
  if (payload.error === "invalid_client") return "Vercel rejected the xMatrix integration's client credentials; the company app configuration must be checked";
  if (payload.error === "invalid_grant") return "this Vercel installation was removed, disabled or belongs to another integration";
  if (payload.error === "rate_limit_exceeded") return "Vercel is rate-limiting token requests; retry shortly";
  return `Vercel token request failed${typeof payload.error === "string" ? ` (${payload.error.slice(0, 60)})` : ""}`;
}

/**
 * A short-lived installation token from the client_credentials grant, or
 * `undefined` while the saved one has more than five minutes left. Vercel
 * issues no refresh tokens and authorization-code tokens expire within the
 * hour, so the installation id plus the company client secret is the only
 * durable grant: every renewal asks Vercel again.
 */
export async function vercelInstallationToken(client: { clientId: string; clientSecret: string },
  values: Readonly<Record<string, string | null | undefined>>, now = Date.now(), force = false):
  Promise<{ oauthToken: string; oauthExpiresAt: string } | undefined> {
  const installation = values.oauthConfigurationId;
  if (!installation || !INSTALLATION.test(installation) || values.oauthAppClientId !== client.clientId) {
    throw new ConnectorRemedy(401, "This Vercel connection was made with another or no xMatrix integration; reconnect Vercel", { kind: "reconnect" });
  }
  const expiresAt = Number(values.oauthExpiresAt);
  if (!force && values.oauthToken && Number.isSafeInteger(expiresAt) && expiresAt - now > RENEW_MARGIN_MS) return undefined;
  let refused: unknown;
  const payload = await providerJson(TOKEN_URL, { method: "POST",
    headers: { authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", installation_id: installation }),
    describeError: (body) => { refused = body.error; return tokenError(body); } }).catch(error => {
      if (!(error instanceof ProviderRequestError) || refused === undefined) throw error;
      const reason = `Vercel: ${tokenError({ error: refused })}`;
      if (refused === "invalid_grant") throw new ConnectorRemedy(401, `${reason}; reconnect Vercel`, { kind: "reconnect" });
      throw new ProviderRequestError(error.status, reason);
    });
  const seconds = Number(payload.expires_in);
  if (typeof payload.access_token !== "string" || !payload.access_token || payload.installation_id !== installation ||
      (payload.team_id ?? null) !== (values.oauthTeamId || null) || !Number.isFinite(seconds) || seconds <= 0) {
    throw new ProviderRequestError(502, "Vercel did not issue a token for this installation and team");
  }
  return { oauthToken: payload.access_token, oauthExpiresAt: String(now + seconds * 1_000) };
}

export function vercelApiUrl(credentials: Readonly<Record<string, string>>, path: string): URL {
  const url = providerUrl("https://api.vercel.com", path);
  const team = credentials.oauthToken ? credentials.oauthTeamId : credentials.teamId;
  if (team) {
    if (!/^team_[A-Za-z0-9]{1,80}$/u.test(team)) throw new ProviderRequestError(400, "Invalid Vercel team");
    url.searchParams.set("teamId", team);
  }
  return url;
}

export function vercelEventScopeId(team: unknown, user: unknown): string | undefined {
  if (typeof team === "string" && /^team_[A-Za-z0-9]{1,80}$/u.test(team)) return team;
  if (team === null && typeof user === "string" && /^[A-Za-z0-9_-]{1,80}$/u.test(user)) return `user_${user}`;
  return undefined;
}

async function vercelConfiguration(credentials: Readonly<Record<string, string>>) {
  const id = credentials.oauthConfigurationId;
  const appId = credentials.oauthAppClientId;
  if (!credentials.oauthToken || !id || !INSTALLATION.test(id) || !appId) {
    throw new ProviderRequestError(400, "Vercel OAuth installation is missing");
  }
  const result = await providerJson(vercelApiUrl(credentials, `v1/integrations/configuration/${encodeURIComponent(id)}`),
    { headers: { authorization: `Bearer ${credentials.oauthToken}` } });
  if (result.id !== id || result.integrationId !== appId || result.disabledAt != null || result.deletedAt != null ||
      result.deleteRequestedAt != null || result.customerDeleteRequestedAt != null ||
      (result.teamId ?? null) !== (credentials.oauthTeamId || null) ||
      (credentials.oauthUserId && result.userId !== credentials.oauthUserId)) {
    throw new ProviderRequestError(400, "Vercel integration is unavailable or belongs to another scope");
  }
  return result;
}

export async function verifyVercel(credentials: Readonly<Record<string, string>>): Promise<void> {
  const token = credentials.oauthToken || credentials.accessToken;
  if (!token) return; // Manual webhook-only setups still require a real incoming delivery.
  const headers = { authorization: `Bearer ${token}` };
  if (!credentials.oauthToken) {
    const result = await providerJson(vercelApiUrl(credentials, "v2/user"), { headers });
    const user = result.user as { uid?: unknown } | undefined;
    if (typeof user?.uid !== "string" || !user.uid) throw new ProviderRequestError(400, "Vercel did not confirm the token");
    return;
  }
  await vercelConfiguration(credentials);
}

/** Read current provider permissions for each event; permission-change payloads are never a grant cache. */
export async function vercelProjectAuthorized(credentials: Readonly<Record<string, string>>, projectId: string): Promise<boolean> {
  let configuration: Record<string, unknown>;
  try { configuration = await vercelConfiguration(credentials); }
  catch (failure) {
    if (failure instanceof ProviderRequestError && [400, 401, 403, 404].includes(failure.status)) return false;
    throw failure;
  }
  if (configuration.projectSelection === "all") return true;
  if (configuration.projectSelection !== "selected" || !Array.isArray(configuration.projects) ||
      !configuration.projects.every(project => typeof project === "string" && /^prj_[A-Za-z0-9]{1,80}$/u.test(project))) {
    throw new ProviderRequestError(502, "Vercel did not confirm current project permissions");
  }
  return configuration.projects.includes(projectId);
}

/**
 * Only the authenticated token response selects the configuration and team.
 * Its own token is never kept or used: the installation's first client_credentials
 * token confirms the configuration and becomes the connection's token.
 */
export async function vercelOAuthFields(client: { clientId: string; clientSecret: string }, payload: Record<string, unknown>,
  now = Date.now()): Promise<Record<string, string | null>> {
  const configuration = payload.installation_id;
  const team = payload.team_id;
  const user = team === null ? payload.user_id : null;
  if (typeof configuration !== "string" || !INSTALLATION.test(configuration) ||
      !vercelEventScopeId(team, user)) {
    throw new ProviderRequestError(400, "Vercel did not confirm the integration scope");
  }
  const scope = { oauthConfigurationId: configuration, oauthAppClientId: client.clientId,
    ...(typeof team === "string" ? { oauthTeamId: team } : {}), ...(typeof user === "string" ? { oauthUserId: user } : {}) };
  const token = (await vercelInstallationToken(client, scope, now, true))!;
  await verifyVercel({ ...scope, ...token });
  return { ...token, oauthConfigurationId: configuration, oauthAppClientId: client.clientId,
    oauthTeamId: team as string | null, oauthUserId: user as string | null };
}

/** Complete only an external installation initiated with our verified OAuth state. */
export function vercelCompletionUrl(input: { configurationId?: string; teamId?: string; next?: string },
  fields: Readonly<Record<string, string | null>>): string | undefined {
  if (input.configurationId !== fields.oauthConfigurationId || (input.teamId || null) !== (fields.oauthTeamId || null)) return undefined;
  try {
    const url = new URL(input.next ?? "");
    if (url.origin !== "https://vercel.com" || url.username || url.password) return undefined;
    return url.toString();
  } catch { return undefined; }
}
