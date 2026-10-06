import {
  isLiveAgentStatus,
  type ChannelMemberPresence,
  type SerializedAgent,
} from "@xmatrix/protocol";

const MAX_LISTED_LIVE_AGENTS = 512;

/**
 * The online-agent list, from the Postgres presence projection. One row per
 * live Instance. Activity and the other runtime-only fields are absent until
 * a presence frame arrives.
 */
export function serializedAgentsFromPresence(
  byChannel: ReadonlyMap<string, Record<string, ChannelMemberPresence>>,
): SerializedAgent[] {
  const agents: SerializedAgent[] = [];
  for (const [channelId, members] of byChannel) {
    for (const presence of Object.values(members)) {
      if (presence.kind !== "agent") continue;
      for (const instance of presence.instances ?? []) {
        if (!isLiveAgentStatus(instance.status)) continue;
        agents.push({
          id: instance.id,
          instanceId: instance.id,
          ...(instance.channelInstanceId ? { channelInstanceId: instance.channelInstanceId } : {}),
          userId: presence.registration?.ownerUserId ?? "",
          name: presence.label || instance.label,
          type: "agent",
          lifetime: "short",
          email: presence.email ?? "",
          metadata: { channelId },
          connectedAt: instance.connectedAt,
          lastSeenAt: instance.lastSeenAt,
          status: instance.status,
          ...(instance.offlineReason ? { offlineReason: instance.offlineReason } : {}),
          ...(presence.avatarUrl ? { avatarUrl: presence.avatarUrl } : {}),
          ...(instance.model ? { model: instance.model } : {}),
          ...(instance.usage ? { usage: instance.usage } : {}),
          instances: [instance],
        });
      }
    }
  }
  agents.sort((left, right) =>
    left.name.localeCompare(right.name) ||
    String(left.instanceId || "").localeCompare(String(right.instanceId || "")));
  return agents.slice(0, MAX_LISTED_LIVE_AGENTS);
}
