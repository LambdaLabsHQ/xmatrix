import { PostgresSpaceControlRepository } from "@xmatrix/db";
import type { HumanWorkspaceResourceChangedMessage } from "@xmatrix/protocol/connections/human";

import {
  createPostgresAuthorityDatabase,
  type PostgresAuthorityFleetEnv,
} from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS, postgresAuthorityShardId } from "./postgres-authority-http";
import { publishRuntimeCommittedEvent } from "./runtime-transport/runtime-route-directory-delivery";
import type { Env } from "./types";

const WORKSPACE_RESOURCE_COMMITTED_EVENT_CHANNEL = "workspace-resource";
const RECIPIENT_BATCH = 200;
const DELIVERY_CONCURRENCY = 16;

export type WorkspaceResourceEnv = PostgresAuthorityFleetEnv & {
  RELAY_RUNTIME?: Env["RELAY_RUNTIME"];
  RELAY_RUNTIME_ROUTE_DIRECTORY?: Env["RELAY_RUNTIME_ROUTE_DIRECTORY"];
  XMATRIX_RUNTIME_CELL_MODE?: Env["XMATRIX_RUNTIME_CELL_MODE"];
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
      await publishRecipientBatches(env, audience.spaceId, event, recipientUserIds);
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

async function publishRecipientBatches(
  env: WorkspaceResourceEnv,
  spaceId: string,
  event: HumanWorkspaceResourceChangedMessage,
  recipientUserIds: readonly string[],
): Promise<void> {
  const batches: string[][] = [];
  for (let offset = 0; offset < recipientUserIds.length; offset += RECIPIENT_BATCH) {
    batches.push(recipientUserIds.slice(offset, offset + RECIPIENT_BATCH));
  }
  const publishBatch = async (recipientPrincipalIds: string[]) => {
    try {
      const response = await publishRuntimeCommittedEvent({
        env: env as Pick<Env, "RELAY_RUNTIME" | "RELAY_RUNTIME_ROUTE_DIRECTORY" | "XMATRIX_RUNTIME_CELL_MODE">,
        waitUntil: () => undefined, scopeId: spaceId,
        payload: {
          channelId: WORKSPACE_RESOURCE_COMMITTED_EVENT_CHANNEL,
          changeSeq: event.revision,
          event,
          recipientPrincipalIds,
        },
      });
      if (!response.ok) {
        throw new Error(`RelayRuntime rejected workspace resource change (${response.status})`);
      }
    } catch (error) {
      console.error("Workspace resource realtime acceleration failed", error);
    }
  };
  for (let offset = 0; offset < batches.length; offset += DELIVERY_CONCURRENCY) {
    await Promise.all(batches.slice(offset, offset + DELIVERY_CONCURRENCY).map(publishBatch));
  }
}
