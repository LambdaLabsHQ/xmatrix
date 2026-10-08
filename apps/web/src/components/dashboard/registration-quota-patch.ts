import {
  sameAgentRegistration,
  withRegistrationQuota,
  type AgentRegistrationKey,
  type LlmUsage,
  type SerializedChannel,
} from "@xmatrix/protocol";

/**
 * A registration's new quota reading (the `registration_quota` frame), applied
 * the way a Channel read projects it: every Agent shown under the
 * registration, and each of its Instances, takes the account fields and keeps
 * its own counters. Channels the reading does not change come back as they
 * were, so an unchanged reading renders nothing.
 */
export function patchChannelsRegistrationQuota(
  channels: SerializedChannel[],
  registration: AgentRegistrationKey,
  quota: LlmUsage
): SerializedChannel[] {
  const project = (usage: LlmUsage | undefined) => {
    const next = withRegistrationQuota(usage, quota);
    return JSON.stringify(next) === JSON.stringify(usage) ? usage : next;
  };
  let changed = false;
  const next = channels.map((channel) => {
    let memberPresence = channel.memberPresence;
    for (const [member, presence] of Object.entries(channel.memberPresence ?? {})) {
      if (presence.kind !== "agent" || !presence.registration ||
          !sameAgentRegistration(presence.registration, registration)) continue;
      const usage = project(presence.usage);
      const instances = presence.instances?.map((instance) => {
        const instanceUsage = project(instance.usage);
        return instanceUsage === instance.usage ? instance : { ...instance, usage: instanceUsage };
      });
      const instancesChanged = instances?.some((instance, index) => instance !== presence.instances?.[index]) ?? false;
      if (usage === presence.usage && !instancesChanged) continue;
      memberPresence = { ...memberPresence, [member]: { ...presence, usage, ...(instances ? { instances } : {}) } };
    }
    if (memberPresence === channel.memberPresence) return channel;
    changed = true;
    return { ...channel, memberPresence };
  });
  return changed ? next : channels;
}
