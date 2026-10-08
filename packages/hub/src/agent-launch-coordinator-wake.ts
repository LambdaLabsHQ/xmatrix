import type { Env } from "./types";

/**
 * Tell a Channel's coordinator it has new work: a prepared reborn, a stopped
 * predecessor, a committed terminal report. The caller awaits it before
 * answering, so a failure fails the request and its retry wakes again.
 */
export async function wakeAgentLaunchCoordinator(env: Pick<Env, "RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL">,
  channelId: string): Promise<void> {
  // A thrown wake (the coordinator reset by a deploy) is the same handover
  // failure as a refused one: the committed work waits for the retry.
  const response = await wakeAgentLaunchChannel(env.RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL, { channelId })
    .catch(() => { throw new AgentLaunchHandoverUnavailable(); });
  if (!response.ok) throw new AgentLaunchHandoverUnavailable(response.status);
}

/** The Channel coordinator could not be told about committed work. The
 *  request that committed it must fail so its idempotent retry tells it. */
export class AgentLaunchHandoverUnavailable extends Error {
  readonly code = "agent_launch_handover_unavailable";
  constructor(status?: number) {
    super(`Agent Launch Channel coordinator is unavailable${status ? ` (${status})` : ""}`);
  }
}

/** Wake one Channel's Launch coordinator. A sweep wake names no Launch. */
export async function wakeAgentLaunchChannel(channels: DurableObjectNamespace | undefined,
  target: { channelId: string; launchIds?: readonly string[]; shardId?: string }): Promise<Response> {
  if (!channels) throw new AgentLaunchHandoverUnavailable();
  return channels.get(channels.idFromName(target.channelId)).fetch("https://agent-launch.internal/wake", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId: target.channelId, launchIds: target.launchIds ?? [],
      ...(target.shardId ? { shardId: target.shardId } : {}) }),
  });
}
