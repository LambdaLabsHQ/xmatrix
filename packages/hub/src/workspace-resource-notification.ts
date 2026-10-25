import { PostgresSpaceControlRepository } from "@xmatrix/db";
import type { HumanWorkspaceResourceChangedMessage } from "@xmatrix/protocol/connections/human";

import {
  createPostgresAuthorityDatabase,
  type PostgresAuthorityFleetEnv,
} from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS, postgresAuthorityShardId } from "./postgres-authority-http";
import {
  deliverToAudience,
  RUNTIME_COMMITTED_EVENT_URL,
  runtimeJsonRequest,
} from "./runtime-transport/runtime-principal-delivery";
import type { Env } from "./types";

const WORKSPACE_RESOURCE_COMMITTED_EVENT_CHANNEL = "workspace-resource";

export type WorkspaceResourceEnv = PostgresAuthorityFleetEnv & {
  RELAY_RUNTIME?: Env["RELAY_RUNTIME"];
  XMATRIX_RUNTIME_LOCATION_HINT?: Env["XMATRIX_RUNTIME_LOCATION_HINT"];
};

/**
 * Tells the named principals to re-read one workspace list. The mutation has
 * already committed. An empty alarm tick must not call this: the frame is the
 * thing that lets the web client stop polling.
 */
export async function notifyWorkspaceResource(env: WorkspaceResourceEnv, input: {
  spaceId?: string;
  spaceIds?: readonly string[];
  resource: HumanWorkspaceResourceChangedMessage["resource"];
  channelId?: string;
  recipientUserIds?: readonly string[];
}): Promise<void> {
  if (!env.RELAY_RUNTIME) return;
  const spaceIds = [...new Set([input.spaceId, ...(input.spaceIds ?? [])]
    .map((spaceId) => spaceId?.trim() ?? "")
    .filter((spaceId) => spaceId.length > 0))];
  if (spaceIds.length === 0) return;
  const channelId = input.channelId?.trim();
  try {
    const audiences = input.recipientUserIds
      ? spaceIds.map((spaceId) => ({ spaceId, recipientUserIds: input.recipientUserIds! }))
      : await spaceMemberAudiences(env, spaceIds);
    const revision = Math.max(1, Date.now());
    for (const audience of audiences) {
      const recipientUserIds = [...new Set(audience.recipientUserIds.filter((id) => id.length > 0))];
      if (recipientUserIds.length === 0) continue;
      const event: HumanWorkspaceResourceChangedMessage = {
        type: "workspace_resource_changed",
        spaceId: audience.spaceId,
        resource: input.resource,
        revision,
        ...(channelId ? { channelId } : {}),
      };
      await publishToRecipients(env, event, recipientUserIds);
    }
  } catch (error) {
    console.error("Workspace resource realtime acceleration failed", error);
  }
}

async function spaceMemberAudiences(env: WorkspaceResourceEnv, spaceIds: readonly string[]) {
  const shardId = postgresAuthorityShardId(env, "Workspace resource notification");
  const database = createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-workspace-resource", ...POSTGRES_AUTHORITY_TIMEOUTS,
  });
  const repository = new PostgresSpaceControlRepository(database, shardId);
  const changes = await repository.channelCatalogChangeAudiences({
    requestId: crypto.randomUUID(), spaceIds,
  });
  return changes.map((change) => ({
    spaceId: change.spaceId, recipientUserIds: change.recipientUserIds,
  }));
}

/** Tells each recipient, in their own cell, to re-read one workspace list. */
async function publishToRecipients(
  env: WorkspaceResourceEnv,
  event: HumanWorkspaceResourceChangedMessage,
  recipientUserIds: readonly string[],
): Promise<void> {
  if (!env.RELAY_RUNTIME) return;
  try {
    await deliverToAudience({
      env: env as Pick<Env, "RELAY_RUNTIME" | "XMATRIX_RUNTIME_LOCATION_HINT">,
      label: "Workspace resource", audience: { humans: recipientUserIds },
      request: (share) => runtimeJsonRequest(RUNTIME_COMMITTED_EVENT_URL, {
        channelId: WORKSPACE_RESOURCE_COMMITTED_EVENT_CHANNEL,
        changeSeq: event.revision,
        event,
        recipientPrincipalIds: [share.owner],
      }),
    });
  } catch (error) {
    console.error("Workspace resource realtime acceleration failed", error);
  }
}
