import { parseRegistrationOwnerGrant, parseRegistrationSpacePolicy, type RegistrationOwnerGrant, type AgentRegistrationKey,
  type RegistrationSpacePolicy, type SpaceAgentRegistrationKey } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import { RegistrationAccessError } from "./agent-registration-errors.js";

/** A registration row's key, as `$1..$4` of a statement and as its values. */
export const REGISTRATION_KEY_SQL = "space_id=$1 AND owner_user_id=$2 AND machine_id=$3 AND harness=$4";
export const registrationKeyValues = (key: SpaceAgentRegistrationKey): string[] =>
  [key.spaceId, key.ownerUserId, key.machineId, key.harness];

/** `policy_state` stores a Space's disable as 'paused', the value its CHECK
 * accepted when Hubs still paused. The contract migration renames it to
 * 'disabled'; both read as disabled until that migration's release serves. */
export const SPACE_DISABLED_SQL = "'paused'";
export function spaceState(stored: unknown): "enabled" | "disabled" {
  if (stored === "enabled") return "enabled";
  if (stored === "paused" || stored === "disabled") return "disabled";
  throw new RegistrationAccessError("invalid_space_state", 500);
}

/** The owner grant of a `space_agent_registration_access` row. A row written
 * before execution revisions existed executes at its grant revision. */
export function registrationOwnerGrant(row: QueryResultRow): RegistrationOwnerGrant {
  return parseRegistrationOwnerGrant({ state: row.grant_state, revision: Number(row.grant_revision),
    executionRevision: Number(row.grant_execution_revision ?? row.grant_revision), limits: row.grant_limits });
}

/** The owner grant and Space policy of a `space_agent_registration_access` row. */
export function registrationAccess(row: QueryResultRow): { grant: RegistrationOwnerGrant; policy: RegistrationSpacePolicy } {
  return { grant: registrationOwnerGrant(row),
    policy: parseRegistrationSpacePolicy({ state: spaceState(row.policy_state), revision: Number(row.policy_revision),
      executionRevision: Number(row.policy_execution_revision ?? row.policy_revision), limits: row.policy_limits }) };
}

/** Physical registration identity selected from authoritative registration rows. */
export function registrationKeyFromRow(row: QueryResultRow): AgentRegistrationKey {
  return { ownerUserId: String(row.owner_user_id), machineId: String(row.machine_id), harness: String(row.harness) };
}
