import type { SerializedAgentInstance } from "./authority-foundation.js";
import type {
  ChannelAgentMemberPresence,
  SerializedChannel,
} from "./authority-runtime.js";

type ChannelAgentInstanceEntry = {
  memberId: string;
  presence: ChannelAgentMemberPresence;
  instance: SerializedAgentInstance;
};

/**
 * Presentation lookup only, never membership or execution authority. A message's
 * principal, a member key and an Instance ID need not have the same spelling.
 * Join by the exact global Instance ID; names and Channel ordinals are not keys.
 */
export function channelAgentInstanceIndex(
  channel: Pick<SerializedChannel, "memberPresence">,
): Map<string, ChannelAgentInstanceEntry> {
  const index = new Map<string, ChannelAgentInstanceEntry>();
  for (const [memberId, presence] of Object.entries(channel.memberPresence ?? {})) {
    if (presence.kind !== "agent") continue;
    for (const instance of presence.instances ?? []) {
      if (!instance.id) continue;
      // Prefer the catalog's canonical member if a retained legacy projection
      // also carries this Instance. Each distinct global ID remains separate.
      if (!index.has(instance.id) || memberId === instance.id) {
        index.set(instance.id, { memberId, presence, instance });
      }
    }
  }
  return index;
}
