import type { ChannelAboutSessionStopTarget } from "@xmatrix/db";
import type { Env } from "./types";
import {
  createProductAgentInterventionAuthorityPort,
} from "./product-agent-intervention-authority-adapter";

/**
 * End Channel About sessions through their daemons. A session has one job: it
 * reads its Channel and writes the summary once. A later trigger starts the next
 * session only after this one has ended (`channelAboutFollowUp`), so a session
 * left running would keep every later refresh waiting. About Runs post no stop
 * notice to the Channel. A failure is logged and the next trigger retries it.
 *
 * `attempt` names who is stopping: the saved summary, or the trigger that found
 * the session still running. A repeat of one attempt replays its command; the
 * next attempt issues a new one. A daemon can fail a stop (a Windows process
 * tree that changed under it), and a Machine command id is never reused, so a
 * per-Run id would refuse every later retry and leave the session running
 * (XMATRIX-HUB-4T).
 */
export async function stopChannelAboutSessions(
  env: Env,
  targets: readonly ChannelAboutSessionStopTarget[],
  reason: string,
  attempt: string,
  createPort: typeof createProductAgentInterventionAuthorityPort = createProductAgentInterventionAuthorityPort,
): Promise<void> {
  await Promise.all(targets.map(async (target) => {
    const controlId = channelAboutStopControlId(target.runId, attempt);
    const port = createPort({ env, actorUserId: target.machineOwnerUserId, sourceMessageId: controlId });
    try {
      await port.issueStop({
        instanceId: target.sessionId, runId: target.runId, agentId: target.sessionId,
        mentionTarget: "xMatrix", ownerUserId: target.machineOwnerUserId,
        machineOwnerUserId: target.machineOwnerUserId, machineId: target.machineId, hostId: target.hostId,
        ...(target.executionKey ? { executionKey: target.executionKey } : {}),
      }, controlId, reason, target.channelId);
    } catch (error) {
      console.error("Channel About session stop failed", {
        runId: target.runId, channelId: target.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
}

export function channelAboutStopControlId(runId: string, attempt: string): string {
  return `about-stop:${runId}:${attempt}`.slice(0, 200);
}
