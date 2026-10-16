import { ControlError } from "@xmatrix/db";
import type { AgentRunPrincipal, AuthUser } from "./auth";

export type JevEvaluationScope = { ownerUserId: string; spaceId: string };

/** Resolve current server authority before any operator-paid evaluation. */
export async function jevEvaluationScope(user: AuthUser, requestedSpaceId: string | null,
  revalidateRun: () => Promise<AgentRunPrincipal>,
  readPlan: (spaceId: string, userId: string) => Promise<"free" | "pro">,
  metered: boolean): Promise<JevEvaluationScope> {
  const denied = () => new ControlError("jev_access_denied", 403,
    "Jev evaluation requires a Pro Space membership or a live Agent Run");
  if (user.agentRun) {
    const run = await revalidateRun();
    if (!run.spaceId || !run.ownerUserId || (requestedSpaceId !== null && requestedSpaceId !== run.spaceId)) throw denied();
    return { ownerUserId: run.ownerUserId, spaceId: run.spaceId };
  }
  if (!requestedSpaceId || requestedSpaceId.length > 300) throw denied();
  // The billing authority checks current Space membership; a caller's header
  // selects a candidate, never grants access to it or proves its plan.
  const plan = await readPlan(requestedSpaceId, user.id);
  if (metered && plan !== "pro") throw denied();
  return { ownerUserId: user.id, spaceId: requestedSpaceId };
}
