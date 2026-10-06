// The HTTP route gate an Agent Run's credential passes through.
import { agentRunHttpRouteAllowed } from "../../src/index-shared.ts";

/** owner-1's claude Run run-1, Instance instance-1 in channel-1 of space-1, with no extra permissions. */
export const AGENT_RUN = {
  ownerUserId: "owner-1", agentId: "agent-1", agentName: "claude", runId: "run-1",
  executionKey: "execution-1", instanceId: "instance-1", spaceId: "space-1", channelId: "channel-1",
  machineId: "machine-1", hostId: "host-1", permissions: [],
};

/** Whether an Agent Run may call `method path` with its own credential. */
export function agentRunAllowed(method, path, principal = AGENT_RUN) {
  return agentRunHttpRouteAllowed(new Request(`https://hub.test${path}`, { method }), principal);
}
