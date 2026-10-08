import { ServiceUnavailable } from "./error-contract";
import type { Env } from "./types";
import type { ScheduledStep } from "./postgres-agent-launch-schedule";

/**
 * Tell a Channel's coordinator it has new work: a prepared reborn, a stopped
 * predecessor, a committed terminal report. The caller awaits it before
 * answering, so a failure fails the request and its retry wakes again.
 */
export async function wakeAgentLaunchCoordinator(env: Pick<Env, "RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL">,
  channelId: string, work: readonly ScheduledStep[]): Promise<void> {
  // A thrown wake (the coordinator reset by a deploy) is the same handover
  // failure as a refused one: the committed work waits for the retry.
  const response = await wakeAgentLaunchChannel(env.RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL, { channelId, work })
    .catch(() => { throw new AgentLaunchHandoverUnavailable(); });
  if (!response.ok) throw new AgentLaunchHandoverUnavailable(response.status);
}

/** The Channel coordinator could not be told about committed work. The
 *  request that committed it must fail so its idempotent retry tells it. */
export class AgentLaunchHandoverUnavailable extends ServiceUnavailable {
  constructor(status?: number) {
    super("agent_launch_handover_unavailable",
      `Agent Launch Channel coordinator is unavailable${status ? ` (${status})` : ""}`);
  }
}

/**
 * Wake one Channel's Launch coordinator. `work` names the kinds of work the
 * event may have moved; the pass runs those and whatever else is due. Work
 * the Channel's due read already sees (a new Launch, report or intent) needs
 * no name; name what it cannot see — an authority change to re-check, a host
 * back for its parked stops — or what must run before its due time. A wake
 * that names nothing (a sweep or handover) runs every kind.
 */
export async function wakeAgentLaunchChannel(channels: DurableObjectNamespace | undefined,
  target: { channelId: string; launchIds?: readonly string[]; shardId?: string;
    work?: readonly ScheduledStep[] }): Promise<Response> {
  if (!channels) throw new AgentLaunchHandoverUnavailable();
  return channels.get(channels.idFromName(target.channelId)).fetch("https://agent-launch.internal/wake", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId: target.channelId, launchIds: target.launchIds ?? [],
      ...(target.shardId ? { shardId: target.shardId } : {}),
      ...(target.work ? { work: target.work } : {}) }),
  });
}
