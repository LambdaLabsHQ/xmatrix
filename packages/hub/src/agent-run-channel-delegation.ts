import { ControlError, PostgresAgentChannelAccessRepository } from "@xmatrix/db";
import { controlErrorResponse } from "./postgres-authority-http";
import type { AgentRunPrincipal, AuthUser } from "./auth";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import type { Env } from "./types";

/**
 * An Agent Run collaborates like a person in its Space: it opens threads,
 * creates and reorganizes Channels, and edits what it wrote. It does so only
 * where the exact active Run and its current owner both have access
 * (`requireAgentChannelAccess`), and the owning authority then evaluates the
 * owner's grants. The Run never widens past its owner, and the owner's grants
 * are never widened by the Run: both must hold.
 */
export class AgentRunDelegationError extends ControlError {
  constructor(code: string, status: 400 | 403 | 404 | 409 | 503, message = code) {
    super(code, status, message, status === 503);
  }
}

export async function requireAgentRunChannelDelegation(
  env: Env,
  run: AgentRunPrincipal,
  channelIds: Array<string | undefined>,
): Promise<{ kind: "user"; id: string }> {
  if (run.runKind === "channel-about-session" || run.channelWriteAllowed === false) {
    throw new AgentRunDelegationError("agent_run_forbidden", 403, "This Agent Run cannot act in Channels");
  }
  const repository = new PostgresAgentChannelAccessRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-agent-channel-delegation", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
  const runProof = { runId: run.runId, instanceId: run.instanceId ?? "", executionKey: run.executionKey };
  // The Run's own Channel is always proven, so a Run with no target Channel
  // (a new root Channel) still proves it is live and belongs to its owner.
  for (const channelId of new Set([run.channelId, ...channelIds.filter((id): id is string => Boolean(id))])) {
    await repository.check({ requestId: crypto.randomUUID(), channelId, agentId: run.agentId, runProof });
  }
  return { kind: "user", id: run.ownerUserId };
}

/** Server-stamped attribution; any caller-supplied `createdBy*` is replaced. */
export function agentRunCreatedByMetadata(run: AgentRunPrincipal): Record<string, string> {
  return {
    createdBy: "agent",
    createdByAgentId: run.agentId,
    createdByAgentName: run.agentName,
    createdByRunId: run.runId,
  };
}

/** The delegation proof as a route answer: null when proven, else the refusal. */
export async function agentRunDelegationDenied(
  env: Env,
  run: AgentRunPrincipal,
  channelIds: Array<string | undefined>,
): Promise<Response | null> {
  try {
    await requireAgentRunChannelDelegation(env, run, channelIds);
    return null;
  } catch (error) {
    return controlErrorResponse(error);
  }
}

/**
 * Who edits or deletes a message. A Run acts as its own Agent identity, so the
 * message authority's author check lets it change only what it wrote.
 */
export async function messageMutationActor(env: Env, authUser: AuthUser, channelId: string): Promise<{
  run?: AgentRunPrincipal;
  principal: { kind: "user" | "agent"; id: string };
  from: Record<string, unknown>;
} | Response> {
  const run = authUser.agentRun;
  if (!run) {
    return {
      principal: { kind: "user", id: authUser.id },
      from: {
        identityId: `user:${authUser.id}`,
        kind: "user",
        label: authUser.name || authUser.email,
        userId: authUser.id,
        email: authUser.email,
        avatarUrl: authUser.avatarUrl,
      },
    };
  }
  const denied = await agentRunDelegationDenied(env, run, [channelId]);
  if (denied) return denied;
  return {
    run,
    principal: { kind: "agent", id: run.agentId },
    from: { identityId: run.agentId, kind: "agent", label: run.agentName, agentName: run.agentName, userId: run.ownerUserId },
  };
}
