import type { Env } from "../types";
import { getAppConnectorProvider } from "../app-connectors";
import { connectorCredentialRepository, INGRESS_KEY_FIELD, mintConnectorSecret } from "./credentials";
import { exchangeSentryInstallation, sentryInstallationClient } from "./sentry-installation";
import { upsertAppConnection } from "../apps";
import { ProviderRequestError } from "./http";

export async function completeSentryInstallation(env: Env, input: { spaceId: string; userId: string;
  code: string; installationId: string; organization: string; confirmed: true }) {
  if (input.confirmed !== true) throw new ProviderRequestError(400, "Confirm the organization and Space");
  const client = sentryInstallationClient(env);
  if (!client) throw new ProviderRequestError(503, "Sentry Public Integration is not configured");
  const repository = connectorCredentialRepository(env);
  // Authorize before any provider call, and again inside the final write transaction.
  await repository.readGenerated({ requestId: crypto.randomUUID(), spaceId: input.spaceId,
    providerId: "sentry", actorUserId: input.userId, generated: [] });
  await upsertAppConnection(env, { commandId: `sentry-install-prepare:${crypto.randomUUID()}`, spaceId: input.spaceId,
    providerId: "sentry", actorUserId: input.userId, body: { status: "disconnected", initializeOnly: true } })
    .catch(() => { throw new ProviderRequestError(409, "Sentry connection could not be prepared"); });
  const snapshot = await repository.beginSentryInstallation({ requestId: crypto.randomUUID(),
    spaceId: input.spaceId, actorUserId: input.userId, installation: { appClientId: client.clientId,
      installationId: input.installationId, eventScopeId: client.appUuid } });
  const fields = await exchangeSentryInstallation(client, input);
  const manifest = getAppConnectorProvider("sentry")!;
  await repository.put({ requestId: crypto.randomUUID(), spaceId: input.spaceId, providerId: "sentry",
    actorUserId: input.userId, fields, verifiedInstallation: snapshot,
    oauthInstallation: { appClientId: client.clientId, installationId: input.installationId, eventScopeId: client.appUuid },
    initialize: { [INGRESS_KEY_FIELD]: mintConnectorSecret() },
    policy: { allowed: [...(manifest.credentials ?? []).map(field => field.id), INGRESS_KEY_FIELD] },
    at: new Date().toISOString() });
  return { ok: true as const };
}
