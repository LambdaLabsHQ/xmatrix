import type { ChannelCatalogChangeAudience } from "@xmatrix/db";
import type { HumanChannelCatalogChangedMessage } from "@xmatrix/protocol/connections/human";
import { publishRuntimeCommittedEvent } from "./runtime-transport/runtime-route-directory-delivery";
import type { Env } from "./types";

const CHANNEL_CATALOG_COMMITTED_EVENT_CHANNEL = "space-channel-catalog";
const CHANNEL_CATALOG_RECIPIENT_BATCH = 200;
const CHANNEL_CATALOG_DELIVERY_CONCURRENCY = 16;

export async function relayChannelCatalogPublishCommittedChanges(input: {
  env: Pick<Env, "RELAY_RUNTIME" | "RELAY_RUNTIME_ROUTE_DIRECTORY" |
    "XMATRIX_RUNTIME_CELL_MODE">;
  changes: readonly ChannelCatalogChangeAudience[];
}): Promise<void> {
  for (const change of input.changes) {
    const event: HumanChannelCatalogChangedMessage = {
      type: "space_channel_catalog_changed",
      spaceId: change.spaceId,
      revision: change.revision,
    };
    const batches: string[][] = [];
    for (let offset = 0; offset < change.recipientUserIds.length;
      offset += CHANNEL_CATALOG_RECIPIENT_BATCH) {
      batches.push(change.recipientUserIds.slice(
        offset, offset + CHANNEL_CATALOG_RECIPIENT_BATCH,
      ));
    }
    const publishBatch = async (recipientPrincipalIds: string[]) => {
      try {
        const response = await publishRuntimeCommittedEvent({
          env: input.env,
          waitUntil: () => undefined,
          scopeId: change.spaceId,
          payload: {
            channelId: CHANNEL_CATALOG_COMMITTED_EVENT_CHANNEL,
            changeSeq: change.revision,
            event,
            recipientPrincipalIds,
          },
        });
        if (!response.ok) {
          throw new Error(`RelayRuntime rejected Channel catalog change (${response.status})`);
        }
      } catch (error) {
        // The mutation is already authoritative and durable. This frame is only
        // realtime acceleration; reconnect/page revision observation repairs it.
        console.error("Channel catalog realtime acceleration failed", error);
      }
    };
    for (let offset = 0; offset < batches.length;
      offset += CHANNEL_CATALOG_DELIVERY_CONCURRENCY) {
      await Promise.all(
        batches.slice(offset, offset + CHANNEL_CATALOG_DELIVERY_CONCURRENCY).map(publishBatch),
      );
    }
  }
}
