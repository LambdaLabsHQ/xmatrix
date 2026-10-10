import { MessageAuthorityError } from "./message-authority-error.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { lockChannelLifecycle, requireChannelCapability } from "./channel-capability-policy.js";
import { requireRunRegistrationAccess } from "./agent-registration-run.js";
import { PostgresChannelSpaceDirectory, PostgresSpacePlacementDirectory } from "./placement.js";

export interface AgentChannelRunProof {
  runId: string; instanceId: string; executionKey: string;
}
export class AgentChannelAccessError extends MessageAuthorityError {
  constructor(code: string, status: number, retryable = false) { super(code, status, code, retryable); }
}

/** Channel lifecycle writers, including stop messages, precede Run locks.
 * Cross-Channel commands acquire both Channels in the same order. The admission
 * lock also prevents a starting Run from upgrading a shared Channel lock. */
export async function lockAgentRunChannels(tx: DatabaseTransaction, sourceChannelId: string,
  targetChannelId: string): Promise<void> {
  for (const channelId of [...new Set([sourceChannelId, targetChannelId])].sort()) {
    await lockChannelLifecycle(tx, { channelId, capability: "runtime_new_work" });
  }
}

/** Typed broader capability: an exact active Run may collaborate only where
 * both its current owner and Agent have access, in its existing Space. Tokens,
 * join requests and caller metadata cannot mint Channel grants. */
export async function requireAgentChannelAccess(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; agentId: string; runProof: AgentChannelRunProof;
  capability: "message_active_command_preflight" | "message_active_command" | "message_append" | "content_history_read";
}): Promise<void> {
  const proof = input.runProof;
  const hold = input.capability !== "message_active_command_preflight" && input.capability !== "content_history_read";
  if (!proof || [input.agentId, proof.runId, proof.instanceId, proof.executionKey]
    .some(value => typeof value !== "string" || !value.trim() || value.length > 300)) {
    throw new AgentChannelAccessError("agent_run_proof_required", 403);
  }
  // A Run's Instance is the actor; its registration binding places it in the Space.
  const readRun = (lock = false) => tx.query({ name: "agent_channel_registered_run_access_v2", text: `SELECT
      r.owner_user_id,r.channel_id,r.status,r.metadata_json,i.channel_id AS instance_channel_id
    FROM data.runs r JOIN data.instances i ON i.run_id=r.run_id
    JOIN data.run_agent_registrations b ON b.run_id=r.run_id AND b.owner_user_id=r.owner_user_id AND b.space_id=$3
    WHERE r.run_id=$1 AND i.instance_id=$2 AND i.instance_id=$4${lock ? " FOR SHARE OF r,i,b" : ""}`,
    values: [proof.runId, proof.instanceId, input.spaceId, input.agentId], maxRows: 1 });
  let run = (await readRun())[0];
  if (hold && run) {
    await lockAgentRunChannels(tx, String(run.channel_id), input.channelId);
    const locked = (await readRun(true))[0];
    if (locked?.channel_id !== run.channel_id) throw new AgentChannelAccessError("agent_run_forbidden", 403);
    run = locked;
  }
  const metadata = run?.metadata_json as Record<string, unknown> | undefined;
  if (!run || !["starting", "running"].includes(String(run.status)) ||
      run.channel_id !== run.instance_channel_id || metadata?.executionKey !== proof.executionKey ||
      metadata.instanceDeletion !== undefined || metadata.instanceHandoff !== undefined ||
      metadata.executionCancellation !== undefined ||
      metadata.routedAs === "management_channel_about") {
    throw new AgentChannelAccessError("agent_run_forbidden", 403);
  }
  await requireRunRegistrationAccess(tx, { runId: proof.runId, channelId: String(run.channel_id),
    phase: run.status === "starting" ? "admission" : "continuation", lock: hold ? "hold" : "none",
    error: (code, status) => new AgentChannelAccessError(code, status) });
  for (const channelId of new Set([String(run.channel_id), input.channelId])) {
    // The writer already holds both lifecycle locks in stable order. Reads
    // evaluate the current grants without retaining those locks.
    const capability = input.capability === "message_append" && channelId !== input.channelId
      ? "message_active_command" : input.capability;
    for (const principal of [{ kind: "agent" as const, id: input.agentId },
      { kind: "user" as const, id: String(run.owner_user_id) }]) {
      await requireChannelCapability(tx, { capability, channelId,
        spaceId: input.spaceId, principal,
        error: failure => new AgentChannelAccessError(failure.code, failure.status) });
    }
  }
}

/** Join is an access check, not an access grant or a move of the Run's identity. */
export class PostgresAgentChannelAccessRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new AgentChannelAccessError("cached_authority_forbidden", 500);
  }
  async check(input: { requestId: string; channelId: string; agentId: string; runProof: AgentChannelRunProof }) {
    const route = await new PostgresChannelSpaceDirectory(this.database).resolve(
      { requestId: input.requestId, operation: "agent.channel.resolve" }, input.channelId);
    if (!route) throw new AgentChannelAccessError("channel_not_found", 404);
    const placement = await new PostgresSpacePlacementDirectory(this.database).resolve(
      { requestId: input.requestId, operation: "agent.channel.access" }, route.spaceId);
    if (placement.state !== "active" || placement.targetShardId !== null) {
      throw new AgentChannelAccessError("space_placement_unavailable", 503, true);
    }
    await this.database.transaction({ requestId: input.requestId, operation: "agent.channel.access",
      placement: { spaceId: route.spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch } },
    tx => requireAgentChannelAccess(tx, { ...input, spaceId: route.spaceId, capability: "message_active_command_preflight" }));
  }
}
