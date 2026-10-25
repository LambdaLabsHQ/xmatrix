import { overlayAgentPresenceOnChannel } from "../../src/runtime-transport/agent-instance-live-presentation.ts";

/**
 * Each Channel as a status report from these live Instances leaves it: the
 * production overlay of one report per Instance, over the Instances the
 * Channel's read already holds.
 */
export function overlayLiveInstances(channels, sessions) {
  return channels.map((channel) => sessions.filter((session) => session.channelId === channel.id)
    .reduce((overlaid, session) => overlayAgentPresenceOnChannel(overlaid, {
      reason: "update",
      session: {
        principal: { ownerUserId: session.ownerUserId, agentId: session.agentId, agentName: session.agentName,
          runId: session.runId, channelId: session.channelId },
        run: { runId: session.runId, agentId: session.agentId, instanceId: session.instanceId,
          channelId: session.channelId, ...(session.channelInstanceId ? { channelInstanceId: session.channelInstanceId } : {}),
          machineId: session.machineId, hostId: session.hostId, ...(session.cwd ? { cwd: session.cwd } : {}),
          status: "running", instanceStatus: session.status },
        connectedAt: session.connectedAt, lastSeenAt: session.lastSeenAt,
        ...(session.presentation ? { presentation: session.presentation } : {}),
      },
      status: session.status,
    }), channel));
}
