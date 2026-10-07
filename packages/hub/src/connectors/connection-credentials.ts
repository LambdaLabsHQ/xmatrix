import { getAppConnectorProvider } from "../app-connectors";
import type { Env } from "../types";
import { connectorCredentialRepository } from "./credentials";
import { verifyNotion } from "./actions/notion";
import { ProviderRequestError } from "./http";
import { refreshOAuthFields } from "./oauth";

/** Refresh and verify Notion OAuth before any action, without replaying writes. */
export async function connectionCredentials(env: Env, spaceId: string, providerId: string):
  Promise<Record<string, string>> {
  const repository = connectorCredentialRepository(env);
  const resolved = await repository.resolve({ requestId: crypto.randomUUID(), spaceId, providerId });
  const credentials: Record<string, string> = { ...resolved?.values };
  const notionOAuth = providerId === "notion" && !!credentials.oauthRefreshToken;
  let refreshed = await refreshOAuthFields(env, providerId, credentials).catch(error => {
    if (notionOAuth || ["google", "googlesearchconsole", "bitbucket", "pagerduty", "sentry", "discord"].includes(providerId)) throw error;
    return undefined;
  });
  const persist = async (fields: Record<string, string | null>) => {
    const manifest = getAppConnectorProvider(providerId);
    await repository.put({ requestId: crypto.randomUUID(), spaceId, providerId, actorUserId: "hub:oauth-refresh",
      fields, policy: { allowed: (manifest?.credentials ?? []).map((field) => field.id) },
      at: new Date().toISOString(), asHub: true, expectedVersion: resolved?.version });
    for (const [name, value] of Object.entries(fields)) {
      if (value === null) delete credentials[name];
      else credentials[name] = value;
    }
  };
  // Save a complete rotated pair before another provider call can time out.
  if (refreshed) await persist(refreshed);
  if (notionOAuth) {
    try {
      await verifyNotion(credentials);
    } catch (error) {
      // Only an authenticated read's 401 warrants one rotation. Writes are never retried.
      if (refreshed || !(error instanceof ProviderRequestError) || error.status !== 401) throw error;
      refreshed = await refreshOAuthFields(env, providerId, credentials, Date.now(), { notionUnauthorized: true });
      if (!refreshed) throw error;
      await persist(refreshed);
      await verifyNotion(credentials);
    }
  }
  return credentials;
}
