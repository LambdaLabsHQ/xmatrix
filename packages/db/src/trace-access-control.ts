import { storedIso as iso } from "./stored-values.js";
import type { QueryResultRow } from "pg";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { writeOutbox } from "./outbox.js";
import {
  channelCapabilityPredicate,
  requireChannelCapability,
  type ChannelCapabilityFailure,
} from "./channel-capability-policy.js";
import { commandFields } from "./command-fields.js";
import { readScopedCommandReplay, storeScopedCommandReplay } from "./command-replay.js";
import { ACTIVE_RUN_STATUSES, isActiveRunStatus, sha256Hex } from "@xmatrix/protocol";
import { ControlError } from "./control-error.js";

const REPLAY_TTL_MS = 30 * 24 * 60 * 60_000;
const GRANT_TTL_MS = 24 * 60 * 60_000;
const DENIAL_COOLDOWN_MS = 60 * 60_000;
const MAX_PAGE = 200;
const EXPIRY_LIMIT = 256;

type TraceDuration = "permanent" | "channel" | "once";
type TraceAction = "approve" | "deny" | "revoke";

export interface TraceAccessNotification {
  type: "trace_access_requested" | "trace_access_updated";
  grant: Record<string, unknown>;
}

export interface TraceAccessAuthorityResult {
  value: Record<string, unknown>;
  notifications: TraceAccessNotification[];
}

export class TraceAccessControlError extends ControlError {
  override name = "TraceAccessControlError";
  constructor(code: string, status: number, message: string,
    retryable = false, readonly notifications: TraceAccessNotification[] = []) {
    super(code, status, message, retryable);
  }
}

function channelCapabilityError(failure: ChannelCapabilityFailure): TraceAccessControlError {
  return new TraceAccessControlError(failure.code, failure.status, failure.message);
}

const { text, object } = commandFields((field) =>
  new TraceAccessControlError("invalid_command", 400, `${field} is invalid`));

function optionalText(value: unknown, field: string, maximum: number): string | null {
  return value === undefined || value === null ? null : text(value, field, maximum);
}

function user(input: Record<string, unknown>): string {
  const principal = object(input.principal, "principal");
  if (principal.kind !== "user") throw new TraceAccessControlError(
    "forbidden", 403, "Only users may manage trace access");
  return text(principal.id, "principal.id", 200);
}

function duration(value: unknown): TraceDuration {
  const result = text(value, "duration", 20);
  if (result !== "permanent" && result !== "channel" && result !== "once") {
    throw new TraceAccessControlError("invalid_command", 400, "duration is invalid");
  }
  return result;
}

function action(value: unknown): TraceAction {
  const result = text(value, "action", 20);
  if (result !== "approve" && result !== "deny" && result !== "revoke") {
    throw new TraceAccessControlError("invalid_command", 400, "action is invalid");
  }
  return result;
}

function integer(value: unknown, field: string, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new TraceAccessControlError(
    "invalid_request", 400, `${field} is invalid`);
  return result;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
}

async function digest(value: unknown): Promise<string> {
  return sha256Hex(stable(value));
}


function grant(row: QueryResultRow): Record<string, unknown> {
  return { id: String(row.grant_id), ownerUserId: String(row.owner_user_id),
    ...(row.owner_label ? { ownerLabel: String(row.owner_label) } : {}),
    viewerUserId: String(row.viewer_user_id),
    ...(row.viewer_label ? { viewerLabel: String(row.viewer_label) } : {}),
    agentId: String(row.agent_id), ...(row.agent_name ? { agentName: String(row.agent_name) } : {}),
    ...(row.instance_id ? { instanceId: String(row.instance_id) } : {}),
    ...(row.channel_id ? { channelId: String(row.channel_id) } : {}),
    duration: String(row.duration), status: String(row.status),
    ...(row.reason ? { reason: String(row.reason) } : {}), requestedAt: iso(row.requested_at),
    ...(row.decided_at ? { decidedAt: iso(row.decided_at) } : {}),
    ...(row.expires_at ? { expiresAt: iso(row.expires_at) } : {}), version: Number(row.version) };
}

function pageCursor(value: unknown): [string, string] | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length === 2 &&
      parsed.every((item) => typeof item === "string") ? parsed as [string, string] : null;
  } catch {
    return null;
  }
}

function replay(tx: DatabaseTransaction, scopeKind: string, scopeId: string,
  commandId: string, commandKind: string, requestDigest: string): Promise<Record<string, unknown> | null> {
  return readScopedCommandReplay(tx, "trace_access_replay_read_v1",
    { scopeKind, scopeId, commandId, commandKind, requestDigest },
    () => new TraceAccessControlError("idempotency_mismatch", 409, "command id was reused"));
}

function storeReplay(tx: DatabaseTransaction, scopeKind: string, scopeId: string,
  commandId: string, commandKind: string, requestDigest: string,
  result: Record<string, unknown>, at: string): Promise<void> {
  return storeScopedCommandReplay(tx, "trace_access_replay_write_v1",
    { scopeKind, scopeId, commandId, commandKind, requestDigest, result, at, ttlMs: REPLAY_TTL_MS });
}

async function commit(tx: DatabaseTransaction, spaceId: string,
  notifications: readonly TraceAccessNotification[], at: string): Promise<void> {
  if (notifications.length === 0) return;
  const heads = await tx.query<QueryResultRow>({ name: "trace_access_control_head_v1", text: `UPDATE
    data.space_control_heads SET commit_sequence=commit_sequence+1,updated_at=$2 WHERE space_id=$1
    RETURNING commit_sequence`, values: [spaceId, at], maxRows: 1 });
  const sequence = Number(heads[0]?.commit_sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TraceAccessControlError(
    "space_control_head_missing", 500, "Space control head is unavailable");
  await writeOutbox(tx, {
    name: "trace_access_outbox_v1",
    outboxId: `space-control:${spaceId}:${sequence}`,
    spaceId,
    topic: "space-control",
    aggregateKind: "trace-access",
    aggregateId: spaceId,
    aggregateSequence: sequence,
    payload: { notifications },
    at,
  });
}

/**
 * The Agent a grant names, as a derived table (agent_id, space_id,
 * owner_user_id, name): a registered Instance, resolved through its Run's
 * registration binding.
 */
const TRACE_AGENTS = `(SELECT instance.instance_id AS agent_id,binding.space_id,binding.owner_user_id,
    registration.display_name AS name
    FROM data.instances instance JOIN data.run_agent_registrations binding ON binding.run_id=instance.run_id
    JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
      AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
      AND registration.harness=binding.harness)`;

async function expire(tx: DatabaseTransaction, name: string, at: string,
  filter: string, values: readonly unknown[]): Promise<readonly QueryResultRow[]> {
  return tx.query<QueryResultRow>({ name, text: `WITH candidates AS (
    SELECT g.grant_id,p.space_id,NOT EXISTS(SELECT 1 FROM data.instances i JOIN data.runs r
      ON r.run_id=i.run_id WHERE i.instance_id=g.instance_id AND i.instance_id=g.agent_id
      AND r.status=ANY($2::text[])) AS terminal
    FROM data.trace_access_grants g JOIN ${TRACE_AGENTS} p ON p.agent_id=g.agent_id
    WHERE g.status IN ('pending','approved') AND (${filter}) AND
      ((g.expires_at IS NOT NULL AND g.expires_at<=$1) OR
       (g.duration='once' AND g.instance_id IS NOT NULL AND NOT EXISTS(SELECT 1
        FROM data.instances i JOIN data.runs r ON r.run_id=i.run_id
        WHERE i.instance_id=g.instance_id AND i.instance_id=g.agent_id
          AND r.status=ANY($2::text[]))))
    ORDER BY g.requested_at DESC,g.grant_id DESC LIMIT ${EXPIRY_LIMIT} FOR UPDATE OF g
  ) UPDATE data.trace_access_grants g SET status='expired',version=g.version+1,
      decided_at=COALESCE(g.decided_at,$1),expires_at=CASE WHEN c.terminal AND
        (g.expires_at IS NULL OR g.expires_at>$1) THEN $1 ELSE g.expires_at END
    FROM candidates c WHERE g.grant_id=c.grant_id RETURNING g.*,c.space_id`,
  values: [at, [...ACTIVE_RUN_STATUSES], ...values], maxRows: EXPIRY_LIMIT });
}

function notifications(rows: readonly QueryResultRow[], type: TraceAccessNotification["type"] =
  "trace_access_updated"): TraceAccessNotification[] {
  return rows.map((row) => ({ type, grant: grant(row) }));
}

async function commitBySpace(tx: DatabaseTransaction, rows: readonly QueryResultRow[],
  values: readonly TraceAccessNotification[], at: string): Promise<void> {
  const spaces = new Map<string, TraceAccessNotification[]>();
  rows.forEach((row, index) => {
    const spaceId = String(row.space_id);
    spaces.set(spaceId, [...spaces.get(spaceId) ?? [], values[index]!]);
  });
  for (const [spaceId, scoped] of spaces) await commit(tx, spaceId, scoped, at);
}

export class PostgresTraceAccessRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new TraceAccessControlError(
      "cached_authority_forbidden", 500, "Trace access authority requires uncached PostgreSQL");
  }

  async request(input: Record<string, unknown>): Promise<TraceAccessAuthorityResult> {
    const commandId = text(input.commandId, "commandId", 200);
    const viewerUserId = user(input);
    const agentId = text(input.agentId, "agentId", 200);
    const requestedDuration = duration(input.duration);
    const instanceId = requestedDuration === "once" ? text(input.instanceId, "instanceId", 200) : null;
    const requestedChannelId = input.channelId === undefined ? null : text(input.channelId, "channelId", 180);
    const channelId = requestedDuration === "channel" ? text(input.channelId, "channelId", 180) : null;
    const reason = optionalText(input.reason, "reason", 500);
    const viewerLabel = optionalText(input.viewerLabel, "viewerLabel", 200);
    const requestDigest = await digest({ agentId, duration: requestedDuration, instanceId,
      channelId, requestedChannelId, reason, viewerLabel, principal: { kind: "user", id: viewerUserId } });
    const at = new Date().toISOString();
    return this.database.transaction({ requestId: commandId, operation: "trace-access.request" }, async (tx) => {
      const prior = await replay(tx, "trace-request", `${viewerUserId}:${agentId}`, commandId,
        "request-trace-access", requestDigest);
      if (prior) return { value: prior, notifications: [] };
      const agent = (await tx.query<QueryResultRow>({ name: "trace_access_request_agent_v1", text: `SELECT
        space_id,owner_user_id,name FROM ${TRACE_AGENTS} agent WHERE agent_id=$1 LIMIT 1`, values: [agentId], maxRows: 1 }))[0];
      if (!agent) throw new TraceAccessControlError(
        "agent_not_found", 404, "Agent not found");
      if (agent.owner_user_id === viewerUserId) throw new TraceAccessControlError(
        "invalid_command", 400, "Owners already have trace access");
      let authorizationChannelId = channelId;
      if (instanceId) {
        const live = await tx.query<QueryResultRow>({ name: "trace_access_request_instance_v2", text: `SELECT
          i.channel_id FROM data.instances i JOIN data.runs r ON r.run_id=i.run_id
          WHERE i.instance_id=$1 AND i.instance_id=$2 AND r.status=ANY($3::text[]) LIMIT 1`,
        values: [instanceId, agentId, [...ACTIVE_RUN_STATUSES]], maxRows: 1 });
        if (!live[0]) throw new TraceAccessControlError(
          "invalid_command", 400, "instanceId is not live for the requested agent");
        authorizationChannelId = requestedChannelId ?? String(live[0].channel_id);
        if (authorizationChannelId !== live[0].channel_id) throw new TraceAccessControlError(
          "invalid_command", 400, "instanceId is not live in the requested channel");
      } else if (channelId) {
        const live = await tx.query({ name: "trace_access_request_channel_live_v2", text: `SELECT 1 AS present
          FROM data.instances i JOIN data.runs r ON r.run_id=i.run_id WHERE i.instance_id=$1
          AND i.channel_id=$2 AND r.status=ANY($3::text[]) LIMIT 1`,
        values: [agentId, channelId, [...ACTIVE_RUN_STATUSES]], maxRows: 1 });
        if (!live[0]) throw new TraceAccessControlError(
          "invalid_command", 400, "agent is not live in the requested channel");
      }
      if (authorizationChannelId) await requireChannelCapability(tx, {
        capability: "trace_new_grant", channelId: authorizationChannelId,
        principal: { kind: "user", id: viewerUserId }, error: channelCapabilityError,
      });
      const expired = await expire(tx, "trace_access_request_expire_v2", at,
        "g.viewer_user_id=$3 AND g.agent_id=$4", [viewerUserId, agentId]);
      const active = await tx.query<QueryResultRow>({ name: "trace_access_request_active_v2", text: `SELECT g.*,
        p.space_id FROM data.trace_access_grants g JOIN ${TRACE_AGENTS} p ON p.agent_id=g.agent_id
        WHERE g.viewer_user_id=$1 AND g.agent_id=$2 AND g.duration=$3 AND
          ($3='permanent' OR ($3='once' AND g.instance_id=$4 AND g.expires_at IS NOT NULL) OR
           ($3='channel' AND g.channel_id=$5 AND g.expires_at IS NOT NULL))
          AND g.status IN ('pending','approved') AND (g.expires_at IS NULL OR g.expires_at>$6)
        ORDER BY g.requested_at DESC LIMIT 1`, values: [viewerUserId, agentId, requestedDuration,
        instanceId, channelId, at], maxRows: 1 });
      let value: Record<string, unknown>;
      let created: QueryResultRow | undefined;
      if (active[0]) value = { grant: grant(active[0]) };
      else {
        const denied = await tx.query({ name: "trace_access_request_denied_v1", text: `SELECT 1 AS denied
          FROM data.trace_access_grants WHERE viewer_user_id=$1 AND agent_id=$2 AND status='denied'
          AND COALESCE(decided_at,requested_at)>$3 LIMIT 1`, values: [viewerUserId, agentId,
        new Date(Date.parse(at) - DENIAL_COOLDOWN_MS).toISOString()], maxRows: 1 });
        if (denied[0]) throw new TraceAccessControlError(
          "trace_access_rate_limited", 429, "This request was recently denied; try again later");
        const inserted = await tx.query<QueryResultRow>({ name: "trace_access_request_insert_v1", text: `INSERT INTO
          data.trace_access_grants (grant_id,owner_user_id,owner_label,viewer_user_id,viewer_label,
          agent_id,agent_name,instance_id,channel_id,duration,status,reason,version,requested_at,decided_at,expires_at)
          VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,'pending',$10,1,$11,NULL,$12) RETURNING *`, values: [
          crypto.randomUUID(), agent.owner_user_id, viewerUserId, viewerLabel, agentId, agent.name,
          instanceId, channelId, requestedDuration, reason, at, requestedDuration === "permanent" ? null
            : new Date(Date.parse(at) + GRANT_TTL_MS).toISOString()], maxRows: 1 });
        created = { ...inserted[0]!, space_id: agent.space_id };
        value = { grant: grant(created) };
      }
      const events = [...notifications(expired), ...(created ? notifications([created], "trace_access_requested") : [])];
      await commitBySpace(tx, expired, notifications(expired), at);
      if (created) await commit(tx, String(agent.space_id), notifications([created], "trace_access_requested"), at);
      await storeReplay(tx, "trace-request", `${viewerUserId}:${agentId}`, commandId,
        "request-trace-access", requestDigest, value, at);
      return { value, notifications: events };
    });
  }

  async decide(input: Record<string, unknown>): Promise<TraceAccessAuthorityResult> {
    const commandId = text(input.commandId, "commandId", 200);
    const grantId = text(input.grantId, "grantId", 200);
    const decision = action(input.action);
    const ownerUserId = user(input);
    const requestDigest = await digest({ grantId, action: decision, duration: input.duration,
      principal: { kind: "user", id: ownerUserId } });
    const at = new Date().toISOString();
    const outcome = await this.database.transaction({ requestId: commandId, operation: "trace-access.decide" },
      async (tx): Promise<TraceAccessAuthorityResult & { error?: TraceAccessControlError }> => {
        const rows = await tx.query<QueryResultRow>({ name: "trace_access_decide_lock_v2", text: `SELECT g.*,
          p.space_id,EXISTS(SELECT 1 FROM data.instances i JOIN data.runs r ON r.run_id=i.run_id
            WHERE i.instance_id=g.instance_id AND i.instance_id=g.agent_id
              AND r.status=ANY($2::text[])) AS instance_live
          FROM data.trace_access_grants g JOIN ${TRACE_AGENTS} p ON p.agent_id=g.agent_id
          WHERE g.grant_id=$1 FOR UPDATE`, values: [grantId, [...ACTIVE_RUN_STATUSES]], maxRows: 1 });
        const current = rows[0];
        if (!current) throw new TraceAccessControlError(
          "trace_access_not_found", 404, "Trace access request not found");
        if (current.owner_user_id !== ownerUserId) throw new TraceAccessControlError(
          "forbidden", 403, "Only the agent owner can decide trace access");
        const prior = await replay(tx, "trace-grant", grantId, commandId,
          "decide-trace-access", requestDigest);
        if (prior) return { value: prior, notifications: [] };
        const expired = (current.status === "pending" || current.status === "approved") &&
          (current.expires_at && Date.parse(iso(current.expires_at)) <= Date.parse(at) ||
           current.duration === "once" && current.instance_live !== true);
        if (expired) {
          const updated = await tx.query<QueryResultRow>({ name: "trace_access_decide_expire_v1", text: `UPDATE
            data.trace_access_grants SET status='expired',version=version+1,
            decided_at=COALESCE(decided_at,$2),expires_at=CASE WHEN expires_at IS NULL OR expires_at>$2
              THEN $2 ELSE expires_at END WHERE grant_id=$1 AND version=$3 RETURNING *`,
          values: [grantId, at, current.version], maxRows: 1 });
          const row = { ...updated[0]!, space_id: current.space_id };
          const events = notifications([row]);
          await commit(tx, String(current.space_id), events, at);
          return { value: {}, notifications: events, error: new TraceAccessControlError(
            "version_conflict", 409, "Request is already expired", false, events) };
        }
        if ((decision === "approve" || decision === "deny") && current.status !== "pending") {
          throw new TraceAccessControlError("version_conflict", 409, `Request is already ${current.status}`);
        }
        if (decision === "revoke" && current.status !== "approved") throw new TraceAccessControlError(
          "version_conflict", 409, "Only an approved grant can be revoked");
        if (decision === "approve" && input.duration !== undefined && input.duration !== current.duration) {
          throw new TraceAccessControlError(
            "version_conflict", 409, "Approval scope must match the requested trace access scope");
        }
        if (decision === "approve" && (current.duration === "once" &&
          (!current.instance_id || !current.expires_at) || current.duration === "channel" &&
          (!current.channel_id || !current.expires_at))) throw new TraceAccessControlError(
          "trace_access_scope_incomplete", 409,
          "Historical trace access request has no complete executable scope");
        if (decision === "approve" && current.duration === "once" && current.instance_live !== true) {
          throw new TraceAccessControlError(
            "trace_access_expired", 409, "The agent instance for this request has ended");
        }
        const status = decision === "approve" ? "approved" : decision === "deny" ? "denied" : "revoked";
        const updated = await tx.query<QueryResultRow>({ name: "trace_access_decide_update_v1", text: `UPDATE
          data.trace_access_grants SET status=$1,version=version+1,decided_at=$2
          WHERE grant_id=$3 AND version=$4 RETURNING *`, values: [status, at, grantId, current.version], maxRows: 1 });
        if (!updated[0]) throw new TraceAccessControlError(
          "version_conflict", 409, "Trace access decision lost a concurrent update");
        const row = { ...updated[0], space_id: current.space_id };
        const value = { grant: grant(row) };
        const events = notifications([row]);
        await commit(tx, String(current.space_id), events, at);
        await storeReplay(tx, "trace-grant", grantId, commandId,
          "decide-trace-access", requestDigest, value, at);
        return { value, notifications: events };
      });
    if (outcome.error) throw outcome.error;
    return outcome;
  }

  async list(input: Record<string, unknown>): Promise<TraceAccessAuthorityResult> {
    const principalId = user(input);
    const limit = Math.min(integer(input.limit, "limit", 50), MAX_PAGE);
    const cursor = pageCursor(input.cursor);
    const at = new Date().toISOString();
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "trace-access.list" },
      async (tx) => {
        const expired = await expire(tx, "trace_access_list_expire_v2", at,
          "(g.owner_user_id=$3 OR g.viewer_user_id=$3)", [principalId]);
        const rows = await tx.query<QueryResultRow>({ name: "trace_access_list_v1", text: `SELECT *
          FROM data.trace_access_grants WHERE (owner_user_id=$1 OR viewer_user_id=$1)
          AND ($2::timestamptz IS NULL OR requested_at<$2 OR (requested_at=$2 AND grant_id<$3))
          ORDER BY requested_at DESC,grant_id DESC LIMIT $4`, values: [principalId,
        cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1], maxRows: limit + 1 });
        const page = rows.slice(0, limit);
        const events = notifications(expired);
        await commitBySpace(tx, expired, events, at);
        return { value: { grants: page.map(grant), cursor: rows.length > limit
          ? JSON.stringify([iso(page.at(-1)!.requested_at), String(page.at(-1)!.grant_id)]) : null },
        notifications: events };
      });
  }

  async authorize(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const principalId = user(input);
    const instanceId = text(input.instanceId, "instanceId", 200);
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "trace-access.authorize" },
      async (tx) => {
        const instance = await this.instance(tx, instanceId);
        const routeLookup = input.channelId === undefined;
        const channelId = routeLookup ? String(instance.channel_id) : text(input.channelId, "channelId", 180);
        const terminal = !isActiveRunStatus(instance.run_status);
        const [allowedByPolicy] = await this.authorizeChecks(tx, instance,
          [{ userId: principalId, channelId }]);
        const allowed = allowedByPolicy === true && (routeLookup || !terminal);
        return { allowed, ...(routeLookup && allowed
          ? { traceRoute: { instanceId, channelId, terminal, ownerUserId: String(instance.owner_user_id) } } : {}) };
      });
  }

  async authorizeBatch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const instanceId = text(input.instanceId, "instanceId", 200);
    if (!Array.isArray(input.checks) || input.checks.length < 1 || input.checks.length > 500) {
      throw new TraceAccessControlError(
        "invalid_request", 400, "trace authorization checks must contain between 1 and 500 entries");
    }
    const checks = input.checks.map((value, index) => {
      const check = object(value, `checks[${index}]`);
      return { userId: text(check.userId, `checks[${index}].userId`, 200),
        channelId: text(check.channelId, `checks[${index}].channelId`, 180) };
    });
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "trace-access.authorize-batch" },
      async (tx) => {
        const instance = await this.instance(tx, instanceId);
        const terminal = !isActiveRunStatus(instance.run_status);
        const flags = terminal ? checks.map(() => false)
          : await this.authorizeChecks(tx, instance, checks);
        return { instanceId, decisions: checks.map((check, index) => ({ ...check, allowed: flags[index] === true })) };
      });
  }

  private async instance(tx: DatabaseTransaction, instanceId: string): Promise<QueryResultRow> {
    const rows = await tx.query<QueryResultRow>({ name: "trace_access_instance_v2", text: `SELECT
      r.owner_user_id,i.instance_id AS agent_id,i.channel_id,i.status AS instance_status,r.status AS run_status
      FROM data.instances i JOIN data.runs r ON r.run_id=i.run_id WHERE i.instance_id=$1 LIMIT 1`,
    values: [instanceId], maxRows: 1 });
    if (!rows[0]) throw new TraceAccessControlError(
      "instance_not_found", 404, "Agent Instance not found");
    return rows[0];
  }

  /**
   * Trace contents are part of the Channel conversation (#2772): the Run owner
   * reads their own trace, and another Human reads an event only while they
   * can read that event's Channel and the owner is a member of its Space.
   * Historical request grants no longer decide visibility.
   */
  private async authorizeChecks(tx: DatabaseTransaction, instance: QueryResultRow,
    checks: readonly { userId: string; channelId: string }[]): Promise<boolean[]> {
    const rows = await tx.query<QueryResultRow>({ name: "trace_access_authorize_checks_v4", text: `WITH checks AS (
      SELECT value->>'userId' AS user_id,value->>'channelId' AS channel_id,ordinality
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS item(value,ordinality)
    ) SELECT checks.ordinality,(checks.user_id=$2 OR EXISTS(SELECT 1 FROM data.channels c
      JOIN data.space_members owner ON owner.space_id=c.space_id AND owner.user_id=$2
      WHERE c.channel_id=checks.channel_id
        AND ${channelCapabilityPredicate({ capability: "trace_history_read", channelAlias: "c",
          principalKindSql: "'user'", principalIdSql: "checks.user_id" })})) AS allowed
      FROM checks ORDER BY checks.ordinality`, values: [JSON.stringify(checks), instance.owner_user_id],
    maxRows: checks.length });
    return rows.map((row) => row.allowed === true);
  }
}
