import type { Env } from "../types";
import { runtimeRepository } from "../runtime";

/** The stable Agent identity behind a running Instance: its Space registration, not the Instance id. */
export interface AgentRegistrationIdentity { ownerUserId: string; machineId: string; harness: string }

/**
 * Resolves the registration a live Instance runs under, through its Run's
 * admission; an Instance whose Run no longer holds execution authority has none.
 */
export async function agentRegistrationOf(env: Env, input: { ownerUserId: string; instanceId: string }):
  Promise<AgentRegistrationIdentity | undefined> {
  const runtime = runtimeRepository(env);
  try {
    const { instance } = await runtime.getInstance({ requestId: crypto.randomUUID(), instanceId: input.instanceId,
      actorUserId: input.ownerUserId });
    const { registrationAdmission } = await runtime.getRun({ requestId: crypto.randomUUID(), runId: String(instance.runId),
      actorUserId: input.ownerUserId, requireExecutionAccess: true });
    const key = registrationAdmission?.key;
    return key ? { ownerUserId: key.ownerUserId, machineId: key.machineId, harness: key.harness } : undefined;
  } catch {
    return undefined;
  }
}
