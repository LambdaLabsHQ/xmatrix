import {
  reduceChannelPresence, sameAgentRegistration,
  withRegistrationQuota,
  type AgentRegistrationKey,
  type LlmUsage,
  type ChannelSnapshot,
} from "@xmatrix/protocol";
import { sameValue } from "../../lib/same-value";

/**
 * A registration's new quota reading (the `registration_quota` frame), applied
 * the way a Channel read projects it: every Agent shown under the
 * registration, and each of its Instances, takes the account fields and keeps
 * its own counters. Channels the reading does not change come back as they
 * were, so an unchanged reading renders nothing.
 */
export function patchChannelsRegistrationQuota(
  channels: ChannelSnapshot[],
  registration: AgentRegistrationKey,
  quota: LlmUsage
): ChannelSnapshot[] {
  const project = (usage: LlmUsage | undefined) => {
    const next = withRegistrationQuota(usage, quota);
    return sameValue(next, usage) ? usage : next;
  };
  let changed = false;
  const next = channels.map((channel) => {
    let presence = channel.presence;
    if (!presence) return channel;
    for (const instance of presence.instances.values()) {
      if (!instance.registration || !sameAgentRegistration(instance.registration, registration)) continue;
      const usage = project(instance.usage);
      if (!usage || usage === instance.usage) continue;
      presence = reduceChannelPresence(presence, { type: "quota", instanceId: instance.id, usage });
    }
    if (presence === channel.presence) return channel;
    changed = true;
    return { ...channel, presence };
  });
  return changed ? next : channels;
}
