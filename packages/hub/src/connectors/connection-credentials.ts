import { getAppConnectorProvider } from "../app-connectors";
import type { Env } from "../types";
import { connectorCredentialRepository } from "./credentials";
import { verifyNotion } from "./actions/notion";
import { ProviderRequestError } from "./http";
import { deleteComposioAccount } from "./composio";
import { grantFieldsForgottenOnDisconnect, oauthClient, refreshOAuthFields } from "./oauth";
import { isSentryInstallationGrant, verifySentryInstallation } from "./sentry-installation";

/**
 * Grants whose saved token can be lost while still unexpired: Notion revokes on reauthorization, and a
 * Sentry installation keeps one token, so a concurrent or lost refresh leaves the saved one deleted.
 */
function grantVerifier(providerId: string, credentials: Readonly<Record<string, string>>):
  ((values: Readonly<Record<string, string>>) => Promise<void>) | undefined {
  if (providerId === "notion" && credentials.oauthRefreshToken) return verifyNotion;
  if (providerId === "sentry" && isSentryInstallationGrant(credentials)) return verifySentryInstallation;
}

/** Refresh and verify Notion OAuth and Sentry installations before any action, without replaying writes. */
export async function connectionCredentials(env: Env, spaceId: string, providerId: string):
  Promise<Record<string, string>> {
  const repository = connectorCredentialRepository(env);
  const resolved = await repository.resolve({ requestId: crypto.randomUUID(), spaceId, providerId });
  const credentials: Record<string, string> = { ...resolved?.values };
  const verify = grantVerifier(providerId, credentials);
  let refreshed = await refreshOAuthFields(env, providerId, credentials).catch(error => {
    if (verify || ["google", "googlesearchconsole", "googleadsense", "gcp", "bitbucket", "pagerduty", "sentry", "discord"].includes(providerId)) throw error;
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
  if (verify) {
    try {
      await verify(credentials);
    } catch (error) {
      // Only an authenticated read's 401 warrants one rotation. Writes are never retried.
      if (refreshed || !(error instanceof ProviderRequestError) || error.status !== 401) throw error;
      refreshed = await refreshOAuthFields(env, providerId, credentials, Date.now(), { unauthorized: true });
      if (!refreshed) throw error;
      await persist(refreshed);
      await verify(credentials);
    }
  }
  /* A Composio connection stores only its account id; the project key stays a Hub secret, read per call. */
  if (getAppConnectorProvider(providerId)?.oauth?.flow === "composio") {
    credentials.composioApiKey = oauthClient(env, providerId)?.clientSecret ?? "";
  }
  return credentials;
}

/**
 * Disconnect deletes the grant a Google or Composio connection holds; a Composio account is deleted
 * at Composio first, so the Google grant it keeps there goes too. No-op for other providers.
 */
export async function forgetConnectionGrant(env: Env, input: { spaceId: string; providerId: string; actorUserId: string }):
  Promise<void> {
  const fields = grantFieldsForgottenOnDisconnect(input.providerId);
  if (!fields) return;
  const repository = connectorCredentialRepository(env);
  if (getAppConnectorProvider(input.providerId)?.oauth?.flow === "composio") {
    const stored = await repository.resolve({ requestId: crypto.randomUUID(), spaceId: input.spaceId, providerId: input.providerId });
    const accountId = stored?.values.composioAccountId;
    if (accountId) await deleteComposioAccount(oauthClient(env, input.providerId)?.clientSecret ?? "", accountId);
  }
  await repository.put({ requestId: crypto.randomUUID(), ...input, fields,
    policy: { allowed: Object.keys(fields) }, at: new Date().toISOString() });
}
