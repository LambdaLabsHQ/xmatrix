import { completeRegistrationAccessChanges } from "./agent-registration-revocation.js";
import { registrationResourcesWithinOwnerScope } from "./registration-repository-authority.js";
import { parseSpaceAgentRegistrationKey, parseRegistrationResourceLimits,
  parseRegistrationOwnerGrant, registrationLimitsWithin,
  registrationExecutionPermissionsPreserved,
  validateRegistrationAdmission, sha256Hex, type RegistrationAdmissionFence,
  type SpaceAgentRegistrationKey, type RegistrationResourceLimits, type RegistrationOwnerGrant } from "@xmatrix/protocol";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabasePlacementContext } from "./context.js";
import { requireChannelCapability } from "./channel-capability-policy.js";
import { RegistrationAccessError } from "./agent-registration-errors.js";
import { REGISTRATION_KEY_SQL, SPACE_DISABLED_SQL, registrationAccess, registrationKeyValues } from "./agent-registration-rows.js";
export { RegistrationAccessError } from "./agent-registration-errors.js";

const empty: RegistrationResourceLimits = { workspaces: [], models: [], capabilities: [] };

/** Called inside the same transaction that reserves/acknowledges a startup.
 * There is deliberately no fallback to a legacy Profile when a grant is absent. */
export async function requireRegistrationAdmission(tx: DatabaseTransaction, input: {
  key: SpaceAgentRegistrationKey; actorUserId: string; channelId: string;
  requested: RegistrationResourceLimits; fence?: RegistrationAdmissionFence;
  phase?: "admission" | "continuation";
  /** `none` checks the same rules without holding the Channel, member or
   * access rows, for a caller that starts and changes nothing. */
  lock?: "hold" | "none";
}) {
  const key = parseSpaceAgentRegistrationKey(input.key);
  const hold = input.lock !== "none";
  await requireChannelCapability(tx, { capability: !hold ? "runtime_check"
    : input.phase === "continuation" ? "runtime_continue" : "runtime_new_work",
    channelId: input.channelId, spaceId: key.spaceId, principal: { kind: "user", id: input.actorUserId },
    error: failure => new RegistrationAccessError(failure.code, failure.status),
  });
  const share = hold ? " FOR SHARE" : "";
  const members = await tx.query({ name: hold ? "registration_admission_members_v2" : "registration_admission_members_check_v1",
    text: `SELECT user_id,role
    FROM data.space_members WHERE space_id=$1 AND user_id=ANY($2::text[]) ORDER BY user_id${share}`,
  values: [key.spaceId, [...new Set([key.ownerUserId, input.actorUserId])]], maxRows: 2 });
  const rows = await tx.query({ name: hold ? "registration_admission_access_v1" : "registration_admission_access_check_v1",
    text: `SELECT *
    FROM data.space_agent_registration_access WHERE ${REGISTRATION_KEY_SQL}${share}`, values: registrationKeyValues(key), maxRows: 1 });
  if (!rows[0]) throw new RegistrationAccessError("registration_not_granted", 403);
  const decision = validateRegistrationAdmission({ key, ...registrationAccess(rows[0]),
    ownerIsMember: members.some(member => member.user_id === key.ownerUserId),
    // A participant brings their own Agents on their own budget; only members start the project's
    // (docs/design/open-project-governance.md §2).
    callerMayLaunch: members.some(member => member.user_id === input.actorUserId &&
      (["owner", "admin", "member"].includes(String(member.role)) ||
        (member.role === "participant" && input.actorUserId === key.ownerUserId))),
    requested: registrationResourcesWithinOwnerScope(input.requested), phase: input.phase,
    ...(input.fence ? { fence: input.fence } : {}) });
  if (!decision.allowed) throw new RegistrationAccessError(`registration_${decision.reason}`, 403);
  return decision;
}


/** The Hub must bind actorUserId to its authenticated human principal. Agent Runs
 * have no implicit capability to call these permission mutation methods. */
export class PostgresRegistrationAccessRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly placement: DatabasePlacementContext) {
    if (database.cacheMode !== "disabled") throw new RegistrationAccessError("cached_authority_forbidden", 500);
  }

  /** The owner's grant of a registration to this Space. A Space has no pause:
   * its owner/admins remove an agent (revoke) and its owner adds it back. */
  async change(input: { key: SpaceAgentRegistrationKey; actorUserId: string; commandId: string;
    expectedRevision: number; state: "active" | "revoked"; limits: RegistrationResourceLimits }) {
    const key = parseSpaceAgentRegistrationKey(input.key);
    if (key.spaceId !== this.placement.spaceId) throw new RegistrationAccessError("registration_not_found", 404);
    const limits = parseRegistrationResourceLimits(input.limits);
    if (!input.actorUserId || input.actorUserId.length > 300 || !input.commandId || input.commandId.length > 200 ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new RegistrationAccessError("invalid_access_command", 400);
    }
    parseRegistrationOwnerGrant({ revision: input.expectedRevision, executionRevision: input.expectedRevision,
      state: input.state, limits });
    // `authority` stays in the digest so a replay recorded before Space pause
    // was removed still matches.
    const hash = await sha256Hex(JSON.stringify({ key, authority: "owner",
      expectedRevision: input.expectedRevision, state: input.state, limits }));
    return this.database.transaction({ requestId: input.commandId, operation: "registration.access.change",
      placement: this.placement }, async tx => {
      // Authorization is current even for a replay; a former admin cannot use a
      // remembered command to regain visibility or grant access after removal.
      const ownerActing = await requireAuthority(tx, key, input.actorUserId, input.state);
      const registration = await tx.query({ name: "registration_access_registration_lock_v1", text: `SELECT version
        FROM data.space_agent_registrations WHERE ${REGISTRATION_KEY_SQL} FOR UPDATE`, values: registrationKeyValues(key), maxRows: 1 });
      if (!registration[0]) throw new RegistrationAccessError("registration_not_found", 404);
      const prior = await replayed(tx, input.actorUserId, input.commandId, hash);
      if (prior) return prior;
      await tx.query({ name: "registration_access_initialize_v2", text: `INSERT INTO data.space_agent_registration_access
        (space_id,owner_user_id,machine_id,harness,grant_state,grant_revision,grant_execution_revision,grant_limits,
         policy_state,policy_revision,policy_execution_revision,policy_limits,updated_at)
        VALUES ($1,$2,$3,$4,'revoked',1,1,$5::jsonb,'enabled',1,1,$5::jsonb,clock_timestamp()) ON CONFLICT DO NOTHING`,
      values: [...registrationKeyValues(key), JSON.stringify(empty)], maxRows: 0 });
      const rows = await tx.query({ name: "registration_access_lock_v1", text: `SELECT *
        FROM data.space_agent_registration_access WHERE ${REGISTRATION_KEY_SQL} FOR UPDATE`, values: registrationKeyValues(key), maxRows: 1 });
      const current = registrationAccess(rows[0]!);
      if (current.grant.revision !== input.expectedRevision) {
        throw new RegistrationAccessError("authorization_revision_conflict", 409);
      }
      // A Space admin removing someone else's registration only revokes; the
      // owner's limits stay exactly as granted for the owner's own add-back.
      if (!ownerActing && (!registrationLimitsWithin(limits, current.grant.limits) ||
          !registrationLimitsWithin(current.grant.limits, limits))) {
        throw new RegistrationAccessError("registration_owner_required", 403);
      }
      const revision = await writeRegistrationOwnerGrant(tx, key, current.grant, {
        ...input, limits, requestDigest: hash,
      });
      return { revision, reused: false };
    });
  }
}

/** Write one owner-grant transition and its reconciliation evidence together.
 * The caller must authorize the actor and lock the registration/access rows;
 * CAS and replay checks remain with the command that acquired those locks. */
export async function writeRegistrationOwnerGrant(tx: DatabaseTransaction, key: SpaceAgentRegistrationKey,
  current: RegistrationOwnerGrant, input: { actorUserId: string; commandId: string; requestDigest: string;
    state: RegistrationOwnerGrant["state"]; limits: RegistrationResourceLimits }): Promise<number> {
  const { limits } = input;
  const next = current.revision + 1;
  if (!Number.isSafeInteger(next)) throw new RegistrationAccessError("authorization_revision_overflow", 409);
  // Expansions preserve already accepted executions. A state change or a
  // narrowing advances a durable fence even if a later change re-expands
  // the same limits, so revoked execution authority cannot resurrect.
  const grantExecutionRevision = input.state !== current.state ||
    !registrationExecutionPermissionsPreserved(current.limits, limits) ? next : current.executionRevision;
  // The Space policy has no writer of its own: it follows what the owner grants.
  await tx.query({ name: "registration_grant_update_v2", text: `UPDATE data.space_agent_registration_access
    SET grant_state=$5,grant_revision=$6,grant_limits=$7::jsonb,policy_limits=$7::jsonb,grant_execution_revision=$8,
      updated_at=clock_timestamp() WHERE ${REGISTRATION_KEY_SQL}`,
  values: [...registrationKeyValues(key), input.state, next, JSON.stringify(limits), grantExecutionRevision], maxRows: 0 });
  await tx.query({ name: "registration_access_change_record_v1", text: `INSERT INTO data.registration_access_changes
    (space_id,owner_user_id,machine_id,harness,authority,revision,actor_user_id,command_id,request_digest,reconcile_state,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',clock_timestamp())`,
  values: [...registrationKeyValues(key), "owner", next, input.actorUserId, input.commandId, input.requestDigest], maxRows: 0 });
  // A change that affects no unsettled execution is complete as it is recorded.
  await completeRegistrationAccessChanges(tx, { key });
  return next;
}

/** The recorded result of an actor's earlier command with this id, if any. */
async function replayed(tx: DatabaseTransaction, actorUserId: string, commandId: string, hash: string) {
  const prior = await tx.query({ name: "registration_access_replay_v1", text: `SELECT request_digest,revision
    FROM data.registration_access_changes WHERE actor_user_id=$1 AND command_id=$2 LIMIT 1`,
  values: [actorUserId, commandId], maxRows: 1 });
  if (!prior[0]) return null;
  if (prior[0].request_digest !== hash) throw new RegistrationAccessError("idempotency_mismatch", 409);
  return { revision: Number(prior[0].revision), reused: true };
}

/** The Agent's owner or a Space owner/admin disables or enables it in this Space. Disabling
 * advances the Space's execution revision, so the Channel coordinators stop
 * its running work here; enabling admits new work only. */
export async function changeSpaceState(database: AuthorityDatabase, placement: DatabasePlacementContext, input: {
  key: SpaceAgentRegistrationKey; actorUserId: string; commandId: string; expectedRevision: number;
  state: "enabled" | "disabled" }) {
  const key = parseSpaceAgentRegistrationKey(input.key);
  if (key.spaceId !== placement.spaceId) throw new RegistrationAccessError("registration_not_found", 404);
  if (!input.actorUserId || input.actorUserId.length > 300 || !input.commandId || input.commandId.length > 200 ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      (input.state !== "enabled" && input.state !== "disabled")) throw new RegistrationAccessError("invalid_access_command", 400);
  const hash = await sha256Hex(JSON.stringify({ key, authority: "space-state",
    expectedRevision: input.expectedRevision, state: input.state }));
  return database.transaction({ requestId: input.commandId, operation: "registration.space-state.change", placement }, async tx => {
    const members = await tx.query({ name: "registration_space_state_members_v1", text: `SELECT user_id,role
      FROM data.space_members WHERE space_id=$1 AND user_id=ANY($2::text[]) FOR SHARE`,
    values: [key.spaceId, [...new Set([input.actorUserId, key.ownerUserId])]], maxRows: 2 });
    const role = members.find(row => row.user_id === input.actorUserId)?.role;
    if (!role || !members.some(row => row.user_id === key.ownerUserId)) throw new RegistrationAccessError("registration_not_found", 404);
    if (input.actorUserId !== key.ownerUserId && !["owner", "admin"].includes(String(role))) {
      throw new RegistrationAccessError("space_policy_authority_required", 403);
    }
    const prior = await replayed(tx, input.actorUserId, input.commandId, hash);
    if (prior) return prior;
    const rows = await tx.query({ name: "registration_access_lock_v1", text: `SELECT *
      FROM data.space_agent_registration_access WHERE ${REGISTRATION_KEY_SQL} FOR UPDATE`, values: registrationKeyValues(key), maxRows: 1 });
    if (!rows[0]) throw new RegistrationAccessError("registration_not_granted", 403);
    const current = registrationAccess(rows[0]).policy;
    if (current.revision !== input.expectedRevision) throw new RegistrationAccessError("authorization_revision_conflict", 409);
    const next = input.expectedRevision + 1;
    if (!Number.isSafeInteger(next)) throw new RegistrationAccessError("authorization_revision_overflow", 409);
    const executionRevision = input.state === "disabled" && current.state !== "disabled" ? next : current.executionRevision;
    await tx.query({ name: "registration_space_state_update_v1", text: `UPDATE data.space_agent_registration_access
      SET policy_state=CASE WHEN $5 THEN ${SPACE_DISABLED_SQL} ELSE 'enabled' END,policy_revision=$6,
        policy_execution_revision=$7,updated_at=clock_timestamp() WHERE ${REGISTRATION_KEY_SQL}`,
    values: [...registrationKeyValues(key), input.state === "disabled", next, executionRevision], maxRows: 0 });
    await tx.query({ name: "registration_access_change_record_v1", text: `INSERT INTO data.registration_access_changes
      (space_id,owner_user_id,machine_id,harness,authority,revision,actor_user_id,command_id,request_digest,reconcile_state,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',clock_timestamp())`,
    values: [...registrationKeyValues(key), "space", next, input.actorUserId, input.commandId, hash], maxRows: 0 });
    await completeRegistrationAccessChanges(tx, { key });
    return { revision: next, reused: false };
  });
}

/** The owner grants and revokes; a Space owner/admin may also revoke (remove
 * from the Space) but never grant another member's machine. Returns whether
 * the registration's owner is the actor. */
async function requireAuthority(tx: DatabaseTransaction, key: SpaceAgentRegistrationKey,
  actor: string, state: string): Promise<boolean> {
  const members = await tx.query({ name: "registration_access_members_v1", text: `SELECT user_id,role
    FROM data.space_members WHERE space_id=$1 AND user_id=ANY($2::text[]) FOR SHARE`,
  values: [key.spaceId, [...new Set([actor, key.ownerUserId])]], maxRows: 2 });
  const role = members.find(row => row.user_id === actor)?.role;
  if (!members.some(row => row.user_id === key.ownerUserId) || !role) {
    throw new RegistrationAccessError("registration_not_found", 404);
  }
  const ownerActing = actor === key.ownerUserId, admin = ["owner", "admin"].includes(String(role));
  if (!ownerActing && !(admin && state === "revoked")) {
    throw new RegistrationAccessError(admin ? "registration_owner_required" : "registration_not_found", admin ? 403 : 404);
  }
  return ownerActing;
}
