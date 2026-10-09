import { getAppConnectorProvider } from "../app-connectors";
import type { Env } from "../types";
import { deleteComposioAccount } from "./composio";
import { connectorCredentialRepository } from "./credentials";
import { grantFieldsForgottenOnDisconnect, oauthClient } from "./oauth";

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
