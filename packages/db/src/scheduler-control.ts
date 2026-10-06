import { storedIso as iso, storedObject as json } from "./stored-values.js";
import type { QueryResultRow } from "pg";
import { readsOnly } from "./space-roles.js";
import { LIVE_AGENT_STATUS_SQL } from "@xmatrix/protocol";
import { commandDigest as digest, commandJson as stable } from "./command-digest.js";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { writeOutbox } from "./outbox.js";
import { WritableSpacePlacements, type SpacePlacement } from "./placement.js";
import { commandFields } from "./command-fields.js";
import { spaceMemberRole } from "./space-members.js";
import { readScopedCommandReplay, storeScopedCommandReplay, COMMAND_REPLAY_TTL_MS as REPLAY_TTL_MS } from "./command-replay.js";
import { ControlError } from "./control-error.js";

export class SchedulerControlError extends ControlError {
  override name = "SchedulerControlError";
}

const fields = commandFields((field) =>
  new SchedulerControlError("invalid_scheduler_request", 400, `${field} is invalid`));
const { text, integer } = fields;

function optionalText(value: unknown, field: string, maximum = 300): string | undefined {
  return value === undefined || value === null ? undefined : text(value, field, maximum);
}

async function requireSpace(tx: DatabaseTransaction, spaceId: string, userId: string,
  write: boolean): Promise<string> {
  const role = await spaceMemberRole(tx, "scheduler_space_role_v1", spaceId, userId);
  if (!role) throw new SchedulerControlError("space_not_found", 404, "Space not found");
  if (write && readsOnly(role)) throw new SchedulerControlError(
    "forbidden", 403, "principal cannot manage this Space");
  return role;
}

function claim(row: QueryResultRow): Record<string, unknown> {
  return { id: String(row.claim_id), spaceId: String(row.space_id), scope: String(row.scope),
    intent: String(row.intent), status: String(row.status), holder: json(row.holder_json),
    ...(row.idempotency_key ? { idempotencyKey: String(row.idempotency_key) } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), expiresAt: iso(row.expires_at),
    ...(row.released_at ? { releasedAt: iso(row.released_at) } : {}),
    ...(row.released_by_user_id ? { releasedBy: String(row.released_by_user_id) } : {}),
    version: Number(row.version) };
}

function replay(tx: DatabaseTransaction, scopeKind: string, scopeId: string,
  commandId: string, commandKind: string, requestDigest: string): Promise<unknown | null> {
  return readScopedCommandReplay(tx, "scheduler_control_replay_read_v1",
    { scopeKind, scopeId, commandId, commandKind, requestDigest },
    () => new SchedulerControlError("idempotency_mismatch", 409, "command id was reused"));
}

async function commit(tx: DatabaseTransaction, spaceId: string, scopeKind: string, scopeId: string,
  commandId: string, commandKind: string, requestDigest: string, result: unknown, at: string) {
  const heads = await tx.query<QueryResultRow>({ name: "scheduler_control_head_v1", text: `UPDATE
    data.space_control_heads SET commit_sequence=commit_sequence+1,updated_at=$2 WHERE space_id=$1
    RETURNING commit_sequence`, values: [spaceId, at], maxRows: 1 });
  if (!heads[0]) throw new SchedulerControlError(
    "space_control_head_missing", 500, "Space control head is unavailable");
  const sequence = Number(heads[0].commit_sequence);
  await writeOutbox(tx, {
    name: "scheduler_control_outbox_v1",
    outboxId: `space-control:${spaceId}:${sequence}`,
    spaceId,
    topic: "space-control",
    aggregateKind: "scheduler-control",
    aggregateId: spaceId,
    aggregateSequence: sequence,
    payload: result,
    at,
  });
  await storeScopedCommandReplay(tx, "scheduler_control_replay_write_v1", { scopeKind, scopeId, commandId,
    commandKind, requestDigest, result, at, ttlMs: REPLAY_TTL_MS });
}

/** A Space's action claims: who is working on what, fenced so two holders never overlap. */
export class PostgresSchedulerControlRepository {
  private readonly spaces: WritableSpacePlacements;

  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new SchedulerControlError(
      "cached_authority_forbidden", 500, "Scheduler authority cannot use a query cache");
    this.spaces = new WritableSpacePlacements(database, () => new SchedulerControlError(
      "space_placement_unavailable", 503, "Space placement is unavailable", true));
  }

  private context(requestId: string, operation: string, placement: SpacePlacement) {
    return { requestId, operation, placement: { spaceId: placement.spaceId,
      shardId: placement.shardId, placementEpoch: placement.placementEpoch } };
  }

  async acquireClaim(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const commandId = text(input.commandId, "commandId", 200);
    const spaceId = text(input.spaceId, "spaceId", 180);
    const actorUserId = text(input.actorUserId, "actorUserId", 180);
    const scope = text(input.scope, "scope", 240);
    const claimIntent = text(input.intent, "intent", 120);
    const idempotencyKey = optionalText(input.idempotencyKey, "idempotencyKey", 160);
    const ttlMs = Math.max(1_000, Math.min(input.ttlMs === undefined ? 10 * 60_000
      : integer(input.ttlMs, "ttlMs", 1), 30 * 60_000));
    const holderRefs = { holderLabel: optionalText(input.holderLabel, "holderLabel", 120),
      agentId: optionalText(input.agentId, "agentId", 200),
      agentName: optionalText(input.agentName, "agentName", 200),
      agentInstanceId: optionalText(input.agentInstanceId, "agentInstanceId", 200),
      runId: optionalText(input.runId, "runId", 200),
      executionKey: optionalText(input.executionKey, "executionKey", 200) };
    const requestDigest = await digest({ spaceId, actorUserId, scope, claimIntent,
      idempotencyKey, ttlMs, holderRefs });
    const at = new Date().toISOString();
    const placement = await this.spaces.resolve(commandId, "scheduler.claim.acquire.placement", spaceId);
    return this.database.transaction(this.context(commandId, "scheduler.claim.acquire", placement),
      async (tx) => {
        await requireSpace(tx, spaceId, actorUserId, true);
        const prior = await replay(tx, "space", spaceId, commandId,
          "acquire-space-action-claim", requestDigest);
        if (prior) return prior as Record<string, unknown>;
        await tx.query({ name: "scheduler_claim_scope_lock_v1", text: `SELECT
          pg_advisory_xact_lock(hashtextextended($1,0))`,
        values: [stable([spaceId, scope, claimIntent])], maxRows: 1 });
        const holder = await this.resolveHolder(tx, spaceId, actorUserId, holderRefs);
        await tx.query({ name: "scheduler_claim_expire_v1", text: `UPDATE data.space_action_claims
          SET status='expired',version=version+1,updated_at=$2
          WHERE space_id=$1 AND status='active' AND expires_at<=$2`,
        values: [spaceId, at], maxRows: 0 });
        const active = await tx.query<QueryResultRow>({ name: "scheduler_claim_active_v1", text: `SELECT *
          FROM data.space_action_claims WHERE space_id=$1 AND scope=$2 AND intent=$3 AND status='active'
          LIMIT 1`, values: [spaceId, scope, claimIntent], maxRows: 1 });
        if (active[0]) {
          if (idempotencyKey && active[0].idempotency_key === idempotencyKey &&
              active[0].holder_user_id === actorUserId && stable(json(active[0].holder_json)) === stable(holder)) {
            return { claim: claim(active[0]), reused: true };
          }
          throw new SchedulerControlError("claim_conflict", 409, "claim-conflict");
        }
        const claimId = crypto.randomUUID();
        const expiresAt = new Date(Date.parse(at) + ttlMs).toISOString();
        const inserted = await tx.query<QueryResultRow>({ name: "scheduler_claim_insert_v1", text: `INSERT INTO
          data.space_action_claims (claim_id,space_id,scope,intent,holder_user_id,holder_json,
            idempotency_key,status,version,created_at,updated_at,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'active',1,$8,$8,$9) RETURNING *`,
        values: [claimId, spaceId, scope, claimIntent, actorUserId, JSON.stringify(holder),
          idempotencyKey ?? null, at, expiresAt], maxRows: 1 });
        const result = { claim: claim(inserted[0]!), reused: false };
        await commit(tx, spaceId, "space", spaceId, commandId,
          "acquire-space-action-claim", requestDigest, result, at);
        return result;
      });
  }

  private async resolveHolder(tx: DatabaseTransaction, spaceId: string, actorUserId: string,
    refs: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    if (!refs.agentId && !refs.agentName && !refs.agentInstanceId && !refs.runId && !refs.executionKey) {
      return { userId: actorUserId, ...(refs.holderLabel ? { label: refs.holderLabel } : {}) };
    }
    const rows = await tx.query<QueryResultRow>({ name: "scheduler_claim_holder_v3", text: `SELECT
      r.run_id,r.metadata_json,i.instance_id,
      COALESCE(registration.display_name,r.metadata_json->>'agentName') AS agent_name
      FROM data.runs r JOIN data.instances i ON i.run_id=r.run_id
      JOIN data.run_agent_registrations binding ON binding.run_id=r.run_id AND binding.space_id=$2
      LEFT JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
        AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
        AND registration.harness=binding.harness
      JOIN data.channels c ON c.channel_id=r.channel_id
      WHERE r.owner_user_id=$1 AND c.space_id=$2 AND r.status IN ('starting','running')
        AND i.status IN (${LIVE_AGENT_STATUS_SQL}) AND ($3::text IS NULL OR i.instance_id=$3)
        AND ($4::text IS NULL OR COALESCE(registration.display_name,r.metadata_json->>'agentName')=$4)
        AND ($5::text IS NULL OR i.instance_id=$5)
        AND ($6::text IS NULL OR r.run_id=$6)
        AND ($7::text IS NULL OR r.metadata_json->>'executionKey'=$7)
      ORDER BY r.run_id LIMIT 2`, values: [actorUserId, spaceId, refs.agentId ?? null,
      refs.agentName ?? null, refs.agentInstanceId ?? null, refs.runId ?? null,
      refs.executionKey ?? null], maxRows: 2 });
    if (rows.length !== 1) throw new SchedulerControlError("agent_instance_not_found", 403,
      "Agent claim holder must resolve to one active owned Agent Instance in this Space");
    const row = rows[0];
    const executionKey = typeof json(row.metadata_json).executionKey === "string"
      ? String(json(row.metadata_json).executionKey) : undefined;
    return { userId: actorUserId, agentId: String(row.instance_id),
      agentName: String(row.agent_name), agentInstanceId: String(row.instance_id),
      runId: String(row.run_id), ...(executionKey ? { executionKey } : {}),
      label: refs.holderLabel || String(row.agent_name) };
  }

  async mutateClaim(input: Record<string, unknown>, action: "renew" | "release"):
    Promise<Record<string, unknown>> {
    const commandId = text(input.commandId, "commandId", 200);
    const spaceId = text(input.spaceId, "spaceId", 180);
    const claimId = text(input.claimId, "claimId", 200);
    const actorUserId = text(input.actorUserId, "actorUserId", 180);
    const ttlMs = action === "renew" ? Math.max(1_000, Math.min(
      input.ttlMs === undefined ? 10 * 60_000 : integer(input.ttlMs, "ttlMs", 1), 30 * 60_000)) : 0;
    const requestDigest = await digest({ spaceId, claimId, actorUserId, ttlMs });
    const at = new Date().toISOString();
    const commandKind = `${action}-space-action-claim`;
    const placement = await this.spaces.resolve(
      commandId, `scheduler.claim.${action}.placement`, spaceId);
    return this.database.transaction(this.context(commandId, `scheduler.claim.${action}`, placement),
      async (tx) => {
        const role = await requireSpace(tx, spaceId, actorUserId, action === "renew");
        const prior = await replay(tx, "space", spaceId, commandId, commandKind, requestDigest);
        if (prior) return prior as Record<string, unknown>;
        const rows = await tx.query<QueryResultRow>({ name: "scheduler_claim_lock_v1", text: `SELECT *
          FROM data.space_action_claims WHERE claim_id=$1 AND space_id=$2 FOR UPDATE`,
        values: [claimId, spaceId], maxRows: 1 });
        const current = rows[0];
        if (!current || current.status !== "active" || Date.parse(iso(current.expires_at)) <= Date.parse(at)) {
          throw new SchedulerControlError("claim_not_found", 404, "Claim not found");
        }
        if (current.holder_user_id !== actorUserId && role !== "owner" && role !== "admin") {
          throw new SchedulerControlError("forbidden", 403,
            `Only the claim holder or Space owners/admins can ${action} a claim`);
        }
        const updated = await tx.query<QueryResultRow>({ name: `scheduler_claim_${action}_v1`, text: action === "renew"
          ? `UPDATE data.space_action_claims SET version=version+1,updated_at=$2,expires_at=$3
             WHERE claim_id=$1 RETURNING *`
          : `UPDATE data.space_action_claims SET status='released',version=version+1,updated_at=$2,
             released_at=$2,released_by_user_id=$3 WHERE claim_id=$1 RETURNING *`,
        values: action === "renew" ? [claimId, at, new Date(Date.parse(at) + ttlMs).toISOString()]
          : [claimId, at, actorUserId], maxRows: 1 });
        const result = { claim: claim(updated[0]!) };
        await commit(tx, spaceId, "space", spaceId, commandId, commandKind,
          requestDigest, result, at);
        return result;
      });
  }
}
