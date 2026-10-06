import { checkAppConnectorProviderConnection, type AppConnectorConnectionView } from "./app-connectors";
import { verifyConnectorConnection } from "./connectors/connection-check";
import { appCommand, getAppConnection } from "./apps";
import type { Env } from "./types";

/**
 * The only way a connection becomes Connected: the provider is asked, and the
 * answer is recorded as `configured` or `error`. The Apps page's Check and the
 * OAuth callback both end here, so neither marks a connection it has not tried.
 */
export async function checkAppConnection(env: Env, input: {
  spaceId: string;
  providerId: string;
  userId: string;
  commandId: string;
}) {
  const principal = { kind: "user" as const, id: input.userId };
  const connectionId = `${input.spaceId}:${input.providerId.trim().toLowerCase()}`;
  const current = await getAppConnection(env, { connectionId, actorUserId: input.userId });
  const connection = current.connection as AppConnectorConnectionView & Record<string, unknown>;
  let ok = true;
  let message = `${String(connection.providerName)} connection check passed`;
  try {
    await checkAppConnectorProviderConnection(env, connection);
    await verifyConnectorConnection(env, input.spaceId, String(connection.providerId));
  } catch (error) {
    ok = false;
    message = error instanceof Error ? error.message.slice(0, 240) : "Connector provider check failed";
  }
  return appCommand(env, "check", { commandId: input.commandId, connectionId,
    expectedVersion: connection.version, principal, ok, message });
}
