import { retryablePostgresFailure } from "../postgres-error-classification";

/** What an Agent Instance socket reads and changes of its own Run and Instance. */
export interface AgentInstanceRuntime {
  /** The Run as its owner reads it. */
  getRun(input: { runId: string; ownerUserId: string }): Promise<Record<string, unknown>>;
  /** One Instance connect, transition, handoff fence or presentation. */
  transition(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Records that the Instance's harness hit its usage limit, so the Channel hands off. */
  holdUsageLimit(input: { commandId: string; actorUserId: string; channelId: string;
    sourceInstanceId: string; resetsAt?: string }): Promise<unknown>;
}

/**
 * Reads the Run a credential names, as its owner. Only an outage the driver
 * says a replay can survive is read again, never a rejection, and never with
 * a prior Run snapshot.
 */
export async function queryAgentInstanceRun(
  runtime: Pick<AgentInstanceRuntime, "getRun">,
  binding: { runId: string; ownerUserId: string },
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runtime.getRun({ runId: binding.runId, ownerUserId: binding.ownerUserId });
    } catch (error) {
      if (!retryablePostgresFailure(error) || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 100 : 250));
    }
  }
}
