import type { QueryResultRow } from "pg";
import {
  parseSupportDiagnosticEvent, SUPPORT_HANDOFF_DAYS, SUPPORT_HANDOFF_LINE_MAX, SUPPORT_HANDOFF_LOG_EXCERPT_MAX,
  SUPPORT_HANDOFF_PARTS, type SupportDiagnosticEvent, type SupportHandoff, type SupportHandoffPart,
} from "@xmatrix/protocol";

import type { DatabaseTransaction } from "./contracts.js";
import { channelCreator } from "./channel-metadata.js";
import { requireChannelCapability } from "./channel-capability-policy.js";
import {
  CrossSpaceReadError, PostgresCrossSpaceReadRepository, removeOldTerminalGrants, type CrossSpaceRunProof,
} from "./cross-space-read-control.js";
import { SUPPORT_COLUMNS, type SupportAccessNote, supportHandoff, useSupportGrant } from "./support-handoff-grants.js";
import { commandFields } from "./command-fields.js";

/**
 * Hand to xMatrix support (docs/cross-space-read-grants.md#support-handoffs).
 *
 * A person hands one of their Channels to the support Space. The handoff is a
 * cross-Space read grant whose grantee is that Space, not one Run: it is
 * read-only, covers only the parts the person ticked, ends after 14 days, and
 * the person (or an owner or admin of their Space) can withdraw it at once.
 * Support reads as the person, so it never reaches what they cannot read.
 * Its readers are the support Space's members and the live Runs working in the
 * support conversation the handoff opened.
 */

const SUPPORT_TTL_MS = SUPPORT_HANDOFF_DAYS * 24 * 60 * 60_000;
const DIAGNOSTIC_LIMIT = 50;
const EXPIRED_EXCERPT_LIMIT = 64;

/** Who reads a handoff on support's side. */
export type SupportReader = { kind: "user"; id: string } | { kind: "run"; proof: CrossSpaceRunProof };

/** A read support may make now, as the person who handed the Channel over. */
export interface SupportHandoffRead {
  handoff: SupportHandoff;
  /** This hour's note in the person's Channel, counting this read. */
  accessNote: SupportAccessNote;
  logExcerpt?: string;
  diagnostics?: SupportDiagnosticEvent[];
}

const { text } = commandFields((field) => new CrossSpaceReadError("invalid_request", 400, `${field} is invalid`));

const notFound = () => new CrossSpaceReadError("support_handoff_not_found", 404, "Support handoff not found");

const epoch = (value: unknown) => value === null || value === undefined ? undefined : new Date(value as string).getTime();

/** The conversation's executions as allowlisted diagnostic events; a row that does not fit is dropped. */
async function conversationDiagnostics(tx: DatabaseTransaction, spaceId: string, channelId: string):
  Promise<SupportDiagnosticEvent[]> {
  const launches = await tx.query<QueryResultRow>({ name: "support_handoff_launches_v1", text: `SELECT
      state,launch_kind,error_stage,error_code,retryable,attempt,created_at,finished_at,first_reply_at
    FROM data.agent_launches WHERE space_id=$1 AND channel_id=$2 ORDER BY created_at DESC LIMIT ${DIAGNOSTIC_LIMIT}`,
  values: [spaceId, channelId], maxRows: DIAGNOSTIC_LIMIT });
  const runs = await tx.query<QueryResultRow>({ name: "support_handoff_runs_v1", text: `SELECT
      status,created_at,finished_at FROM data.runs WHERE channel_id=$1
    ORDER BY created_at DESC LIMIT ${DIAGNOSTIC_LIMIT}`, values: [channelId], maxRows: DIAGNOSTIC_LIMIT });
  const defined = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined && field !== null));
  return [
    ...launches.map((row) => defined({ kind: "launch", state: row.state, launchKind: row.launch_kind,
      errorStage: row.error_stage, errorCode: row.error_code, retryable: row.retryable === true,
      attempt: Number(row.attempt), createdAt: epoch(row.created_at), finishedAt: epoch(row.finished_at),
      firstReplyAt: epoch(row.first_reply_at) })),
    ...runs.map((row) => defined({ kind: "run", status: row.status, createdAt: epoch(row.created_at),
      finishedAt: epoch(row.finished_at) })),
  ].flatMap((event) => {
    const parsed = parseSupportDiagnosticEvent(event);
    return parsed ? [parsed] : [];
  });
}

export class PostgresSupportHandoffRepository extends PostgresCrossSpaceReadRepository {
  /** The support Space's owner, who opens its conversations; unavailable when it does not exist. */
  private async supportOwner(requestId: string, supportSpaceId: string): Promise<string> {
    const owner = await this.inSpace(requestId, "support-handoff.space", supportSpaceId, async (tx) =>
      (await tx.query<QueryResultRow>({ name: "support_handoff_space_owner_v1", text: `SELECT owner_user_id
        FROM data.spaces WHERE space_id=$1 LIMIT 1`, values: [supportSpaceId], maxRows: 1 }))[0]?.owner_user_id)
      .catch((error: unknown) => {
        if (error instanceof CrossSpaceReadError && error.status === 404) return undefined;
        throw error;
      });
    if (typeof owner !== "string") throw new CrossSpaceReadError("support_unavailable", 503,
      "xMatrix support is not set up on this deployment");
    return owner;
  }

  /** An owner or admin of the person's Space. */
  private async isSpaceAdmin(tx: DatabaseTransaction, spaceId: string, userId: string): Promise<boolean> {
    return Boolean((await tx.query({ name: "support_handoff_space_admin_v1", text: `SELECT 1 FROM data.space_members
      WHERE space_id=$1 AND user_id=$2 AND role IN ('owner','admin') LIMIT 1`,
    values: [spaceId, userId], maxRows: 1 }))[0]);
  }

  /**
   * Support's side: a member of the support Space (never a viewer), or a live
   * Run working in this handoff's support conversation.
   */
  private async isSupportReader(requestId: string, handoff: SupportHandoff, reader: SupportReader): Promise<boolean> {
    if (reader.kind === "run") {
      if (reader.proof.spaceId !== handoff.supportSpaceId || reader.proof.channelId !== handoff.supportChannelId) {
        return false;
      }
      await this.proveRun(requestId, reader.proof);
      return true;
    }
    return this.inSpace(requestId, "support-handoff.reader", handoff.supportSpaceId, async (tx) => Boolean((await tx.query({
      name: "support_handoff_reader_v1", text: `SELECT 1 FROM data.space_members WHERE space_id=$1 AND user_id=$2
        AND role IN ('owner','admin','member') LIMIT 1`, values: [handoff.supportSpaceId, reader.id], maxRows: 1 }))[0]));
  }

  private async load(requestId: string, spaceId: string, grantId: string): Promise<SupportHandoff> {
    return this.inSpace(requestId, "support-handoff.load", spaceId, async (tx) => {
      const row = (await tx.query<QueryResultRow>({ name: "support_handoff_get_v1", text: `SELECT ${SUPPORT_COLUMNS}
        FROM data.cross_space_read_grants WHERE space_id=$1 AND grant_id=$2 AND grantee='space' LIMIT 1`,
      values: [spaceId, grantId], maxRows: 1 }))[0];
      if (!row) throw notFound();
      return supportHandoff(row);
    });
  }

  /**
   * The person hands their Channel to support. Only the person who started
   * the Channel, or an owner or admin of its Space, may hand it over, and only
   * while they can read it. Every handoff is its own grant and support
   * conversation; it is approved by being made.
   */
  async handOff(input: { requestId: string; userId: string; channelId: string; supportSpaceId: string;
    line: string; parts: readonly SupportHandoffPart[]; logExcerpt?: string }):
    Promise<{ handoff: SupportHandoff; supportOwnerUserId: string }> {
    const requestId = text(input.requestId, "requestId", 200);
    const userId = text(input.userId, "userId");
    const channelId = text(input.channelId, "channelId");
    const supportSpaceId = text(input.supportSpaceId, "supportSpaceId");
    const line = text(input.line, "line", SUPPORT_HANDOFF_LINE_MAX);
    const parts = [...new Set(input.parts)];
    if (!parts.every((part) => (SUPPORT_HANDOFF_PARTS as readonly string[]).includes(part)) ||
        parts.includes("logs") !== (input.logExcerpt !== undefined)) {
      throw new CrossSpaceReadError("invalid_request", 400, "Daemon logs go with the logs part, and only with it");
    }
    const logExcerpt = input.logExcerpt === undefined ? null
      : text(input.logExcerpt, "logExcerpt", SUPPORT_HANDOFF_LOG_EXCERPT_MAX);
    const spaceId = await this.channelSpace(requestId, channelId);
    if (spaceId === supportSpaceId) throw new CrossSpaceReadError("same_space", 409,
      "This conversation is already in the support Space");
    const supportOwnerUserId = await this.supportOwner(requestId, supportSpaceId);
    const handoff = await this.inSpace(requestId, "support-handoff.create", spaceId, async (tx) => {
      await requireChannelCapability(tx, { capability: "message_content_read", channelId, spaceId,
        principal: { kind: "user", id: userId },
        error: () => new CrossSpaceReadError("channel_not_found", 404, "Channel not found") });
      const channel = (await tx.query<QueryResultRow>({ name: "support_handoff_channel_v1", text: `SELECT
          c.metadata_json,s.owner_user_id AS space_owner FROM data.channels c
          JOIN data.spaces s ON s.space_id=c.space_id WHERE c.space_id=$1 AND c.channel_id=$2 LIMIT 1`,
      values: [spaceId, channelId], maxRows: 1 }))[0];
      const creator = channelCreator(channel?.metadata_json ?? undefined,
        channel?.space_owner ? String(channel.space_owner) : undefined);
      if (creator !== userId && !await this.isSpaceAdmin(tx, spaceId, userId)) {
        throw new CrossSpaceReadError("support_handoff_forbidden", 403,
          "Only the person who started this conversation, or an owner or admin of its Space, can hand it to support");
      }
      const at = new Date();
      await this.retireLapsedHandoffs(tx, spaceId, at);
      const grantId = `csr_${crypto.randomUUID()}`;
      const rows = await tx.query<QueryResultRow>({ name: "support_handoff_insert_v1", text: `INSERT INTO
        data.cross_space_read_grants (grant_id,space_id,channel_id,scope,owner_user_id,source_space_id,
          source_channel_id,status,reason,version,requested_at,decided_at,expires_at,grantee,parts,log_excerpt)
        VALUES ($1,$2,$3,'channel',$4,$5,$6,'approved',$7,1,$8,$8,$9,'space',$10::text[],$11)
        RETURNING ${SUPPORT_COLUMNS}`,
      values: [grantId, spaceId, channelId, userId, supportSpaceId, `support-handoff:${grantId}`, line,
        at.toISOString(), new Date(at.getTime() + SUPPORT_TTL_MS).toISOString(), parts, logExcerpt], maxRows: 1 });
      return supportHandoff(rows[0]!);
    });
    return { handoff, supportOwnerUserId };
  }

  /**
   * Bounded upkeep on each new handoff: an expired handoff's log excerpt is
   * erased, and terminal grants older than 30 days leave.
   */
  private async retireLapsedHandoffs(tx: DatabaseTransaction, spaceId: string, at: Date): Promise<void> {
    await tx.query({ name: "support_handoff_expire_v1", text: `UPDATE data.cross_space_read_grants
      SET status='expired',log_excerpt=NULL,version=version+1
      WHERE grant_id IN (SELECT grant_id FROM data.cross_space_read_grants WHERE space_id=$1
        AND grantee='space' AND status='approved' AND expires_at<=$2
        ORDER BY expires_at LIMIT ${EXPIRED_EXCERPT_LIMIT})`,
    values: [spaceId, at.toISOString()], maxRows: 0 });
    await removeOldTerminalGrants(tx, spaceId, at);
  }

  /** The person who handed it over, their Space's owners and admins, and support see a handoff. */
  async readHandoff(input: { requestId: string; spaceId: string; grantId: string; viewer: SupportReader }):
    Promise<SupportHandoff & { viewerRole: "owner" | "admin" | "support" }> {
    const requestId = text(input.requestId, "requestId", 200);
    const spaceId = text(input.spaceId, "spaceId");
    const handoff = await this.load(requestId, spaceId, text(input.grantId, "grantId"));
    const viewer = input.viewer;
    if (viewer.kind === "user" && viewer.id === handoff.ownerUserId) return { ...handoff, viewerRole: "owner" };
    if (viewer.kind === "user" && await this.inSpace(requestId, "support-handoff.admin", spaceId,
      (tx) => this.isSpaceAdmin(tx, spaceId, viewer.id))) return { ...handoff, viewerRole: "admin" };
    if (await this.isSupportReader(requestId, handoff, viewer)) return { ...handoff, viewerRole: "support" };
    throw notFound();
  }

  /**
   * One read by support of a part the person ticked, made as that person. An
   * expired or withdrawn handoff, or a part they did not tick, reads nothing.
   */
  async authorizeHandoffRead(input: { requestId: string; spaceId: string; grantId: string; reader: SupportReader;
    part: SupportHandoffPart }): Promise<SupportHandoffRead> {
    const requestId = text(input.requestId, "requestId", 200);
    const spaceId = text(input.spaceId, "spaceId");
    const grantId = text(input.grantId, "grantId");
    if (!(SUPPORT_HANDOFF_PARTS as readonly string[]).includes(input.part)) throw notFound();
    const handoff = await this.load(requestId, spaceId, grantId);
    if (!await this.isSupportReader(requestId, handoff, input.reader)) throw notFound();
    return this.inSpace(requestId, "support-handoff.authorize", spaceId, async (tx) => {
      const use = await useSupportGrant(tx, { spaceId, grantId, part: input.part, at: new Date().toISOString(),
        supportSpaceId: handoff.supportSpaceId });
      if (!use) {
        throw handoff.status !== "approved" || Date.parse(handoff.expiresAt) <= Date.now()
          ? new CrossSpaceReadError("support_handoff_ended", 403, `This handoff has ${handoff.status === "revoked"
            ? "been withdrawn" : "expired"}; nothing in it can be read`)
          : new CrossSpaceReadError("support_handoff_part_not_shared", 403,
            `The person did not include ${input.part} in this handoff`);
      }
      if (input.part !== "logs") await this.requireOwnerRead(tx, spaceId, use.channelId, use.ownerUserId);
      return { handoff: { ...handoff, readCount: handoff.readCount + 1 },
        accessNote: use.accessNote,
        ...(use.logExcerpt !== undefined ? { logExcerpt: use.logExcerpt } : {}),
        ...(input.part === "diagnostics" ? { diagnostics: await conversationDiagnostics(tx, spaceId, use.channelId) } : {}) };
    });
  }

  /** Support answers the person while the handoff is live. */
  async authorizeHandoffReply(input: { requestId: string; spaceId: string; grantId: string; reader: SupportReader }):
    Promise<SupportHandoff> {
    const requestId = text(input.requestId, "requestId", 200);
    const handoff = await this.load(requestId, text(input.spaceId, "spaceId"), text(input.grantId, "grantId"));
    if (!await this.isSupportReader(requestId, handoff, input.reader)) throw notFound();
    if (handoff.status !== "approved") throw new CrossSpaceReadError("support_handoff_ended", 403,
      "This handoff has ended; answer the person by email instead");
    return handoff;
  }

  /**
   * The person, or an owner or admin of their Space, withdraws a handoff. Reads
   * stop at once and the log excerpt is erased.
   */
  async revokeHandoff(input: { requestId: string; spaceId: string; grantId: string; userId: string }):
    Promise<SupportHandoff> {
    const requestId = text(input.requestId, "requestId", 200);
    const spaceId = text(input.spaceId, "spaceId");
    const grantId = text(input.grantId, "grantId");
    const userId = text(input.userId, "userId");
    return this.inSpace(requestId, "support-handoff.revoke", spaceId, async (tx) => {
      const row = (await tx.query<QueryResultRow>({ name: "support_handoff_lock_v1", text: `SELECT ${SUPPORT_COLUMNS}
        FROM data.cross_space_read_grants WHERE space_id=$1 AND grant_id=$2 AND grantee='space' LIMIT 1 FOR UPDATE`,
      values: [spaceId, grantId], maxRows: 1 }))[0];
      if (!row || (row.owner_user_id !== userId && !await this.isSpaceAdmin(tx, spaceId, userId))) throw notFound();
      const rows = await tx.query<QueryResultRow>({ name: "support_handoff_revoke_v1", text: `UPDATE
          data.cross_space_read_grants SET status='revoked',decided_at=$3,log_excerpt=NULL,version=version+1
        WHERE space_id=$1 AND grant_id=$2 RETURNING ${SUPPORT_COLUMNS}`,
      values: [spaceId, grantId, new Date().toISOString()], maxRows: 1 });
      return supportHandoff(rows[0]!);
    });
  }
}
