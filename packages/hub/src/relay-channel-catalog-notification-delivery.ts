import type { ChannelCatalogChangeAudience } from "@xmatrix/db";
import type { HumanChannelCatalogChangedMessage } from "@xmatrix/protocol/connections/human";
import {
  deliverToAudience,
  RUNTIME_COMMITTED_EVENT_URL,
  runtimeJsonRequest,
  type RuntimeLiveDeliverySelf,
} from "./runtime-transport/runtime-principal-delivery";
import type { Env } from "./types";

const CHANNEL_CATALOG_COMMITTED_EVENT_CHANNEL = "space-channel-catalog";

/** Tells each member of the changed Spaces, in their own cell, that its Channel catalog moved. */
export async function relayChannelCatalogPublishCommittedChanges(input: {
  env: Pick<Env, "RELAY_RUNTIME" | "XMATRIX_RUNTIME_LOCATION_HINT">;
  changes: readonly ChannelCatalogChangeAudience[];
  self?: RuntimeLiveDeliverySelf;
}): Promise<void> {
  for (const change of input.changes) {
    const event: HumanChannelCatalogChangedMessage = {
      type: "space_channel_catalog_changed",
      spaceId: change.spaceId,
      revision: change.revision,
    };
    try {
      await deliverToAudience({
        env: input.env, label: "Channel catalog", audience: { humans: change.recipientUserIds },
        ...(input.self ? { self: input.self } : {}),
        request: (share) => runtimeJsonRequest(RUNTIME_COMMITTED_EVENT_URL, {
          channelId: CHANNEL_CATALOG_COMMITTED_EVENT_CHANNEL,
          changeSeq: change.revision,
          event,
          recipientPrincipalIds: [share.owner],
        }),
      });
    } catch (error) {
      // The mutation is already authoritative and durable. This frame is only
      // realtime acceleration; reconnect/page revision observation repairs it.
      console.error("Channel catalog realtime acceleration failed", error);
    }
  }
}
