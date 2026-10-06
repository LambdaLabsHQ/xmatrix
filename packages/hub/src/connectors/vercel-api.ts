import { providerJson, providerUrl, ProviderRequestError } from "./http";

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
  if (!credentials.oauthToken || !id || !/^icfg_[A-Za-z0-9]{1,80}$/u.test(id) || !appId) {
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

/** Only the authenticated token response selects the configuration and team. */
export async function vercelOAuthFields(clientId: string, payload: Record<string, unknown>): Promise<Record<string, string | null>> {
  const configuration = payload.installation_id;
  const team = payload.team_id;
  const user = team === null ? payload.user_id : null;
  if (typeof configuration !== "string" || !/^icfg_[A-Za-z0-9]{1,80}$/u.test(configuration) ||
      !vercelEventScopeId(team, user)) {
    throw new ProviderRequestError(400, "Vercel did not confirm the integration scope");
  }
  const values = { oauthToken: String(payload.access_token), oauthConfigurationId: configuration,
    oauthAppClientId: clientId, ...(typeof team === "string" ? { oauthTeamId: team } : {}),
    ...(typeof user === "string" ? { oauthUserId: user } : {}) };
  await verifyVercel(values);
  return { oauthConfigurationId: configuration, oauthAppClientId: clientId,
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
