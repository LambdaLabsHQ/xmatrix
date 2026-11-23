import { checkAppConnectorProviderConnection, type AppConnectorConnectionView } from "./app-connectors";
import { checkedConnectedAccount, verifyConnectorConnection } from "./connectors/connection-check";
import { appCommand, getAppConnection } from "./apps";
import type { Env } from "./types";
import { notifyWorkspaceResource } from "./workspace-resource-notification";

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
  let account: string | undefined;
  let message = `${String(connection.providerName)} connection check passed`;
  try {
    await checkAppConnectorProviderConnection(env, connection);
    const billing = await verifyConnectorConnection(env, input.spaceId, String(connection.providerId), input.commandId);
    if (billing) message += `; ${billing}`;
    account = await checkedConnectedAccount(env, input.spaceId, String(connection.providerId)).catch(() => undefined);
  } catch (error) {
    ok = false;
    message = error instanceof Error ? error.message.slice(0, 240) : "Connector provider check failed";
  }
  const result = await appCommand(env, "check", { commandId: input.commandId, connectionId,
    expectedVersion: connection.version, principal, ok, message, ...(account ? { account } : {}) });
  if (connection.providerId === "github") await notifyWorkspaceResource(env, { spaceId: input.spaceId,
    resource: "launch_targets" });
  return result;
}
