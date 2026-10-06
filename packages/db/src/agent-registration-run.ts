import { parseRegistrationResourceLimits, type RegistrationResourceLimits, type SpaceAgentRegistrationKey } from "@xmatrix/protocol";
import type { DatabaseTransaction } from "./contracts.js";
import { requireRegistrationAdmission } from "./agent-registration-access.js";
import { RegistrationAccessError } from "./agent-registration-errors.js";

/** Called after the caller has proven the exact Run/Instance credential. The
 * admission snapshot is loaded from the owning shard, never from token claims,
 * daemon metadata or a Human's request. Reconnect cannot restore revoked work. */
interface RunRegistrationAccessInput {
  runId: string; channelId: string; phase: "admission" | "continuation";
  resources?: Array<{ kind: "workspaces" | "models" | "capabilities"; reference: string }>;
  error: (code: string, status: number) => Error;
  /** A caller that only reads checks the snapshot it sees and holds no rows. */
  lock?: "hold" | "none";
}

export interface RegistrationRunAdmission {
  key: SpaceAgentRegistrationKey; allocationId: string; authorizationDigest: string; resources: RegistrationResourceLimits;
}

export async function requireRunRegistrationAccess(tx: DatabaseTransaction, input: RunRegistrationAccessInput): Promise<RegistrationRunAdmission> {
  try { return await requireAccess(tx, input); }
  catch (error) {
    if (error instanceof RegistrationAccessError) throw input.error(error.code, error.status);
    throw error;
  }
}

async function requireAccess(tx: DatabaseTransaction, input: RunRegistrationAccessInput): Promise<RegistrationRunAdmission> {
  // Every Run executes under its registration binding; a Run without one has
  // no execution authority.
  const hold = input.lock !== "none";
  const rows = await tx.query({ name: hold ? "run_registration_access_binding_v3" : "run_registration_access_binding_check_v1",
    text: `SELECT b.*
    FROM data.run_agent_registrations b JOIN data.runs r ON r.run_id=b.run_id
    JOIN data.channels c ON c.channel_id=r.channel_id AND c.space_id=b.space_id
    WHERE b.run_id=$1 AND r.channel_id=$2 AND r.owner_user_id=b.owner_user_id${hold ? " FOR SHARE OF b" : ""}`,
  values: [input.runId, input.channelId], maxRows: 1 });
  const row = rows[0];
  if (!row) throw new RegistrationAccessError("registration_run_admission_missing", 403);
  const key = { spaceId: String(row.space_id), ownerUserId: String(row.owner_user_id),
    machineId: String(row.machine_id), harness: String(row.harness) };
  const requested = parseRegistrationResourceLimits(row.requested_json);
  if (input.resources?.some(resource => !requested[resource.kind].includes(resource.reference))) {
    throw new RegistrationAccessError("registration_resource_not_admitted", 403);
  }
  await requireRegistrationAdmission(tx, { key, actorUserId: String(row.actor_user_id),
    channelId: input.channelId, requested, phase: input.phase, lock: input.lock,
    fence: { key, grantRevision: Number(row.grant_revision), grantExecutionRevision: Number(row.grant_execution_revision),
      policyRevision: Number(row.policy_revision), policyExecutionRevision: Number(row.policy_execution_revision) } });
  return { key, allocationId: String(row.allocation_id), authorizationDigest: String(row.authorization_digest), resources: requested };
}
