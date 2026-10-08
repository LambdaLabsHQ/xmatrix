import { ControlError } from "./control-error.js";
import { storedIso as iso } from "./stored-values.js";
import type { QueryResultRow } from "pg";
import { sha256Hex } from "@xmatrix/protocol";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { requireRunRegistrationAccess } from "./agent-registration-run.js";
import { requireChannelCapability } from "./channel-capability-policy.js";
import { commandFields } from "./command-fields.js";
import { PostgresEntitySpaceDirectory } from "./entity-directory.js";
import {
  PostgresChannelSpaceDirectory,
  PostgresSpacePlacementDirectory,
} from "./placement.js";

/**
 * Cross-Space read grants (docs/cross-space-read-grants.md).
 *
 * An Agent Run reads only its own Space by default. Its owner may approve one
 * exact live Run to read a Channel family, or a whole Space, somewhere else.
 * The grant is read-only and lives in the target Space; each read re-proves the
 * Run in its own Space and then evaluates the grant and the owner's current
 * access in the target Space. The Run reads as its owner, so a grant never
 * reaches what the owner cannot read, and it never authorizes a write.
 */

const PENDING_TTL_MS = 60 * 60_000;
const GRANT_TTL_MS = 24 * 60 * 60_000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CLEANUP_LIMIT = 64;
const NOTICE_RETENTION_MS = 24 * 60 * 60_000;
const PENDING_LIST_LIMIT = 20;

export type CrossSpaceReadScope = "channel" | "space";
export type CrossSpaceReadAction = "approve" | "deny" | "revoke";

export class CrossSpaceReadError extends ControlError {
  override name = "CrossSpaceReadError";
}

/** The exact live Run a read is made for, as the Hub authenticated it. */
export interface CrossSpaceRunProof {
  agentId: string; runId: string; instanceId: string; executionKey: string;
  channelId: string; spaceId: string;
}

export interface CrossSpaceReadGrant {
  id: string; spaceId: string; channelId: string; scope: CrossSpaceReadScope;
  ownerUserId: string; agentId: string; agentName?: string; runId: string; instanceId: string;
  sourceSpaceId: string; sourceChannelId: string; noticeMessageId?: string;
  status: "pending" | "approved" | "denied" | "revoked" | "expired";
  reason?: string; version: number; readCount: number;
  requestedAt: string; decidedAt?: string; expiresAt: string; lastReadAt?: string;
}

/** Who a granted read is made as: always the Run's owner, in the target Space. */
export interface CrossSpaceReadAuthorization {
  ownerUserId: string; spaceId: string; grantId: string;
}

const { text } = commandFields((field) =>
  new CrossSpaceReadError("invalid_request", 400, `${field} is invalid`));


function grant(row: QueryResultRow, now = Date.now()): CrossSpaceReadGrant {
  const stored = String(row.status) as CrossSpaceReadGrant["status"];
  const expiresAt = iso(row.expires_at);
  // Expiry is a fact of time, not a write: an open row past its window reads
  // as expired, and the next request for the same target retires it.
  const status = (stored === "pending" || stored === "approved") && Date.parse(expiresAt) <= now
    ? "expired" : stored;
  return {
    id: String(row.grant_id), spaceId: String(row.space_id), channelId: String(row.channel_id),
    scope: String(row.scope) as CrossSpaceReadScope, ownerUserId: String(row.owner_user_id),
    agentId: String(row.agent_id), ...(row.agent_name ? { agentName: String(row.agent_name) } : {}),
    runId: String(row.run_id), instanceId: String(row.instance_id),
    sourceSpaceId: String(row.source_space_id), sourceChannelId: String(row.source_channel_id),
    ...(row.notice_message_id ? { noticeMessageId: String(row.notice_message_id) } : {}),
    status, ...(row.reason ? { reason: String(row.reason) } : {}), version: Number(row.version),
    readCount: Number(row.read_count), requestedAt: iso(row.requested_at),
    ...(row.decided_at ? { decidedAt: iso(row.decided_at) } : {}), expiresAt,
    ...(row.last_read_at ? { lastReadAt: iso(row.last_read_at) } : {}),
  };
}

const GRANT_COLUMNS = `grant_id,space_id,channel_id,scope,owner_user_id,agent_id,agent_name,run_id,
  instance_id,source_space_id,source_channel_id,notice_message_id,status,reason,version,read_count,
  requested_at,decided_at,expires_at,last_read_at`;

export class PostgresCrossSpaceReadRepository {
  private readonly channels: PostgresChannelSpaceDirectory;
  private readonly entities: PostgresEntitySpaceDirectory;
  private readonly placements: PostgresSpacePlacementDirectory;

  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new CrossSpaceReadError(
      "cached_authority_forbidden", 500, "Cross-Space read authority requires uncached PostgreSQL");
    this.placements = new PostgresSpacePlacementDirectory(database);
    this.channels = new PostgresChannelSpaceDirectory(database);
    this.entities = new PostgresEntitySpaceDirectory(database);
  }

  /** One transaction on the shard that holds `spaceId`, while it is not moving. */
  private async inSpace<T>(requestId: string, operation: string, spaceId: string,
    work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    const placement = await this.placements.resolveWritable(
      { requestId, operation: `${operation}.placement` }, spaceId, () => new CrossSpaceReadError(
        "space_placement_unavailable", 503, "Space placement is unavailable", true));
    return this.database.transaction({ requestId, operation, placement: { spaceId,
      shardId: placement.shardId, placementEpoch: placement.placementEpoch } }, work);
  }

  /** The target Channel's Space, or not found; never an existence oracle. */
  private async channelSpace(requestId: string, channelId: string): Promise<string> {
    const route = await this.channels.resolve({ requestId, operation: "cross-space-read.channel.locate" },
      text(channelId, "channelId"));
    if (!route) throw new CrossSpaceReadError("channel_not_found", 404, "Channel not found");
    return route.spaceId;
  }

  /**
   * Prove the exact live Run in its own Space, the way invocation diagnostics
   * do, and return its owner. Channel About Runs never read outside their
   * Channel, so they cannot hold a grant.
   */
  private async proveRun(requestId: string, proof: CrossSpaceRunProof): Promise<{
    ownerUserId: string; agentName: string | null; executionKeyDigest: string }> {
    const runId = text(proof.runId, "runId");
    const route = await this.entities.resolve({ requestId, operation: "cross-space-read.run.locate" }, "run", runId);
    if (!route || route.spaceId !== proof.spaceId) throw new CrossSpaceReadError(
      "agent_run_forbidden", 403, "Credentials do not match a live Run");
    return this.inSpace(requestId, "cross-space-read.run.prove", route.spaceId, async (tx) => {
      const run = (await tx.query<QueryResultRow>({ name: "cross_space_read_run_v2", text: `SELECT
          r.owner_user_id,r.channel_id,r.status,r.metadata_json,i.instance_id,
          COALESCE(registration.display_name,r.metadata_json->>'agentName') AS agent_name
        FROM data.runs r JOIN data.instances i ON i.run_id=r.run_id AND i.channel_id=r.channel_id
        LEFT JOIN data.run_agent_registrations binding ON binding.run_id=r.run_id
        LEFT JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
          AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
          AND registration.harness=binding.harness
        WHERE r.run_id=$1 AND i.instance_id=$2 LIMIT 1`,
      values: [runId, text(proof.instanceId, "instanceId")], maxRows: 1 }))[0];
      const metadata = (run?.metadata_json ?? {}) as Record<string, unknown>;
      if (!run || run.instance_id !== proof.agentId ||
          run.channel_id !== proof.channelId || metadata.executionKey !== proof.executionKey ||
          !["starting", "running"].includes(String(run.status)) ||
          metadata.instanceDeletion !== undefined || metadata.instanceHandoff !== undefined ||
          metadata.executionCancellation !== undefined ||
          metadata.routedAs === "management_channel_about") {
        throw new CrossSpaceReadError("agent_run_forbidden", 403, "Credentials do not match a live Run");
      }
      await requireRunRegistrationAccess(tx, { runId, channelId: proof.channelId,
        phase: run.status === "starting" ? "admission" : "continuation",
        error: (code, status) => new CrossSpaceReadError(code, status, "Registration no longer authorizes this Run") });
      return { ownerUserId: String(run.owner_user_id),
        agentName: run.agent_name ? String(run.agent_name).slice(0, 200) : null,
        executionKeyDigest: await sha256Hex(proof.executionKey) };
    });
  }

  /** The owner may read the Channel now; a Channel they cannot see does not exist. */
  private async requireOwnerRead(tx: DatabaseTransaction, spaceId: string, channelId: string,
    ownerUserId: string): Promise<void> {
    await requireChannelCapability(tx, { capability: "message_content_read", channelId, spaceId,
      principal: { kind: "user", id: ownerUserId },
      error: () => new CrossSpaceReadError("channel_not_found", 404, "Channel not found") });
  }

  private async requireOwnerMember(tx: DatabaseTransaction, spaceId: string, ownerUserId: string): Promise<void> {
    const member = await tx.query({ name: "cross_space_read_owner_member_v1", text: `SELECT 1
      FROM data.space_members WHERE space_id=$1 AND user_id=$2 LIMIT 1`,
    values: [spaceId, ownerUserId], maxRows: 1 });
    if (!member[0]) throw new CrossSpaceReadError("space_not_found", 404, "Space not found");
  }

  /**
   * Ask the Run's owner for a grant. Reuses the open request or grant for the
   * same Run and target, so a retried request never raises a second card.
   */
  async request(input: { requestId: string; proof: CrossSpaceRunProof; channelId: string;
    scope: CrossSpaceReadScope; reason?: string | null }): Promise<{ grant: CrossSpaceReadGrant; created: boolean }> {
    const requestId = text(input.requestId, "requestId", 200);
    if (input.scope !== "channel" && input.scope !== "space") throw new CrossSpaceReadError(
      "invalid_request", 400, "scope must be channel or space");
    const reason = input.reason === undefined || input.reason === null || !String(input.reason).trim()
      ? null : text(input.reason, "reason", 500);
    const run = await this.proveRun(requestId, input.proof);
    const spaceId = await this.channelSpace(requestId, input.channelId);
    if (spaceId === input.proof.spaceId) throw new CrossSpaceReadError("same_space", 409,
      "This Run already reads its own Space; no grant is needed");
    const result = await this.inSpace(requestId, "cross-space-read.request", spaceId, async (tx) => {
      await this.requireOwnerRead(tx, spaceId, input.channelId, run.ownerUserId);
      const at = new Date();
      await tx.query({ name: "cross_space_read_retire_stale_v1", text: `UPDATE data.cross_space_read_grants
        SET status='expired',version=version+1 WHERE run_id=$1 AND space_id=$2
          AND status IN ('pending','approved') AND expires_at<=$3`,
      values: [input.proof.runId, spaceId, at.toISOString()], maxRows: 0 });
      await tx.query({ name: "cross_space_read_cleanup_v1", text: `DELETE FROM data.cross_space_read_grants
        WHERE grant_id IN (SELECT grant_id FROM data.cross_space_read_grants WHERE space_id=$1
          AND status IN ('denied','revoked','expired') AND requested_at<$2
          ORDER BY requested_at LIMIT ${CLEANUP_LIMIT})`,
      values: [spaceId, new Date(at.getTime() - TERMINAL_RETENTION_MS).toISOString()], maxRows: 0 });
      const existing = (await tx.query<QueryResultRow>({ name: "cross_space_read_open_v1", text: `SELECT
          ${GRANT_COLUMNS},execution_key_digest FROM data.cross_space_read_grants
        WHERE run_id=$1 AND space_id=$2 AND status IN ('pending','approved')
          AND (scope='space' OR (scope=$3 AND channel_id=$4))
        ORDER BY (scope=$3) DESC LIMIT 1 FOR UPDATE`,
      values: [input.proof.runId, spaceId, input.scope, input.channelId], maxRows: 1 }))[0];
      if (existing && existing.instance_id === input.proof.instanceId &&
          existing.execution_key_digest === run.executionKeyDigest) {
        return { grant: grant(existing), created: false };
      }
      if (existing) {
        // Same Run id, different execution: the old grant belonged to it alone.
        await tx.query({ name: "cross_space_read_retire_execution_v1", text: `UPDATE
          data.cross_space_read_grants SET status='expired',version=version+1 WHERE grant_id=$1`,
        values: [existing.grant_id], maxRows: 0 });
      }
      const rows = await tx.query<QueryResultRow>({ name: "cross_space_read_insert_v1", text: `INSERT INTO
        data.cross_space_read_grants (grant_id,space_id,channel_id,scope,owner_user_id,agent_id,agent_name,
          run_id,instance_id,execution_key_digest,source_space_id,source_channel_id,status,reason,version,
          requested_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,1,$14,$15)
        RETURNING ${GRANT_COLUMNS}`,
      values: [`csr_${crypto.randomUUID()}`, spaceId, input.channelId, input.scope, run.ownerUserId,
        input.proof.agentId, run.agentName, input.proof.runId, input.proof.instanceId, run.executionKeyDigest,
        input.proof.spaceId, input.proof.channelId, reason, at.toISOString(),
        new Date(at.getTime() + PENDING_TTL_MS).toISOString()], maxRows: 1 });
      return { grant: grant(rows[0]!), created: true };
    });
    if (result.grant.status === "pending") await this.recordNotice(requestId, result.grant);
    return result;
  }

  /**
   * Point the Run's own Channel at the pending request, in the Run's own Space,
   * so that Channel can list what waits for its owner. Written after the grant
   * commits and on every retry, so a lost write heals on the next request.
   */
  private async recordNotice(requestId: string, pending: CrossSpaceReadGrant): Promise<void> {
    await this.inSpace(requestId, "cross-space-read.notice.record", pending.sourceSpaceId, async (tx) => {
      const at = new Date();
      await tx.query({ name: "cross_space_read_notice_cleanup_v1", text: `DELETE FROM data.cross_space_read_notices
        WHERE (space_id,grant_id) IN (SELECT space_id,grant_id FROM data.cross_space_read_notices
          WHERE space_id=$1 AND expires_at<$2 ORDER BY expires_at LIMIT ${CLEANUP_LIMIT})`,
      values: [pending.sourceSpaceId, new Date(at.getTime() - NOTICE_RETENTION_MS).toISOString()], maxRows: 0 });
      await tx.query({ name: "cross_space_read_notice_insert_v1", text: `INSERT INTO data.cross_space_read_notices
        (space_id,channel_id,grant_id,grant_space_id,owner_user_id,requested_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (space_id,grant_id) DO NOTHING`,
      values: [pending.sourceSpaceId, pending.sourceChannelId, pending.id, pending.spaceId, pending.ownerUserId,
        pending.requestedAt, pending.expiresAt], maxRows: 0 });
    });
  }

  /**
   * The requests waiting for this viewer's decision that were made from one
   * Channel. The locator rows name candidates only; each grant is read from its
   * own Space as its owner, so a decided, expired, or foreign grant never shows.
   */
  async pendingForChannel(input: { requestId: string; channelId: string; viewerUserId: string }):
    Promise<CrossSpaceReadGrant[]> {
    const requestId = text(input.requestId, "requestId", 200);
    const channelId = text(input.channelId, "channelId");
    const viewerUserId = text(input.viewerUserId, "viewerUserId");
    const spaceId = await this.channelSpace(requestId, channelId);
    const candidates = await this.inSpace(requestId, "cross-space-read.notice.list", spaceId, async (tx) => {
      await this.requireOwnerRead(tx, spaceId, channelId, viewerUserId);
      return tx.query<QueryResultRow>({ name: "cross_space_read_notice_list_v1", text: `SELECT grant_id,grant_space_id
        FROM data.cross_space_read_notices WHERE space_id=$1 AND channel_id=$2 AND owner_user_id=$3
          AND expires_at>$4 ORDER BY requested_at DESC,grant_id LIMIT ${PENDING_LIST_LIMIT}`,
      values: [spaceId, channelId, viewerUserId, new Date().toISOString()], maxRows: PENDING_LIST_LIMIT });
    });
    const grants: CrossSpaceReadGrant[] = [];
    for (const candidate of candidates) {
      try {
        const current = await this.read({ requestId, spaceId: String(candidate.grant_space_id),
          grantId: String(candidate.grant_id), principal: { kind: "user", id: viewerUserId } });
        if (current.status === "pending") grants.push(current);
      } catch (error) {
        // A grant whose Space is gone or moving is not an approval anyone can make now.
        if (!(error instanceof CrossSpaceReadError)) throw error;
      }
    }
    return grants;
  }

  /** Record which card in the source Channel shows this request. */
  async attachNotice(input: { requestId: string; spaceId: string; grantId: string; messageId: string }): Promise<void> {
    await this.inSpace(text(input.requestId, "requestId", 200), "cross-space-read.notice",
      text(input.spaceId, "spaceId"), async (tx) => {
        await tx.query({ name: "cross_space_read_notice_v1", text: `UPDATE data.cross_space_read_grants
          SET notice_message_id=$3 WHERE space_id=$1 AND grant_id=$2 AND notice_message_id IS NULL`,
        values: [input.spaceId, text(input.grantId, "grantId"), text(input.messageId, "messageId")], maxRows: 0 });
      });
  }

  /** The owner, or the exact Run the grant names, may read its state. */
  async read(input: { requestId: string; spaceId: string; grantId: string;
    principal: { kind: "user"; id: string } | { kind: "agent"; proof: CrossSpaceRunProof } }): Promise<CrossSpaceReadGrant> {
    const requestId = text(input.requestId, "requestId", 200);
    const spaceId = text(input.spaceId, "spaceId");
    const grantId = text(input.grantId, "grantId");
    const principal = input.principal;
    if (principal.kind === "agent") await this.proveRun(requestId, principal.proof);
    return this.inSpace(requestId, "cross-space-read.read", spaceId, async (tx) => {
      const row = (await tx.query<QueryResultRow>({ name: "cross_space_read_get_v1", text: `SELECT
          ${GRANT_COLUMNS} FROM data.cross_space_read_grants WHERE space_id=$1 AND grant_id=$2 LIMIT 1`,
      values: [spaceId, grantId], maxRows: 1 }))[0];
      const visible = row && (principal.kind === "user"
        ? row.owner_user_id === principal.id
        : row.run_id === principal.proof.runId && row.instance_id === principal.proof.instanceId);
      if (!visible) throw new CrossSpaceReadError("grant_not_found", 404, "Grant not found");
      return grant(row);
    });
  }

  /**
   * Only the Run's owner decides. Approval may narrow a Space-wide request to
   * the Channel it named, never widen one; revoke ends an approved grant now.
   */
  async decide(input: { requestId: string; spaceId: string; grantId: string; ownerUserId: string;
    action: CrossSpaceReadAction; scope?: CrossSpaceReadScope }): Promise<CrossSpaceReadGrant> {
    const requestId = text(input.requestId, "requestId", 200);
    const spaceId = text(input.spaceId, "spaceId");
    const grantId = text(input.grantId, "grantId");
    const ownerUserId = text(input.ownerUserId, "ownerUserId");
    if (!["approve", "deny", "revoke"].includes(input.action)) throw new CrossSpaceReadError(
      "invalid_request", 400, "action must be approve, deny, or revoke");
    if (input.scope !== undefined && input.scope !== "channel" && input.scope !== "space") {
      throw new CrossSpaceReadError("invalid_request", 400, "scope must be channel or space");
    }
    return this.inSpace(requestId, "cross-space-read.decide", spaceId, async (tx) => {
      const row = (await tx.query<QueryResultRow>({ name: "cross_space_read_decide_lock_v1", text: `SELECT
          ${GRANT_COLUMNS} FROM data.cross_space_read_grants WHERE space_id=$1 AND grant_id=$2 LIMIT 1
        FOR UPDATE`, values: [spaceId, grantId], maxRows: 1 }))[0];
      if (!row || row.owner_user_id !== ownerUserId) throw new CrossSpaceReadError(
        "grant_not_found", 404, "Grant not found");
      const current = grant(row);
      const at = new Date();
      if (input.action === "revoke") {
        if (current.status === "revoked") return current;
        if (current.status !== "approved") throw new CrossSpaceReadError("grant_not_active", 409,
          `Grant is ${current.status}; only an approved grant can be revoked`);
      } else {
        const target = input.action === "approve" ? "approved" : "denied";
        if (current.status === target && (input.action === "deny" || !input.scope || input.scope === current.scope)) {
          return current;
        }
        if (current.status !== "pending") throw new CrossSpaceReadError("grant_not_pending", 409,
          `Grant is ${current.status}; ask the Agent to request access again`);
      }
      if (input.action === "approve") {
        const scope = input.scope ?? current.scope;
        if (scope === "space" && current.scope === "channel") throw new CrossSpaceReadError(
          "scope_widening_forbidden", 400, "Approval cannot widen a Channel request to its whole Space");
        // Approval is authority over the owner's own data; recheck it now.
        await this.requireOwnerRead(tx, spaceId, current.channelId, ownerUserId);
        const rows = await tx.query<QueryResultRow>({ name: "cross_space_read_approve_v1", text: `UPDATE
            data.cross_space_read_grants SET status='approved',scope=$3,decided_at=$4,expires_at=$5,
              version=version+1
          WHERE space_id=$1 AND grant_id=$2 RETURNING ${GRANT_COLUMNS}`,
        values: [spaceId, grantId, scope, at.toISOString(), new Date(at.getTime() + GRANT_TTL_MS).toISOString()],
        maxRows: 1 });
        return grant(rows[0]!);
      }
      const rows = await tx.query<QueryResultRow>({ name: "cross_space_read_close_v1", text: `UPDATE
          data.cross_space_read_grants SET status=$3,decided_at=$4,version=version+1
        WHERE space_id=$1 AND grant_id=$2 RETURNING ${GRANT_COLUMNS}`,
      values: [spaceId, grantId, input.action === "deny" ? "denied" : "revoked", at.toISOString()], maxRows: 1 });
      return grant(rows[0]!);
    });
  }

  /**
   * Authorize one read outside the Run's own Space and say who it is made as.
   * Returns null for a target inside the Run's own Space: the ordinary Agent
   * path owns that read. `channelId` names a Channel read; `spaceId` alone
   * names a Space-wide catalog read, which only a Space grant covers.
   */
  async authorizeRead(input: { requestId: string; proof: CrossSpaceRunProof; channelId?: string;
    spaceId?: string }): Promise<CrossSpaceReadAuthorization | null> {
    const requestId = text(input.requestId, "requestId", 200);
    const channelId = input.channelId === undefined ? null : text(input.channelId, "channelId");
    if (!channelId && input.spaceId === undefined) throw new CrossSpaceReadError(
      "invalid_request", 400, "Name a Channel or a Space");
    const spaceId = channelId ? await this.channelSpace(requestId, channelId) : text(input.spaceId, "spaceId");
    if (spaceId === input.proof.spaceId) return null;
    const run = await this.proveRun(requestId, input.proof);
    return this.inSpace(requestId, "cross-space-read.authorize", spaceId, async (tx) => {
      const at = new Date().toISOString();
      const rows = await tx.query<QueryResultRow>({ name: "cross_space_read_use_v2", text: `UPDATE
          data.cross_space_read_grants g SET read_count=g.read_count+1,last_read_at=$6
        WHERE g.grant_id=(SELECT c.grant_id FROM data.cross_space_read_grants c
          WHERE c.space_id=$1 AND c.run_id=$2 AND c.instance_id=$3 AND c.execution_key_digest=$4
            AND c.owner_user_id=$5 AND c.status='approved' AND c.expires_at>$6
            AND (c.scope='space' OR ($7::text IS NOT NULL AND (c.channel_id=$7 OR c.channel_id=(
              SELECT t.metadata_json->>'threadRootChannelId' FROM data.channels t
                WHERE t.space_id=$1 AND t.channel_id=$7 AND t.metadata_json->>'kind'='thread'))))
          ORDER BY (c.scope='space') DESC,c.grant_id LIMIT 1)
        RETURNING g.grant_id`,
      values: [spaceId, input.proof.runId, input.proof.instanceId, run.executionKeyDigest,
        run.ownerUserId, at, channelId], maxRows: 1 });
      if (!rows[0]) throw new CrossSpaceReadError("cross_space_read_grant_required", 403,
        "This Run has no approved grant to read outside its own Space; " +
        "ask its owner with `xmatrix access request <channel>`");
      if (channelId) await this.requireOwnerRead(tx, spaceId, channelId, run.ownerUserId);
      else await this.requireOwnerMember(tx, spaceId, run.ownerUserId);
      return { ownerUserId: run.ownerUserId, spaceId, grantId: String(rows[0].grant_id) };
    });
  }
}
