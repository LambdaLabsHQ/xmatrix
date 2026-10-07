import { recordAboutInput } from "./channel-metadata-revisions.js";
import { authorizeDingTalkEffect, finishDingTalkEffect, type DingTalkEffectAuthority } from "./dingtalk-effect-authority.js";
import { requireAgentChannelAccess } from "./agent-channel-access.js";
import type { QueryResultRow } from "pg";
import { resolveMessageAgentTargets } from "./message-agent-targets.js";
import { channelStopScope, fenceChannelRunsForStop } from "./channel-stop-fence.js";
import { requireRunRegistrationAccess } from "./agent-registration-run.js";
import { authorizeMessageInvocationSelections, bodyWithoutInvocationSelections } from "./message-invocation-selections.js";
import type { AgentRegistrationKey, MessageCommitReceipt } from "@xmatrix/protocol";
import { channelVisibilityScope, isReservedAnnotationNamespace, SYSTEM_ANNOTATION_AUTHOR , utf8ByteLength } from "@xmatrix/protocol";
import { atomicAttentionTargets, MAX_ATTENTION_TARGETS } from "./message-attention-targets.js";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { writeOutbox } from "./outbox.js";
import {
  channelCapabilityCte,
  channelCapabilityPredicate,
  requireChannelCapability,
  requireAuthorizedChannel,
  type ChannelCapability,
  type ChannelCapabilityGrant,
} from "./channel-capability-policy.js";
import { spaceBilling, type SpaceBillingPolicy } from "@xmatrix/billing";
import { MessageAuthorityError } from "./message-authority-error.js";
import { storedMessagePreview, type MessagePreview } from "./message-preview.js";
import { PostgresSpacePlacementDirectory, type SpacePlacement } from "./placement.js";
import { hydrateHistoryAttachmentVersions } from "./message-history-attachments.js";
import { hydrateTombstoneSenders } from "./message-history-tombstone-senders.js";
import { serializeMessageRow, type MessageRow as StoredMessageRow } from "./message-row.js";

const messageCapabilityError = (failure: {
  code: "channel_not_found"; status: 404; message: string;
}) => new MessageAuthorityError(failure.code, failure.status, failure.message);

function messageChannelCapability(transaction: DatabaseTransaction,
  input: { spaceId: string; channelId: string; principal: MessagePrincipal },
  capability: ChannelCapability): Promise<ChannelCapabilityGrant> {
  return requireChannelCapability(transaction, { ...input, capability, error: messageCapabilityError });
}

export { MessageAuthorityError } from "./message-authority-error.js";

const MAX_HISTORY_PAGE = 200;
const MAX_SEARCH_CANDIDATE_PAGE = 1_000;
const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type MessagePrincipal = { kind: "user" | "agent"; id: string };

export type PostgresMessageSenderIdentity =
  | { kind: "user"; id: string; email: string | null; displayName: string | null;
      avatarUrl: string | null; version: number }
  | { kind: "agent"; id: string; name: string; runtime: string; ownerUserId: string;
      ownerEmail: string | null; metadata: Record<string, unknown>; version: number };

export interface PostgresMessageAgentRunIdentity {
  registration: AgentRegistrationKey;
  runId: string;
  instanceId: string;
  channelId: string;
  channelInstanceId: number;
  /** Send-time presentation, read from the Instance row this append already
   *  locks for authorization. Absent when the Instance has reported none. */
  presentation?: Record<string, unknown>;
  /** Set only when the Run writes outside its own Channel: the Channel it came
   *  from and the message it was handling there, both read from the Run's own
   *  records. Never taken from the caller. */
  origin?: { channelId: string; runId: string; messageId?: string };
  managementDelegate?: {
    spaceId: string;
    configGeneration: number;
  };
}

export interface PreparedPostgresMessageAppend {
  sequence: number;
  principal: MessagePrincipal;
  senderIdentity?: PostgresMessageSenderIdentity;
  agentRunIdentity?: PostgresMessageAgentRunIdentity;
}

export interface PostgresMessageSequenceReservation {
  sequence: number;
  state: "reserved" | "committed";
}

export interface PreparedPostgresMessageRecord {
  codecId: string;
  payloadSchemaVersion: number;
  fieldPresenceBase64: string;
  payloadBundleBase64: string;
  bodyHash: string;
  senderSnapshotDigest: string;
  recordDigest: string;
  recordEncodedBytes: number;
  /** Derived from this payload by its writer; stored beside it, never instead of it. */
  preview: MessagePreview;
}

export interface PostgresMessagePlacement {
  spaceId: string;
  shardId: string;
  placementEpoch: number;
}

export interface AppendPostgresMessage {
  requestId: string;
  commandId: string;
  spaceId: string;
  channelId: string;
  messageId: string;
  sequence: number;
  principal: MessagePrincipal;
  senderKind: "user" | "agent" | "app" | "system";
  senderId: string;
  messageKind: string;
  sentAt: string;
  requestDigest: string;
  prepared: PreparedPostgresMessageRecord;
  /** Computed from raw HTTP content by the trusted Agent send boundary. */
  agentSendFingerprint?: string;
  /** Explicit final intent, bound to the authenticated sender's Run below. */
  finalReplyExecutionId?: string;
  senderSnapshot: Record<string, unknown>;
  /** Legacy trusted resolver input. New PostgreSQL writes resolve attention atomically from attentionBody. */
  attentionTargets?: Array<{ subjectId: string; kind: "mention" | "broadcast" }>;
  attentionBody?: string;
  /** Untrusted picker intent, validated against the canonical body and current grants. */
  invocationSelections?: unknown;
  runProof?: {
    runId: string;
    executionKey: string;
    instanceId: string;
  };
  attachments?: Record<string, unknown>[];
  attachmentOwnerUserId?: string;
  replyToMessageId?: string;
  /** Reuse the authoritative Channel directory route already read by this HTTP request. */
  placement?: PostgresMessagePlacement;
}

interface AppendRunRow extends QueryResultRow {
  owner_user_id: string;
  channel_id: string;
  run_status: string;
  instance_status: string;
  instance_channel_id: string;
  channel_instance_id: string | number;
  presentation_json: Record<string, unknown> | null;
  metadata_json: Record<string, unknown> | null;
}

interface PreparedAppendContextRow extends QueryResultRow {
  sequence: string | number;
  sender_identity: Record<string, unknown> | null;
  channel_authorized: boolean;
}

interface AppendPreflightRow extends QueryResultRow {
  command_kind: string | null;
  request_digest: string | null;
  result_json: Record<string, unknown> | null;
  channel_id: string | null;
  channel_mode: string | null;
  channel_metadata_json: Record<string, unknown> | null;
  channel_authorized: boolean | null;
  duplicate_exists: boolean;
}

interface AppendCommittedFactsRow extends QueryResultRow {
  search_rank: string;
  content_revision: string | number;
  channel_id: string;
}

interface MessageRow extends StoredMessageRow {
  /** Set on history reads only: who a payload-less tombstone was from. */
  tombstone_sender?: Record<string, unknown>;
}

interface ThreadSummaryRow extends QueryResultRow {
  root_message_id: string;
  thread_channel_id: string;
  thread_updated_at: Date | string;
  reply_count: string | number;
  reply_rows: MessageRow[];
}

interface MutableMessageRow extends MessageRow {
  space_id: string;
  channel_mode: string;
}

export interface PostgresMessageMutationBase {
  requestId: string;
  commandId: string;
  requestDigest: string;
  spaceId: string;
  channelId: string;
  messageId: string;
  expectedEntityVersion: number;
  principal: MessagePrincipal;
}

export type PostgresMessageCollectionMutation = PostgresMessageMutationBase & (
  | { kind: "reaction"; emoji: string; reactorLabel: string }
  | {
      kind: "annotation";
      action: "upsert" | "remove";
      annotationId: string;
      namespace?: string;
      payload?: Record<string, unknown>;
      authorLabel?: string;
    }
  | {
      kind: "attachment";
      action: "add" | "remove";
      attachmentId?: string;
      sealedAttachments?: Record<string, unknown>[];
      attachmentOwnerUserId?: string;
    }
);

export interface PostgresSenderSnapshotRepair {
  requestId: string;
  commandId: string;
  requestDigest: string;
  spaceId: string;
  channelId: string;
  principal: MessagePrincipal;
  agentId: string;
  repairedAt: string;
  repairs: Array<{
    messageId: string;
    expectedEntityVersion: number;
    expectedRecordDigest: string;
    prepared: PreparedPostgresMessageRecord;
  }>;
}

function bounded(value: unknown, field: string, maximum = 300): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || utf8ByteLength(normalized) > maximum) {
    throw new MessageAuthorityError("invalid_command", 400, `${field} is invalid`);
  }
  return normalized;
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new MessageAuthorityError("invalid_command", 400, `${field} is invalid`);
  }
  return Number(value);
}

function nonnegative(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new MessageAuthorityError("invalid_command", 400, `${field} is invalid`);
  }
  return Number(value);
}

function timestamp(value: unknown, field: string): string {
  const date = new Date(bounded(value, field, 64));
  if (!Number.isFinite(date.getTime())) {
    throw new MessageAuthorityError("invalid_command", 400, `${field} is invalid`);
  }
  return date.toISOString();
}

function digest(value: unknown, field: string): string {
  const normalized = bounded(value, field, 64);
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new MessageAuthorityError("invalid_command", 400, `${field} is invalid`);
  }
  return normalized;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new MessageAuthorityError("postgres_fact_invalid", 500, "PostgreSQL timestamp is invalid");
  }
  return date.toISOString();
}

function channelRequest(input: {
  requestId: string;
  spaceId: string;
  channelId: string;
}): { requestId: string; spaceId: string; channelId: string } {
  return {
    requestId: bounded(input.requestId, "requestId", 200),
    spaceId: bounded(input.spaceId, "spaceId"),
    channelId: bounded(input.channelId, "channelId"),
  };
}

function messageScope(input: {
  requestId: string;
  spaceId: string;
  channelId: string;
  principal: MessagePrincipal;
}): { requestId: string; spaceId: string; channelId: string; principal: MessagePrincipal } {
  if (input.principal.kind !== "user" && input.principal.kind !== "agent") {
    throw new MessageAuthorityError("invalid_principal", 400, "principal is invalid");
  }
  return {
    ...channelRequest(input),
    principal: { kind: input.principal.kind, id: bounded(input.principal.id, "principal.id") },
  };
}

function messageIdentity(input: Parameters<typeof messageScope>[0] & { messageId: string }) {
  return { ...messageScope(input), messageId: bounded(input.messageId, "messageId") };
}

function requireMessageUpdate(rows: readonly QueryResultRow[]): void {
  if (!rows[0]) throw new MessageAuthorityError("message_version_conflict", 409, "Message version changed");
}

async function activeAppendPrincipal(transaction: DatabaseTransaction,
  input: Parameters<typeof effectiveAppendPrincipal>[1]) {
  const authorized = await effectiveAppendPrincipal(transaction, input);
  await messageChannelCapability(transaction, { ...input, principal: authorized.principal },
    "message_active_command_preflight");
  return authorized;
}

type MessageMutation = ReturnType<typeof messageMutation>;

/**
 * Puts the next version of annotation `annotationId` into a message's
 * annotation `collection` (replacing the entry at `index`, if any) and stores it.
 */
async function putMessageAnnotation(transaction: DatabaseTransaction, name: string, input: {
  spaceId: string; channelId: string; messageId: string; annotationId: string; namespace: string;
  collection: Record<string, unknown>[]; index: number;
  authorUserId: string; authorLabel: string; payload: unknown; now: string;
}) {
  const { spaceId, channelId, messageId, annotationId, namespace, collection, index, now } = input;
  const previous = index >= 0 ? collection[index] : undefined;
  const annotation = {
    id: annotationId, namespace, target: { kind: "message", messageId },
    authorUserId: input.authorUserId, authorLabel: input.authorLabel, payload: input.payload,
    version: previous ? Number(previous.version ?? 0) + 1 : 1,
    createdAt: previous?.createdAt ?? now, updatedAt: now,
  };
  if (index >= 0) collection[index] = annotation;
  else collection.push(annotation);
  await transaction.query({
    name,
    text: `INSERT INTO data.message_annotations
      (space_id, annotation_id, channel_id, message_id, namespace, target_kind,
       payload_json, author_user_id, author_label, version, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,'message',$6::jsonb,$7,$8,$9,$10,$11)
      ON CONFLICT (space_id, annotation_id) DO UPDATE SET namespace = EXCLUDED.namespace,
        payload_json = EXCLUDED.payload_json, author_label = EXCLUDED.author_label,
        version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`,
    values: [spaceId, annotationId, channelId, messageId, namespace, JSON.stringify(input.payload),
      input.authorUserId, input.authorLabel, annotation.version, annotation.createdAt, now],
    maxRows: 0,
  });
  return annotation;
}

/**
 * Stores a message's changed `column` collection at `entityVersion`, failing
 * when the message moved past `expectedVersion`. `invocationInputVersion` is
 * the SQL its invocation input version becomes, or null to leave it.
 */
async function writeMessageCollection(transaction: DatabaseTransaction, name: string, input: {
  spaceId: string; channelId: string; messageId: string;
  column: "reactions_json" | "annotations_json" | "attachments_json"; invocationInputVersion: string | null;
  collection: Record<string, unknown>[]; entityVersion: number; expectedVersion: number; now: string;
}): Promise<void> {
  const invocation = input.invocationInputVersion === null ? ""
    : ` invocation_input_version = ${input.invocationInputVersion},`;
  const updated = await transaction.query({
    name,
    text: `UPDATE data.messages SET ${input.column} = $4::jsonb, entity_version = $5,${invocation}
      updated_at = $6 WHERE space_id = $1 AND channel_id = $2 AND message_id = $3
      AND entity_version = $7 RETURNING message_id`,
    values: [input.spaceId, input.channelId, input.messageId, JSON.stringify(input.collection),
      input.entityVersion, input.now, input.expectedVersion], maxRows: 1,
  });
  requireMessageUpdate(updated);
}

/** A command that changes one message at the entity version its caller saw. */
function messageMutation(input: PostgresMessageMutationBase) {
  return {
    ...messageScope(input),
    commandId: bounded(input.commandId, "commandId"),
    messageId: bounded(input.messageId, "messageId"),
    expectedVersion: positive(input.expectedEntityVersion, "expectedEntityVersion"),
    requestDigest: digest(input.requestDigest, "requestDigest"),
  };
}

/** The message a Run is handling is the source of its newest unfinished
 *  execution in its own Channel. A Run that is between turns has none, and the
 *  link then names only the Channel. */
async function agentRunOrigin(
  transaction: DatabaseTransaction, runId: string, channelId: string,
): Promise<{ channelId: string; runId: string; messageId?: string }> {
  const source = (await transaction.query<QueryResultRow & { source_message_id: string }>({
    name: "message_append_run_origin_v1",
    text: `SELECT source_message_id FROM data.agent_message_executions
      WHERE run_id=$1 AND channel_id=$2 AND state IN ('accepted','running')
      ORDER BY source_sequence DESC LIMIT 1`,
    values: [runId, channelId], maxRows: 1,
  }))[0];
  return { channelId, runId, ...(source ? { messageId: source.source_message_id } : {}) };
}

async function effectiveAppendPrincipal(
  transaction: DatabaseTransaction,
  input: {
    spaceId: string;
    channelId: string;
    principal: MessagePrincipal;
    runProof?: AppendPostgresMessage["runProof"];
  },
  /** "message_append" when this transaction goes on to write the Channel. */
  capability: "message_active_command" | "message_append" = "message_active_command",
): Promise<{
  principal: MessagePrincipal;
  agentRunIdentity?: PostgresMessageAgentRunIdentity;
  /** The Human who owns the proven Run, read from the Run itself. */
  runOwnerUserId?: string;
}> {
  if (!input.runProof) return { principal: input.principal };
  if (input.principal.kind !== "agent") throw new MessageAuthorityError(
    "invalid_run_proof", 403, "Only an Agent may present an Agent Run proof",
  );
  const proof = {
    runId: bounded(input.runProof.runId, "runProof.runId"),
    executionKey: bounded(input.runProof.executionKey, "runProof.executionKey"),
    instanceId: bounded(input.runProof.instanceId, "runProof.instanceId"),
  };
  const run = (await transaction.query<AppendRunRow>({
    name: "message_append_run_proof_v3",
    text: `SELECT r.owner_user_id,r.channel_id,r.status AS run_status,
      r.metadata_json,i.status AS instance_status,i.channel_id AS instance_channel_id,
      i.channel_instance_id,i.presentation_json FROM data.runs r JOIN data.instances i
        ON i.run_id=r.run_id WHERE r.run_id=$1 AND i.instance_id=$2 LIMIT 1 FOR SHARE OF r`,
    values: [proof.runId, proof.instanceId], maxRows: 1,
  }))[0];
  const metadata = run?.metadata_json ?? {};
  // A transport disconnect changes presence, not this exact Run's authority.
  // Terminal Runs, replacement bindings and explicit lifecycle fences still deny.
  // A Run acts as its Instance.
  if (!run || proof.instanceId !== input.principal.id ||
      metadata.executionKey !== proof.executionKey || run.instance_channel_id !== run.channel_id ||
      !["starting", "running"].includes(run.run_status) ||
      metadata.instanceDeletion !== undefined || metadata.instanceHandoff !== undefined) {
    throw new MessageAuthorityError(
      "agent_run_forbidden", 403, "Message requires its exact active Agent Run",
    );
  }
  const channelInstanceId = Number(run.channel_instance_id);
  const admission = await requireRunRegistrationAccess(transaction, { runId: proof.runId, channelId: run.channel_id,
    phase: run.run_status === "starting" ? "admission" : "continuation",
    error: (code, status) => new MessageAuthorityError(code, status, "Registration no longer authorizes this Run") });
  if (!Number.isSafeInteger(channelInstanceId) || channelInstanceId < 1) {
    throw new MessageAuthorityError(
      "agent_run_identity_invalid", 503, "Agent Run Instance identity is unavailable", true,
    );
  }
  const presentation = run.presentation_json;
  const agentRunIdentity: PostgresMessageAgentRunIdentity = {
    registration: { ownerUserId: admission.key.ownerUserId, machineId: admission.key.machineId,
      harness: admission.key.harness },
    runId: proof.runId,
    instanceId: proof.instanceId,
    channelId: run.instance_channel_id,
    channelInstanceId,
    ...(presentation && typeof presentation === "object" && !Array.isArray(presentation) &&
        Object.keys(presentation).length > 0
      ? { presentation }
      : {}),
  };
  if (metadata.routedAs === "management_channel_about") throw new MessageAuthorityError(
    "agent_run_forbidden", 403, "Channel About Runs cannot post Channel messages",
  );
  if (metadata.routedAs === "management_assistant_mention") {
    const config = (await transaction.query<QueryResultRow>({
      name: "message_management_delegate_config_v2",
      text: `SELECT config_json,version FROM data.space_management_configs
        WHERE space_id=$1 LIMIT 1 FOR SHARE`,
      values: [input.spaceId], maxRows: 1,
    }))[0];
    const management = config?.config_json as Record<string, unknown> | undefined;
    const generation = metadata.managementConfigGeneration;
    if (metadata.managementSpaceId !== input.spaceId || !Number.isSafeInteger(generation) ||
        generation !== Number(config?.version) || management?.enabled !== true) {
      throw new MessageAuthorityError("management_delegate_message_forbidden", 403,
        "Management message requires the exact configured management Run generation");
    }
    agentRunIdentity.managementDelegate = { spaceId: input.spaceId, configGeneration: generation as number };
  }
  if (run.channel_id !== input.channelId) {
    await requireAgentChannelAccess(transaction, {
      spaceId: input.spaceId, channelId: input.channelId, agentId: input.principal.id,
      runProof: proof, capability,
    });
    agentRunIdentity.origin = await agentRunOrigin(transaction, proof.runId, run.channel_id);
  }
  return { principal: input.principal, agentRunIdentity,
    runOwnerUserId: bounded(run.owner_user_id, "run.ownerUserId") };
}

/**
 * `author` changes what a message says or carries, so only its author (or a
 * Space owner/admin) may; `participant` adds a participant's own response, such
 * as a reaction, which anyone who may act in the Channel may do.
 */
export type MessageMutationAccess = "author" | "participant";

async function mutableMessage(
  transaction: DatabaseTransaction,
  input: { spaceId: string; channelId: string; messageId: string; principal: MessagePrincipal },
  lock: boolean,
  access: MessageMutationAccess = "author",
  includeDeleted = false,
): Promise<MutableMessageRow> {
  const channel = await messageChannelCapability(transaction, input,
    lock ? "message_active_command" : "message_active_command_preflight");
  const rows = await transaction.query<MutableMessageRow>({
    name: lock ? "message_mutation_candidate_lock_v1" : includeDeleted
      ? "message_mutation_candidate_read_deleted_v1" : "message_mutation_candidate_read_v1",
    text: `SELECT m.* FROM data.messages m WHERE m.space_id = $1 AND m.channel_id = $2
      AND m.message_id = $3 ${includeDeleted && !lock ? "" : "AND m.deleted_at IS NULL"} LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    values: [input.spaceId, input.channelId, input.messageId], maxRows: 1,
  });
  const stored = rows[0];
  if (!stored) throw new MessageAuthorityError("message_not_found", 404, "Message not found");
  const message = { ...stored, channel_mode: channel.mode };
  if (access === "participant") return message;
  if (message.author_kind === input.principal.kind && message.author_id === input.principal.id) {
    return message;
  }
  if (input.principal.kind === "user") {
    const admins = await transaction.query({
      name: "message_mutation_admin_v1",
      text: `SELECT user_id FROM data.space_members WHERE space_id = $1 AND user_id = $2
        AND role IN ('owner','admin') LIMIT 1`,
      values: [input.spaceId, input.principal.id], maxRows: 1,
    });
    if (admins[0]) return message;
  }
  throw new MessageAuthorityError("forbidden", 403, "Principal cannot mutate this message");
}

async function mutationReplay(
  transaction: DatabaseTransaction,
  input: { spaceId: string; commandId: string; commandKind: string; requestDigest: string },
): Promise<Record<string, unknown> | null> {
  const rows = await transaction.query<QueryResultRow & {
    command_kind: string; request_digest: string; result_json: Record<string, unknown>;
  }>({
    name: "message_mutation_idempotency_read_v1",
    text: `SELECT command_kind, request_digest, result_json FROM data.idempotency_keys
      WHERE space_id = $1 AND idempotency_key = $2 LIMIT 1`,
    values: [input.spaceId, input.commandId], maxRows: 1,
  });
  if (!rows[0]) return null;
  if (rows[0].command_kind !== input.commandKind || rows[0].request_digest !== input.requestDigest) {
    throw new MessageAuthorityError("idempotency_conflict", 409, "Command id was reused");
  }
  return rows[0].result_json;
}

// Old append writers used the Channel timeline position as the message event
// sequence. Mutations use entity versions, so a second message's first edit or
// recall collided with its create event. Correct only the exact legacy create
// event while the caller holds the authorized canonical message row lock. Keep
// its payload, identity and delivery/lease state intact; unexpected rows still
// fail the unique constraint instead of dropping an event.
async function normalizeMessageCreateEvent(
  transaction: DatabaseTransaction,
  input: { spaceId: string; channelId: string; messageId: string },
): Promise<void> {
  await transaction.query({
    name: "message_create_event_sequence_normalize_v1",
    text: `UPDATE data.outbox o SET aggregate_sequence = 1 FROM data.messages m
      WHERE o.outbox_id = $1 AND o.space_id = $2 AND o.topic = 'message'
        AND o.aggregate_kind = 'message' AND o.aggregate_id = $3
        AND m.space_id = $2 AND m.channel_id = $4 AND m.message_id = $3
        AND o.aggregate_sequence = m.timeline_sequence AND o.aggregate_sequence <> 1
        AND o.payload_json @> '{"entityVersion":1}'::jsonb
        AND o.payload_json->>'messageId' = $3 AND o.payload_json->>'channelId' = $4
        AND o.payload_json->>'sequence' = m.timeline_sequence::text`,
    values: [`message:${input.spaceId}:${input.messageId}:1`,
      input.spaceId, input.messageId, input.channelId], maxRows: 0,
  });
}

async function finalizeMutation(
  transaction: DatabaseTransaction,
  input: {
    spaceId: string;
    channelId: string;
    messageId: string;
    commandId: string;
    commandKind: string;
    requestDigest: string;
    entityVersion: number;
    mutationKind: "edit" | "recall" | "delete" | "reaction" | "annotation" | "attachment";
    mutation: Record<string, unknown>;
    /** `system` only for the Hub's own judgments (annotateAsSystem). */
    principal: MessagePrincipal | { kind: "system"; id: string };
    result: Record<string, unknown>;
    now: string;
  },
): Promise<void> {
  await normalizeMessageCreateEvent(transaction, input);
  await transaction.query({
    name: "message_mutation_ledger_v1",
    text: `INSERT INTO data.message_mutations
      (space_id, channel_id, message_id, entity_version, mutation_kind, mutation_json,
       actor_kind, actor_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
    values: [input.spaceId, input.channelId, input.messageId, input.entityVersion,
      input.mutationKind, JSON.stringify(input.mutation), input.principal.kind,
      input.principal.id, input.now], maxRows: 0,
  });
  await transaction.query({
    name: "message_mutation_content_revision_v1",
    text: `INSERT INTO data.channel_content_counters
      (space_id, channel_id, content_revision, updated_at) VALUES ($1,$2,1,$3)
      ON CONFLICT (space_id, channel_id) DO UPDATE SET
        content_revision = data.channel_content_counters.content_revision + 1,
        updated_at = EXCLUDED.updated_at`,
    values: [input.spaceId, input.channelId, input.now], maxRows: 0,
  });
  await writeOutbox(transaction, {
    name: "message_mutation_outbox_v1",
    outboxId: `message:${input.spaceId}:${input.messageId}:${input.entityVersion}`,
    spaceId: input.spaceId,
    topic: "message",
    aggregateKind: "message",
    aggregateId: input.messageId,
    aggregateSequence: input.entityVersion,
    payload: input.result,
    at: input.now,
  });
  await transaction.query({
    name: "message_mutation_idempotency_write_v1",
    text: `INSERT INTO data.idempotency_keys
      (space_id, idempotency_key, command_kind, request_digest, result_json,
       commit_sequence, created_at, expires_at) VALUES ($1,$2,$3,$4,$5::jsonb,NULL,$6,$7)`,
    values: [input.spaceId, input.commandId, input.commandKind, input.requestDigest,
      JSON.stringify(input.result), input.now,
      new Date(Date.parse(input.now) + IDEMPOTENCY_TTL_MS).toISOString()], maxRows: 0,
  });
}

async function liveRecipientUserIds(
  transaction: DatabaseTransaction,
  spaceId: string,
  channelId: string,
): Promise<string[]> {
  const recipients = await transaction.query<QueryResultRow & {
    user_id: string;
    recipient_count: string | number;
  }>({
    name: "message_live_routing_recipients_v4",
    text: `SELECT recipient.user_id, COUNT(*) OVER () AS recipient_count FROM (
        SELECT DISTINCT m.user_id FROM data.space_members m JOIN data.channels c
          ON c.space_id = m.space_id
        WHERE c.space_id = $1 AND c.channel_id = $2
          AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
            principalKindSql: "'user'", principalIdSql: "m.user_id" })}
      ) recipient ORDER BY recipient.user_id LIMIT 10000`,
    values: [spaceId, channelId], maxRows: 10_000,
  });
  if (Number(recipients[0]?.recipient_count ?? 0) > 10_000) throw new MessageAuthorityError(
    "live_recipient_limit_exceeded", 503, "Live recipients exceed 10000",
  );
  return recipients.map((row) => row.user_id);
}

interface MessagePublishRow extends QueryResultRow {
  channel_id: string | null;
  accepted: boolean;
  result_json: Record<string, unknown> | null;
  sequence_confirmed: boolean;
}

function publishedResult(
  admission: MessagePublishRow | undefined,
  billing: SpaceBillingPolicy,
  input: { billable: boolean; now: string },
): Record<string, unknown> {
  if (!admission) throw new MessageAuthorityError(
    "billing_admission_unavailable", 500, "Message billing admission is unavailable",
  );
  if (input.billable) {
    const { channel_id: _channel, accepted: _accepted, result_json: _result, sequence_confirmed: _confirmed,
      ...row } = admission;
    const rejection = billing.message.rejection(row, { now: input.now });
    if (rejection) throw new MessageAuthorityError(
      rejection.code, rejection.status, rejection.message, rejection.retryable ?? false,
    );
  }
  if (!admission.result_json) throw new MessageAuthorityError(
    "message_receipt_unavailable", 500, "Message receipt is unavailable",
  );
  return admission.result_json;
}

function serializeMessage(row: MessageRow): Record<string, unknown> {
  return {
    ...serializeMessageRow(row, iso),
    payloadRef: row.payload_kind === "redacted" ? "" : row.payload_ref,
    ...(row.tombstone_sender ? { tombstoneSender: row.tombstone_sender } : {}),
  };
}

function serializeThreadSummary(row: ThreadSummaryRow): Record<string, unknown> {
  return {
    channelId: row.thread_channel_id,
    updatedAt: iso(row.thread_updated_at),
    replyCount: Number(row.reply_count),
    replies: row.reply_rows.map(serializeMessage),
  };
}

export interface MessageSearchCandidatesInput {
  requestId: string;
  spaceId: string;
  principal: MessagePrincipal;
  /** Continue strictly after (older than) this search rank. */
  beforeRank?: string;
  limit: number;
}

export interface MessageSearchCandidate {
  messageId: string;
  channelId: string;
  timelineSequence: number;
  entityVersion: number;
  searchRankSequence: string;
  authorKind: string;
  authorId: string;
  payloadBundleBase64: string | null;
  legacyBody: string | null;
  /** File names on the message, so Ctrl+F can find an attachment. */
  attachmentNames: string[];
  sentAt: string;
}

function attachmentNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const name = (item as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) names.push(name);
  }
  return names;
}

export interface MessageHistoryInput {
  requestId: string;
  spaceId: string;
  channelId: string;
  principal: MessagePrincipal;
  before?: string;
  beforeSequence?: number;
  afterSequence?: number;
  limit?: number;
  /** The Space placement the caller resolved together with the Channel's
   *  route. It only selects the shard; the read still takes the fence. */
  resolvedPlacement?: SpacePlacement;
}

export interface MessageHistoryPage {
  messages: Record<string, unknown>[];
  hasMore: boolean;
  principalAckedSequence: number;
  contentRevision: number;
  historyHeadSequence: number;
  aboutInput?: { inputId: string; expectedRevision: number };
}

type HistoryPageRow = QueryResultRow & {
  history_authorized: boolean | null;
  channel_name?: string;
  channel_metadata?: Record<string, unknown>;
  channel_updated_at?: Date | string;
  about_run_id?: string | null;
  acknowledged_sequence: string | number | null;
  content_revision: string | number | null;
  history_head_sequence: string | number | null;
  message_id: string | null;
  thread_channel_id: string | null;
  thread_updated_at: Date | string | null;
  reply_count: string | number | null;
  reply_rows: MessageRow[] | null;
};

/** A placement serves reads only while active on a shard; anything else is retryable unavailability. */
function activeMessagePlacement(spaceId: string, placement: SpacePlacement): SpacePlacement {
  if (placement.spaceId !== spaceId || placement.state !== "active" || !placement.shardId) {
    throw new MessageAuthorityError("space_placement_unavailable", 503, "Space placement is unavailable", true);
  }
  return placement;
}

export class PostgresMessageRepository {
  private readonly placements: PostgresSpacePlacementDirectory;

  constructor(
    private readonly database: AuthorityDatabase,
    private readonly ownsRequestSession = false,
    private readonly billing: SpaceBillingPolicy = spaceBilling,
  ) {
    this.placements = new PostgresSpacePlacementDirectory(database);
  }

  private async placement(
    requestId: string,
    operation: string,
    spaceId: string,
    supplied?: PostgresMessagePlacement,
  ) {
    if (supplied) {
      const suppliedSpaceId = bounded(supplied.spaceId, "placement.spaceId");
      const suppliedShardId = bounded(supplied.shardId, "placement.shardId");
      if (suppliedSpaceId !== spaceId ||
          !Number.isSafeInteger(supplied.placementEpoch) || supplied.placementEpoch < 1) {
        throw new MessageAuthorityError(
          "space_placement_unavailable", 503, "Space placement is unavailable", true,
        );
      }
      return {
        spaceId,
        shardId: suppliedShardId,
        placementEpoch: supplied.placementEpoch,
        state: "active" as const,
        targetShardId: null,
      };
    }
    const placement = await this.placements.resolve({ requestId, operation }, spaceId);
    if (placement.state !== "active" || !placement.shardId) {
      throw new MessageAuthorityError("space_placement_unavailable", 503, "Space placement is unavailable", true);
    }
    return placement;
  }

  /** Runs `work` in one transaction on the Space's placement. */
  private async inSpace<T>(requestId: string, operation: string, spaceId: string,
    work: (transaction: DatabaseTransaction) => Promise<T>,
    supplied?: PostgresMessagePlacement): Promise<T> {
    const { shardId, placementEpoch } = await this.placement(requestId, operation, spaceId, supplied);
    return this.database.transaction({ requestId, operation, placement: { spaceId, shardId, placementEpoch } }, work);
  }

  /**
   * Runs `apply` on the message a mutation names, locked and still at the
   * version its caller saw, unless the same command already committed.
   */
  private mutateMessage(mutation: MessageMutation, operation: string, commandKind: string,
    access: MessageMutationAccess,
    apply: (transaction: DatabaseTransaction, candidate: MutableMessageRow) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const { requestId, spaceId, channelId, messageId, principal, commandId, requestDigest } = mutation;
    return this.inSpace(requestId, operation, spaceId, async (transaction) => {
      const replay = await mutationReplay(transaction, { spaceId, commandId, commandKind, requestDigest });
      if (replay) return replay;
      const candidate = await mutableMessage(transaction, { spaceId, channelId, messageId, principal }, true, access);
      if (Number(candidate.entity_version) !== mutation.expectedVersion) throw new MessageAuthorityError(
        "message_version_conflict", 409, "Message version changed",
      );
      return apply(transaction, candidate);
    });
  }

  async observedHead(input: {
    requestId: string;
    spaceId: string;
    channelId: string;
    principal: MessagePrincipal;
    runProof?: AppendPostgresMessage["runProof"];
  }): Promise<{ sequence: number; principal: MessagePrincipal }> {
    const { requestId, spaceId, channelId, principal } = messageScope(input);
    return this.inSpace(requestId, "message.observed-head", spaceId, async (transaction) => {
      const authorized = await activeAppendPrincipal(transaction, {
        spaceId, channelId, principal, runProof: input.runProof,
      });
      const rows = await transaction.query<QueryResultRow & { sequence: string | number }>({
        name: "message_observed_head_v1",
        text: `SELECT COALESCE(MAX(timeline_sequence), 0) AS sequence FROM data.messages
          WHERE space_id = $1 AND channel_id = $2`,
        values: [spaceId, channelId], maxRows: 1,
      });
      return { sequence: Number(rows[0]?.sequence ?? 0), principal: authorized.principal };
    });
  }

  async prepareAppend(input: {
    requestId: string;
    spaceId: string;
    channelId: string;
    principal: MessagePrincipal;
    senderPrincipal?: MessagePrincipal;
    runProof?: AppendPostgresMessage["runProof"];
    placement?: PostgresMessagePlacement;
  }): Promise<PreparedPostgresMessageAppend> {
    const { requestId, spaceId, channelId, principal } = messageScope(input);
    const senderPrincipal = input.senderPrincipal
      ? { kind: input.senderPrincipal.kind, id: bounded(input.senderPrincipal.id, "senderPrincipal.id") }
      : undefined;
    const placement = await this.placement(
      requestId, "message.prepare-append", spaceId, input.placement,
    );
    return this.database.transaction({
      requestId, operation: "message.prepare-append",
      placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
    }, async (transaction) => {
      if (!input.runProof && senderPrincipal &&
          senderPrincipal.kind === principal.kind && senderPrincipal.id === principal.id) {
        const row = (await transaction.query<PreparedAppendContextRow>({
          name: "message_prepare_context_v8",
          text: `WITH message_input AS (
              SELECT $1::text AS space_id,$2::text AS channel_id,
                $3::text AS principal_kind,$4::text AS principal_id
            ), ${channelCapabilityCte({ capability: "message_active_command_preflight",
              inputCte: "message_input" })}, sender_identity AS (
              SELECT jsonb_build_object('kind','user','id',member.user_id,
                'email',member.email,'displayName',member.display_name,
                'avatarUrl',member.avatar_url,'version',member.version) AS value
              FROM data.space_members member
              WHERE $3='user' AND member.space_id=$1 AND member.user_id=$4
              UNION ALL
              SELECT jsonb_build_object('kind','agent','id',instance.instance_id,
                'name',registration.display_name,'runtime',registration.harness,
                'ownerUserId',binding.owner_user_id,'ownerEmail',owner.email,
                'metadata',jsonb_build_object('presetId',registration.harness,'identityKind','instance'),
                'version',registration.version) AS value
              FROM data.instances instance
              JOIN data.run_agent_registrations binding ON binding.run_id=instance.run_id
              JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
                AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
                AND registration.harness=binding.harness
              LEFT JOIN data.space_members owner ON owner.space_id=binding.space_id
                AND owner.user_id=binding.owner_user_id
              WHERE $3='agent' AND binding.space_id=$1 AND instance.instance_id=$4
            )
            SELECT COALESCE((SELECT MAX(message.timeline_sequence) FROM data.messages message
                WHERE message.space_id=$1 AND message.channel_id=$2),0) AS sequence,
              (SELECT value FROM sender_identity LIMIT 1) AS sender_identity,
              authorized AS channel_authorized
            FROM authorized_channel`,
          values: [spaceId, channelId, principal.kind, principal.id], maxRows: 1,
        }))[0];
        requireAuthorizedChannel(row?.channel_authorized, messageCapabilityError);
        if (!row.sender_identity) throw new MessageAuthorityError(
          "message_sender_unavailable", 409, "Message sender is unavailable",
        );
        return {
          sequence: Number(row.sequence),
          principal,
          senderIdentity: row.sender_identity as unknown as PostgresMessageSenderIdentity,
        };
      }
      const authorized = await activeAppendPrincipal(transaction, {
        spaceId, channelId, principal, runProof: input.runProof,
      });
      let senderIdentity: PostgresMessageSenderIdentity | undefined;
      if (senderPrincipal) {
        if (senderPrincipal.kind !== authorized.principal.kind ||
            senderPrincipal.id !== authorized.principal.id) {
          await messageChannelCapability(transaction,
            { spaceId, channelId, principal: senderPrincipal },
            "message_active_command_preflight");
        }
        senderIdentity = await this.senderIdentityTransaction(
          transaction, spaceId, senderPrincipal,
        );
      }
      const rows = await transaction.query<QueryResultRow & { sequence: string | number }>({
        name: "message_prepare_observed_head_v1",
        text: `SELECT COALESCE(MAX(timeline_sequence), 0) AS sequence FROM data.messages
          WHERE space_id = $1 AND channel_id = $2`,
        values: [spaceId, channelId], maxRows: 1,
      });
      return {
        sequence: Number(rows[0]?.sequence ?? 0),
        principal: authorized.principal,
        ...(senderIdentity ? { senderIdentity } : {}),
        ...(authorized.agentRunIdentity
          ? { agentRunIdentity: authorized.agentRunIdentity }
          : {}),
      };
    });
  }

  async reserveAppendSequence(input: {
    requestId: string;
    commandId: string;
    spaceId: string;
    channelId: string;
    observedPostgresHead: number;
    placement?: PostgresMessagePlacement;
  }): Promise<PostgresMessageSequenceReservation> {
    const { requestId, spaceId, channelId } = channelRequest(input);
    const commandId = bounded(input.commandId, "commandId");
    const observedPostgresHead = nonnegative(input.observedPostgresHead, "observedPostgresHead");
    const placement = await this.placement(
      requestId, "message.reserve-sequence", spaceId, input.placement,
    );
    return this.database.transaction({
      requestId, operation: "message.reserve-sequence",
      placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
    }, async (transaction) => {
      const existing = (await transaction.query<QueryResultRow & {
        channel_id: string; sequence: string | number; state: "reserved" | "committed";
      }>({
        name: "message_sequence_reservation_read_v1",
        text: `SELECT channel_id,sequence,state FROM data.message_sequence_reservations
          WHERE space_id=$1 AND command_id=$2 LIMIT 1`,
        values: [spaceId, commandId], maxRows: 1,
      }))[0];
      let collidedSequence: number | undefined;
      if (existing) {
        if (existing.channel_id !== channelId) throw new MessageAuthorityError(
          "idempotency_conflict", 409, "Command id was reused",
        );
        const existingSequence = Number(existing.sequence);
        if (!Number.isSafeInteger(existingSequence) || existingSequence < 1) {
          throw new MessageAuthorityError(
            "message_sequence_unavailable", 503, "Message sequence is unavailable", true,
          );
        }
        if (existing.state === "committed") {
          return { sequence: existingSequence, state: existing.state };
        }
        const occupied = (await transaction.query<QueryResultRow>({
          name: "message_sequence_reservation_collision_v1",
          text: `SELECT message_id FROM data.messages
            WHERE space_id=$1 AND channel_id=$2 AND timeline_sequence=$3 LIMIT 1`,
          values: [spaceId, channelId, existingSequence], maxRows: 1,
        }))[0];
        if (!occupied) return { sequence: existingSequence, state: existing.state };
        collidedSequence = existingSequence;
      }
      const allocated = (await transaction.query<QueryResultRow & {
        allocated_sequence: string | number;
      }>({
        name: "message_sequence_allocate_v1",
        text: `INSERT INTO data.channel_message_sequences
            (space_id,channel_id,allocated_sequence,confirmed_sequence,updated_at)
          VALUES ($1,$2,$3::bigint+1,$3::bigint,$4)
          ON CONFLICT (space_id,channel_id) DO UPDATE SET
            allocated_sequence=GREATEST(
              data.channel_message_sequences.allocated_sequence,$3::bigint
            )+1,
            updated_at=EXCLUDED.updated_at
          RETURNING allocated_sequence`,
        values: [spaceId, channelId, observedPostgresHead, new Date().toISOString()], maxRows: 1,
      }))[0];
      const sequence = Number(allocated?.allocated_sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new MessageAuthorityError(
        "message_sequence_unavailable", 503, "Message sequence is unavailable", true,
      );
      const now = new Date();
      const inserted = (await transaction.query<QueryResultRow & {
        channel_id: string; sequence: string | number; state: "reserved" | "committed";
      }>({
        name: collidedSequence === undefined
          ? "message_sequence_reservation_insert_v1"
          : "message_sequence_reservation_reallocate_v1",
        text: collidedSequence === undefined
          ? `INSERT INTO data.message_sequence_reservations
              (space_id,command_id,channel_id,sequence,state,fact_digest,created_at,updated_at,expires_at)
            VALUES ($1,$2,$3,$4,'reserved',NULL,$5,$5,$6)
            ON CONFLICT (space_id,command_id) DO NOTHING
            RETURNING channel_id,sequence,state`
          : `UPDATE data.message_sequence_reservations SET sequence=$4,updated_at=$5
            WHERE space_id=$1 AND command_id=$2 AND channel_id=$3
              AND sequence=$7 AND state='reserved' AND fact_digest IS NULL
            RETURNING channel_id,sequence,state`,
        values: collidedSequence === undefined
          ? [spaceId, commandId, channelId, sequence, now.toISOString(),
              new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString()]
          : [spaceId, commandId, channelId, sequence, now.toISOString(),
              new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(), collidedSequence],
        maxRows: 1,
      }))[0];
      if (inserted) return { sequence: Number(inserted.sequence), state: inserted.state };
      const raced = (await transaction.query<QueryResultRow & {
        channel_id: string; sequence: string | number; state: "reserved" | "committed";
      }>({
        name: "message_sequence_reservation_race_read_v1",
        text: `SELECT channel_id,sequence,state FROM data.message_sequence_reservations
          WHERE space_id=$1 AND command_id=$2 LIMIT 1`,
        values: [spaceId, commandId], maxRows: 1,
      }))[0];
      if (!raced || raced.channel_id !== channelId) throw new MessageAuthorityError(
        "idempotency_conflict", 409, "Command id was reused",
      );
      return { sequence: Number(raced.sequence), state: raced.state };
    });
  }

  private async senderIdentityTransaction(
    transaction: DatabaseTransaction,
    spaceId: string,
    principal: MessagePrincipal,
  ): Promise<PostgresMessageSenderIdentity> {
    if (principal.kind === "user") {
      const row = (await transaction.query<QueryResultRow>({
        name: "message_sender_user_identity_v1",
        text: `SELECT user_id,email,display_name,avatar_url,version FROM data.space_members
          WHERE space_id=$1 AND user_id=$2 LIMIT 1`,
        values: [spaceId, principal.id], maxRows: 1,
      }))[0];
      if (!row) throw new MessageAuthorityError(
        "message_sender_unavailable", 409, "Message sender is unavailable",
      );
      return { kind: "user", id: String(row.user_id),
        email: row.email == null ? null : String(row.email),
        displayName: row.display_name == null ? null : String(row.display_name),
        avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
        version: Number(row.version) };
    }
    // An Agent is the Instance of a registered Run, named by its Space registration.
    const row = (await transaction.query<QueryResultRow>({
      name: "message_sender_agent_identity_v3",
      text: `SELECT instance.instance_id,registration.display_name AS name,registration.harness AS runtime,
          binding.owner_user_id,jsonb_build_object('presetId',registration.harness,'identityKind','instance') AS metadata_json,
          registration.version,owner.email AS owner_email FROM data.instances instance
        JOIN data.run_agent_registrations binding ON binding.run_id=instance.run_id
        JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
          AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
          AND registration.harness=binding.harness
        LEFT JOIN data.space_members owner ON owner.space_id=binding.space_id
          AND owner.user_id=binding.owner_user_id
        WHERE binding.space_id=$1 AND instance.instance_id=$2 LIMIT 1`,
      values: [spaceId, principal.id], maxRows: 1,
    }))[0];
    if (!row) throw new MessageAuthorityError(
      "message_sender_unavailable", 409, "Message sender is unavailable",
    );
    const metadata = row.metadata_json && typeof row.metadata_json === "object" &&
        !Array.isArray(row.metadata_json)
      ? row.metadata_json as Record<string, unknown> : {};
    return { kind: "agent", id: String(row.instance_id), name: String(row.name),
      runtime: String(row.runtime), ownerUserId: String(row.owner_user_id),
      ownerEmail: row.owner_email == null ? null : String(row.owner_email), metadata,
      version: Number(row.version) };
  }

  async senderIdentity(input: {
    requestId: string;
    spaceId: string;
    channelId: string;
    principal: MessagePrincipal;
  }): Promise<PostgresMessageSenderIdentity> {
    const { requestId, spaceId, channelId, principal } = messageScope(input);
    return this.inSpace(requestId, "message.sender-identity", spaceId, async (transaction) => {
      await messageChannelCapability(transaction, { spaceId, channelId, principal },
        "message_active_command_preflight");
      return this.senderIdentityTransaction(transaction, spaceId, principal);
    });
  }

  async append(input: AppendPostgresMessage, dingtalkEffect?: DingTalkEffectAuthority): Promise<Record<string, unknown>> {
    const { requestId, spaceId, channelId } = channelRequest(input);
    const commandId = bounded(input.commandId, "commandId");
    const messageId = bounded(input.messageId, "messageId");
    const sequence = positive(input.sequence, "sequence");
    const principal = { kind: input.principal.kind, id: bounded(input.principal.id, "principal.id") };
    const senderKind = input.senderKind;
    if (!["user", "agent", "app", "system"].includes(senderKind)) {
      throw new MessageAuthorityError("invalid_command", 400, "senderKind is invalid");
    }
    const senderId = bounded(input.senderId, "senderId");
    const messageKind = bounded(input.messageKind, "messageKind", 128);
    const sentAt = timestamp(input.sentAt, "sentAt");
    const requestDigest = digest(input.requestDigest, "requestDigest");
    const recordDigest = digest(input.prepared.recordDigest, "prepared.recordDigest");
    const agentSendFingerprint = input.agentSendFingerprint === undefined ? undefined
      : digest(input.agentSendFingerprint, "agentSendFingerprint");
    const finalId = input.finalReplyExecutionId;
    if (finalId !== undefined && (typeof finalId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(finalId))) {
      throw new MessageAuthorityError("invalid_final_reply", 400, "Final reply requires a canonical execution UUID");
    }
    if (finalId !== undefined && (!input.runProof || principal.kind !== "agent" ||
        senderKind !== "agent" || senderId !== principal.id)) throw new MessageAuthorityError(
      "final_reply_requires_run", 403, "Final reply requires its authenticated Agent Run",
    );
    const bodyHash = digest(input.prepared.bodyHash, "prepared.bodyHash");
    const finalReply = finalId === undefined ? null : {
      executionId: finalId, runId: bounded(input.runProof!.runId, "runProof.runId"),
      instanceId: bounded(input.runProof!.instanceId, "runProof.instanceId"),
      bodyHash,
    };
    const senderSnapshotDigest = digest(
      input.prepared.senderSnapshotDigest, "prepared.senderSnapshotDigest",
    );
    const attachmentViews = input.attachments ?? [];
    if (!Array.isArray(attachmentViews) || attachmentViews.length > 10) {
      throw new MessageAuthorityError("invalid_command", 400, "attachments are invalid");
    }
    const attachmentOwnerUserId = attachmentViews.length && input.attachmentOwnerUserId
      ? bounded(input.attachmentOwnerUserId, "attachmentOwnerUserId") : null;
    const attachmentRows = attachmentViews.map((attachment) => {
      const presentationResidual = Object.fromEntries(
        ["durationMs", "width", "height", "transcodingStatus"]
          .filter((key) => attachment[key] !== undefined)
          .map((key) => [key, attachment[key]]),
      );
      return {
        attachment_id: bounded(attachment.id, "attachment.id"),
        object_key: bounded(attachment.objectKey, "attachment.objectKey", 2_000),
        content_hash: digest(attachment.contentHash, "attachment.contentHash"),
        encoded_bytes: positive(attachment.size, "attachment.size"),
        mime_type: bounded(attachment.mimeType, "attachment.mimeType"),
        name: bounded(attachment.name, "attachment.name", 1_000),
        presentation_residual_json: Object.keys(presentationResidual).length > 0
          ? presentationResidual : null,
      };
    });
    let targets = new Map<string, "mention" | "broadcast" | "reply">();
    for (const target of input.attentionTargets ?? []) {
      const subjectId = bounded(target.subjectId, "attentionTargets.subjectId");
      if (!/^(?:user|agent):.+$/u.test(subjectId) ||
          (target.kind !== "mention" && target.kind !== "broadcast")) {
        throw new MessageAuthorityError("invalid_attention_target", 400, "Attention target is invalid");
      }
      targets.set(subjectId, target.kind);
    }
    if (targets.size > MAX_ATTENTION_TARGETS) {
      throw new MessageAuthorityError("attention_target_limit_exceeded", 400, "Attention targets exceed 1000");
    }
    const placement = await this.placement(
      requestId, "message.append", spaceId, input.placement,
    );
    return this.database.transaction({
      requestId, operation: "message.append",
      placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
    }, async (transaction) => {
      if (dingtalkEffect) {
        if (principal.kind!=="user" || senderKind!=="app" || senderId!=="dingtalk" || input.runProof ||
          input.finalReplyExecutionId || input.invocationSelections!==undefined || input.attachments?.length ||
          input.replyToMessageId || input.attentionTargets?.length || input.messageKind!=="xmatrix.message.text" || messageId!==commandId) {
          throw new MessageAuthorityError("invalid_command",400,"Invalid DingTalk effect message");
        }
        const source=await authorizeDingTalkEffect(transaction,dingtalkEffect,{ kind: "channel",id: channelId,channelId,spaceId,
          shardId: placement.shardId,effectId: commandId,authorityRootUserId: principal.id,bodyHash });
        if (input.attentionBody!==source.candidate.text) throw new MessageAuthorityError("invalid_command",400,"Invalid DingTalk effect body");
      }
      let authorizedPrincipal: MessagePrincipal;
      let origin: { channelId: string; runId: string; messageId?: string } | undefined;
      let replyOrigin: {
        channelId: string; messageId: string; ownerUserId: string; requesterInstanceId?: string;
      } | undefined;
      let runOwnerUserId: string | undefined;
      if (!input.runProof) {
        const preflight = (await transaction.query<AppendPreflightRow>({
          name: "message_append_preflight_v4",
          text: `WITH message_input AS (
              SELECT $1::text AS space_id,$3::text AS channel_id,
                $4::text AS principal_kind,$5::text AS principal_id
            ), replay AS MATERIALIZED (
              SELECT command_kind,request_digest,result_json FROM data.idempotency_keys
              WHERE space_id=$1 AND idempotency_key=$2 LIMIT 1
            ), ${channelCapabilityCte({ capability: "message_append",
              inputCte: "message_input" })} SELECT
              (SELECT command_kind FROM replay) AS command_kind,
              (SELECT request_digest FROM replay) AS request_digest,
              (SELECT result_json FROM replay) AS result_json,
              (SELECT channel_id FROM authorized_channel) AS channel_id,
              (SELECT mode FROM authorized_channel) AS channel_mode,
              (SELECT metadata_json FROM authorized_channel) AS channel_metadata_json,
              (SELECT authorized FROM authorized_channel) AS channel_authorized,
              EXISTS (SELECT 1 FROM data.messages message
                WHERE NOT EXISTS (SELECT 1 FROM replay)
                  AND message.space_id=$1
                  AND (message.message_id=$6 OR
                    (message.channel_id=$3 AND message.timeline_sequence=$7))
                LIMIT 1) AS duplicate_exists`,
          values: [spaceId, commandId, channelId, principal.kind, principal.id,
            messageId, sequence], maxRows: 1,
        }))[0]!;
        if (preflight.command_kind !== null) {
          if (preflight.command_kind !== "message-append" ||
              preflight.request_digest !== requestDigest) {
            throw new MessageAuthorityError("idempotency_conflict", 409, "Command id was reused");
          }
          if (!preflight.result_json) throw new MessageAuthorityError(
            "idempotency_result_missing", 500, "Stored command result is unavailable",
          );
          if (dingtalkEffect) await finishDingTalkEffect(transaction,dingtalkEffect);
          return preflight.result_json;
        }
        requireAuthorizedChannel(preflight.channel_authorized, messageCapabilityError);
        if (!preflight.channel_id || !preflight.channel_mode) throw new MessageAuthorityError(
          "postgres_fact_invalid", 500, "Authorized Channel facts are unavailable",
        );
        if (preflight.duplicate_exists) throw new MessageAuthorityError(
          "message_exists", 409, "Message already exists",
        );
        authorizedPrincipal = principal;
      } else {
        const replays = await transaction.query<QueryResultRow & {
          command_kind: string; request_digest: string; result_json: Record<string, unknown>;
        }>({
          name: "message_append_idempotency_read_v1",
          text: `SELECT command_kind, request_digest, result_json FROM data.idempotency_keys
            WHERE space_id = $1 AND idempotency_key = $2 LIMIT 1`,
          values: [spaceId, commandId], maxRows: 1,
        });
        if (replays[0]) {
          if (replays[0].command_kind !== "message-append" ||
              replays[0].request_digest !== requestDigest) {
            throw new MessageAuthorityError("idempotency_conflict", 409, "Command id was reused");
          }
          return replays[0].result_json;
        }
        const authorized = await effectiveAppendPrincipal(transaction, {
          spaceId, channelId, principal, runProof: input.runProof,
        }, "message_append");
        authorizedPrincipal = authorized.principal;
        runOwnerUserId = authorized.runOwnerUserId;
        origin = authorized.agentRunIdentity?.managementDelegate
          ? undefined : authorized.agentRunIdentity?.origin;
        await messageChannelCapability(transaction, {
          spaceId, channelId, principal: authorizedPrincipal,
        }, "message_append");
        const duplicates = await transaction.query({
          name: "message_append_identity_conflict_v1",
          text: `SELECT message_id FROM data.messages
            WHERE space_id = $1 AND (message_id = $2 OR (channel_id = $3 AND timeline_sequence = $4))
            LIMIT 1`,
          values: [spaceId, messageId, channelId, sequence], maxRows: 1,
        });
        if (duplicates[0]) throw new MessageAuthorityError(
          "message_exists", 409, "Message already exists",
        );
      }
      const sequenceReservation = (await transaction.query<QueryResultRow & {
        channel_id: string; sequence: string | number; state: "reserved" | "committed";
        fact_digest: string | null;
      }>({
        name: "message_sequence_reservation_verify_v1",
        text: `SELECT channel_id,sequence,state,fact_digest
          FROM data.message_sequence_reservations
          WHERE space_id=$1 AND command_id=$2 LIMIT 1`,
        values: [spaceId, commandId], maxRows: 1,
      }))[0];
      if (!sequenceReservation || sequenceReservation.channel_id !== channelId ||
          Number(sequenceReservation.sequence) !== sequence ||
          (sequenceReservation.state === "committed" &&
            sequenceReservation.fact_digest !== recordDigest)) {
        throw new MessageAuthorityError(
          "message_sequence_reservation_invalid", 409,
          "Message sequence reservation is unavailable",
        );
      }
      let agentTargets: Awaited<ReturnType<typeof resolveMessageAgentTargets>> = [];
      if (input.invocationSelections !== undefined && (senderKind !== "user" || senderId !== authorizedPrincipal.id)) {
        throw new MessageAuthorityError("invocation_selection_forbidden", 403,
          "Agent invocation selections require the authenticated Human author");
      }
      const invocationSelections = input.invocationSelections === undefined ? undefined :
        await authorizeMessageInvocationSelections(transaction, { spaceId, channelId,
          principal: authorizedPrincipal, body: input.attentionBody ?? "", bodyHash,
          revision: 1, selections: input.invocationSelections });
      if (input.attentionBody !== undefined) {
        if (typeof input.attentionBody !== "string") throw new MessageAuthorityError(
          "invalid_command", 400, "attentionBody is invalid",
        );
        const attentionBody = invocationSelections
          ? bodyWithoutInvocationSelections(input.attentionBody, invocationSelections) : input.attentionBody;
        targets = await atomicAttentionTargets(transaction, {
          spaceId, channelId, body: attentionBody,
          senderSubjectId: `${senderKind}:${senderId}`,
        });
        agentTargets = await resolveMessageAgentTargets(transaction, { spaceId, channelId, messageId, body: attentionBody });
        if (!agentTargets) throw new MessageAuthorityError("invocation_target_limit_exceeded", 400,
          "Existing-instance addresses exceed the message count or storage bound");
      }
      if (input.replyToMessageId) {
        const replyToMessageId = bounded(input.replyToMessageId, "replyToMessageId");
        const replied = await transaction.query<QueryResultRow & {
          author_kind: string; author_id: string; origin_channel_id: string | null;
          origin_owner_user_id: string | null; origin_instance_id: string | null;
        }>({
          name: "message_append_reply_target_v3",
          text: `SELECT m.author_kind, m.author_id, m.origin_channel_id,
              r.owner_user_id AS origin_owner_user_id,
              -- A Run id is its Instance id plus "#<k>" (0084), so a reborn
              -- Instance still owns the links its earlier Runs wrote.
              NULLIF(split_part(m.origin_run_id, '#', 1), m.origin_run_id) AS origin_instance_id
            FROM data.messages m
            LEFT JOIN data.runs r ON r.run_id = m.origin_run_id
            WHERE m.space_id = $1 AND m.channel_id = $2 AND m.message_id = $3
              AND m.deleted_at IS NULL LIMIT 1`,
          values: [spaceId, channelId, replyToMessageId], maxRows: 1,
        });
        if (!replied[0] || (replied[0].author_kind !== "user" && replied[0].author_kind !== "agent")) {
          throw new MessageAuthorityError("invalid_reply_target", 400, "Reply target is unavailable");
        }
        // A reply to a link lands back in the Channel the link came from.
        if (replied[0].origin_channel_id && replied[0].origin_owner_user_id &&
            replied[0].origin_channel_id !== channelId) {
          replyOrigin = { channelId: replied[0].origin_channel_id, messageId: replyToMessageId,
            ownerUserId: replied[0].origin_owner_user_id,
            // The Instance that asked: only it takes the answer as work there.
            ...(replied[0].origin_instance_id
              ? { requesterInstanceId: replied[0].origin_instance_id } : {}) };
        }
        const replySubjectId = `${replied[0].author_kind}:${replied[0].author_id}`;
        if (replySubjectId !== `${senderKind}:${senderId}` && !targets.has(replySubjectId)) {
          targets.set(replySubjectId, "reply");
        }
      }
      if (targets.size > MAX_ATTENTION_TARGETS) {
        throw new MessageAuthorityError(
          "attention_target_limit_exceeded", 400, "Attention targets exceed 1000",
        );
      }
      const subjectIds = [...targets.keys()];
      if (subjectIds.length > 0) {
        const valid = await transaction.query<QueryResultRow & { subject_id: string }>({
          name: "message_attention_authorize_v3",
          text: `SELECT requested.subject_id FROM data.channels c
            CROSS JOIN unnest($3::text[]) AS requested(subject_id)
            WHERE c.space_id = $1 AND c.channel_id = $2
              AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
                principalKindSql: "split_part(requested.subject_id, ':', 1)",
                principalIdSql: "substr(requested.subject_id, CASE WHEN split_part(requested.subject_id, ':', 1)='user' THEN 6 ELSE 7 END)" })}`,
          values: [spaceId, channelId, subjectIds], maxRows: subjectIds.length,
        });
        if (new Set(valid.map((row) => row.subject_id)).size !== subjectIds.length) {
          throw new MessageAuthorityError(
            "invalid_attention_target", 400, "Attention target cannot read this Channel",
          );
        }
      }
      // A stop command (`/stop all`, `@codex:1:stop`) stops its Runs in the
      // transaction that makes it visible; the Hub only delivers the host stops
      // afterwards. A Human stops as themself; an Agent stops as its Run's owner,
      // the same authority the Hub's stop delivery uses. The Run locks come
      // before this append's first write: an Agent append holds its Run share
      // lock while it writes the same Channel counter.
      const stopActorUserId = senderKind === "user" && !input.runProof && authorizedPrincipal.kind === "user" &&
          senderId === authorizedPrincipal.id
        ? authorizedPrincipal.id
        : senderKind === "agent" ? runOwnerUserId : undefined;
      const stopScope = stopActorUserId && typeof input.attentionBody === "string"
        ? await channelStopScope(transaction, { spaceId, channelId, messageId, body: input.attentionBody })
        : undefined;
      if (stopScope && stopActorUserId) {
        await fenceChannelRunsForStop(transaction, { spaceId, channelId, scope: stopScope,
          actorUserId: stopActorUserId, sourceMessageId: messageId, at: sentAt });
      }
      // timeline_sequence is scoped to one Channel, while search_rank_sequence is
      // unique across every message in a Space. Deriving the latter from the
      // former makes the first (or second) message in every new Channel collide.
      // The database sequence is shared with the other PostgreSQL authority
      // writers and gives each inserted message its own stable ordering key.
      const committedFacts = (await transaction.query<AppendCommittedFactsRow>({
        name: "message_append_commit_facts_v5",
        text: `WITH search_rank AS MATERIALIZED (
            SELECT 'pg:'||lpad(nextval('data.search_rank_sequence_v1')::text,20,'0') AS value
          ), message_row AS (
            INSERT INTO data.messages
              (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,
               author_id,message_kind,content_hash,payload_kind,payload_ref,archive_source_json,
               reactions_json,annotations_json,attachments_json,sent_at,edited_at,recalled_at,
               deleted_at,updated_at,search_rank_sequence,codec_id,payload_schema_version,
               field_presence_base64,payload_bundle_base64,legacy_body,body_hash,
               sender_snapshot_digest,record_digest,record_encoded_bytes,source_family_sequence,
               created_at,invocation_input_version,agent_final_reply_json,
               origin_channel_id,origin_message_id,origin_run_id,preview_json)
            SELECT $1,$2,$3,$4,1,$5,$6,$7,$8,'hot-inline',$3,NULL,'[]','[]',$9::jsonb,
              $10,NULL,NULL,NULL,$10,search_rank.value,$11,$12,$13,$14,NULL,$8,$15,$16,$17,
              NULL,$10,1,$21::jsonb,$22,$23,$24,$25::jsonb FROM search_rank
            RETURNING message_id,channel_id
          ), mutation_row AS (
            INSERT INTO data.message_mutations
              (space_id,channel_id,message_id,entity_version,mutation_kind,mutation_json,
               actor_kind,actor_id,occurred_at)
            SELECT $1,$2,message_row.message_id,1,'create',$18::jsonb,$19,$20,$10
            FROM message_row RETURNING message_id
          ), counter_row AS (
            INSERT INTO data.channel_content_counters
              (space_id,channel_id,content_revision,updated_at) VALUES ($1,$2,0,$10)
            ON CONFLICT (space_id,channel_id) DO UPDATE SET updated_at=EXCLUDED.updated_at
            RETURNING content_revision
          ) SELECT search_rank.value AS search_rank,counter_row.content_revision,
              message_row.channel_id
            FROM search_rank CROSS JOIN counter_row CROSS JOIN message_row`,
        values: [spaceId, channelId, messageId, sequence, senderKind, senderId, messageKind,
          bodyHash, JSON.stringify(attachmentViews), sentAt, input.prepared.codecId,
          positive(input.prepared.payloadSchemaVersion, "prepared.payloadSchemaVersion"),
          bounded(input.prepared.fieldPresenceBase64, "prepared.fieldPresenceBase64", 500_000),
          bounded(input.prepared.payloadBundleBase64, "prepared.payloadBundleBase64", 2_000_000),
          senderSnapshotDigest, recordDigest,
          positive(input.prepared.recordEncodedBytes, "prepared.recordEncodedBytes"),
          JSON.stringify({ recordDigest, sequence }), authorizedPrincipal.kind,
          authorizedPrincipal.id, finalReply === null ? null : JSON.stringify(finalReply),
          origin?.channelId ?? null, origin?.messageId ?? null, origin?.runId ?? null,
          storedMessagePreview(input.prepared.preview)],
        maxRows: 1,
      }))[0];
      if (!committedFacts?.channel_id) throw new MessageAuthorityError(
        "channel_not_found", 404, "Channel not found",
      );
      const searchRank = bounded(committedFacts.search_rank, "searchRank");
      if (agentTargets.length || invocationSelections) {
        const written = await transaction.query({ name: "message_agent_targets_commit_v1",
          text: `UPDATE data.messages SET agent_invocation_targets_json=$4::jsonb
            WHERE space_id=$1 AND channel_id=$2 AND message_id=$3 AND entity_version=1 RETURNING message_id`,
          values: [spaceId, channelId, messageId, JSON.stringify({ entityVersion: 1, bodyHash, targets: agentTargets,
            ...(invocationSelections ? { selections: invocationSelections } : {}) })], maxRows: 1 });
        if (written.length !== 1) throw new MessageAuthorityError("message_targets_commit_failed", 500,
          "The original message targets could not be recorded");
      }
      if (attachmentRows.length > 0) await transaction.query({
          name: "message_append_attachment_batch_v2",
          text: `INSERT INTO data.message_attachment_refs
            (space_id, attachment_id, message_id, channel_id, owner_user_id, object_key,
             content_hash, encoded_bytes, mime_type, name, presentation_residual_json,
             version, created_at, updated_at)
            SELECT $2,row.attachment_id,$3,$4,$5,row.object_key,row.content_hash,
              row.encoded_bytes,row.mime_type,row.name,row.presentation_residual_json,1,$6,$6
            FROM jsonb_to_recordset($1::jsonb) AS row(
              attachment_id text,object_key text,content_hash text,encoded_bytes bigint,
              mime_type text,name text,presentation_residual_json jsonb)`,
          values: [JSON.stringify(attachmentRows), spaceId, messageId, channelId,
            attachmentOwnerUserId, sentAt], maxRows: 0,
        });
      if (targets.size > 0) await transaction.query({
        name: "message_append_attention_batch_v2",
        text: `WITH incoming AS MATERIALIZED (
            SELECT * FROM jsonb_to_recordset($1::jsonb) AS value(subject_id text,kind text)
          ), attention_rows AS (
            INSERT INTO data.message_attention
              (space_id,subject_id,channel_id,message_id,kind,timeline_sequence,created_at)
            SELECT $2,incoming.subject_id,$3,$4,incoming.kind,$5,$6 FROM incoming
            ON CONFLICT DO NOTHING RETURNING subject_id
          ) INSERT INTO data.message_attention_revisions
            (space_id,subject_id,channel_id,revision,updated_at)
          SELECT $2,incoming.subject_id,$3,1,$6 FROM incoming
          WHERE EXISTS (SELECT 1 FROM attention_rows WHERE
            attention_rows.subject_id=incoming.subject_id)
          ON CONFLICT (space_id,subject_id,channel_id) DO UPDATE SET
            revision=data.message_attention_revisions.revision+1,
            updated_at=EXCLUDED.updated_at`,
        values: [JSON.stringify([...targets].map(([subjectId, kind]) => ({
          subject_id: subjectId, kind,
        }))), spaceId, channelId, messageId, sequence, sentAt],
        maxRows: 0,
      });
      const result = {
        messageId, channelId, spaceId, sequence, entityVersion: 1,
        ...(agentSendFingerprint ? { agentSendFingerprint } : {}),
        contentHash: bodyHash, bodyHash, recordDigest, senderSnapshotDigest,
        senderSnapshot: input.senderSnapshot, codecId: input.prepared.codecId,
        messageKind, payloadSchemaVersion: input.prepared.payloadSchemaVersion,
        payloadKind: "hot-inline", searchRankSeq: searchRank, changeSeq: sequence,
        committedAt: sentAt, visibilityScopeId: `postgres:${spaceId}:${channelId}`,
        contentRevision: Number(committedFacts.content_revision),
        attentionTargetCount: targets.size,
        ...(attachmentViews.length ? { attachments: attachmentViews } : {}),
        ...(replyOrigin ? { replyOrigin: { ...replyOrigin, replier: replierPresentation(input.senderSnapshot) } } : {}),
      };
      const expiresAt = new Date(Date.parse(sentAt) + IDEMPOTENCY_TTL_MS).toISOString();
      // Billing admission and the durable publish receipt share the final SQL
      // statement, so a metered counter is never locked across another round trip.
      const billing = this.billing.message;
      const admission = (await transaction.query<MessagePublishRow>({
        name: `message_append_publish_${this.billing.id}_v1`,
        text: `WITH ${billing.ctes}, accepted AS MATERIALIZED (
            SELECT admission.*,$5::jsonb AS result_json FROM admission
            WHERE NOT $10 OR (${billing.accepts})
          ), activity_row AS (
            UPDATE data.channels SET
              activity_at=GREATEST(COALESCE(activity_at,updated_at),$6::timestamptz)
            WHERE space_id=$2 AND channel_id=$11
              AND EXISTS (SELECT 1 FROM accepted)
            RETURNING channel_id
          ), outbox_row AS (
            INSERT INTO data.outbox
              (outbox_id,space_id,topic,aggregate_kind,aggregate_id,aggregate_sequence,
               payload_json,status,attempts,available_at,lease_until,created_at,updated_at)
            SELECT $1,$2,'message','message',$3,1,accepted.result_json,
              'pending',0,$6,NULL,$6,$6 FROM accepted CROSS JOIN activity_row
            RETURNING outbox_id,payload_json
          ), receipt AS (
            INSERT INTO data.idempotency_keys
            (space_id,idempotency_key,command_kind,request_digest,result_json,
             commit_sequence,created_at,expires_at)
            SELECT $2,$7,'message-append',$8,outbox_row.payload_json,$4,$6,$9 FROM outbox_row
            RETURNING result_json
          ), reservation_commit AS (
            UPDATE data.message_sequence_reservations SET
              state='committed',fact_digest=$12,
              updated_at=GREATEST(updated_at,$6::timestamptz)
            WHERE space_id=$2 AND command_id=$7 AND channel_id=$11 AND sequence=$4
              AND (fact_digest IS NULL OR fact_digest=$12)
              AND EXISTS (SELECT 1 FROM receipt)
            RETURNING channel_id
          ), sequence_confirm AS (
            UPDATE data.channel_message_sequences SET
              confirmed_sequence=GREATEST(confirmed_sequence,$4),updated_at=$6
            WHERE space_id=$2 AND channel_id=$11
              AND EXISTS (SELECT 1 FROM reservation_commit)
            RETURNING channel_id
          ) SELECT admission.*,(SELECT result_json FROM receipt) AS result_json,
              (SELECT channel_id FROM activity_row) AS channel_id,
              EXISTS (SELECT 1 FROM accepted) AS accepted,
              EXISTS (SELECT 1 FROM sequence_confirm) AS sequence_confirmed FROM admission`,
        values: [`message:${spaceId}:${messageId}:1`, spaceId, messageId, sequence,
          JSON.stringify(result), sentAt, commandId, requestDigest, expiresAt,
          !messageKind.startsWith("xmatrix.system."), channelId, recordDigest],
        maxRows: 1,
      }))[0];
      if (admission?.accepted && !admission.channel_id) throw new MessageAuthorityError(
        "channel_not_found", 404, "Channel not found",
      );
      if (admission?.accepted && !admission.sequence_confirmed) throw new MessageAuthorityError(
        "message_sequence_confirmation_failed", 500,
        "Message sequence confirmation failed",
      );
      if (dingtalkEffect) await finishDingTalkEffect(transaction,dingtalkEffect);
      return publishedResult(admission, this.billing, {
        billable: !messageKind.startsWith("xmatrix.system."), now: sentAt,
      });
    });
  }

  async reconcileAppend(input: {
    requestId: string;
    commandId: string;
    requestDigest: string;
    spaceId: string;
  }, dingtalkEffect?: { authority: DingTalkEffectAuthority; bodyHash: string }): Promise<Record<string, unknown> | null> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const commandId = bounded(input.commandId, "commandId");
    const requestDigest = digest(input.requestDigest, "requestDigest");
    const spaceId = bounded(input.spaceId, "spaceId");
    const placement=await this.placement(requestId,"message.reconcile-append",spaceId);
    return this.database.transaction({ requestId,operation: "message.reconcile-append",placement: {
      spaceId,shardId: placement.shardId,placementEpoch: placement.placementEpoch } }, async transaction => {
      if (dingtalkEffect) await authorizeDingTalkEffect(transaction,dingtalkEffect.authority,{
        kind: "channel",id: dingtalkEffect.authority.destination.id,channelId: dingtalkEffect.authority.destination.channelId,
        spaceId,shardId: placement.shardId,effectId: commandId,
        authorityRootUserId: dingtalkEffect.authority.destination.authorityRootUserId,bodyHash: dingtalkEffect.bodyHash });
      const row = (await transaction.query<QueryResultRow & {
        command_kind: string; request_digest: string; result_json: Record<string, unknown>;
      }>({
        name: "message_append_reconcile_v1",
        text: `SELECT command_kind,request_digest,result_json FROM data.idempotency_keys
          WHERE space_id=$1 AND idempotency_key=$2 LIMIT 1`,
        values: [spaceId, commandId], maxRows: 1,
      }))[0];
      if (dingtalkEffect) await finishDingTalkEffect(transaction,dingtalkEffect.authority);
      if (!row) return null;
      if (row.command_kind !== "message-append" || row.request_digest !== requestDigest) {
        throw new MessageAuthorityError("idempotency_conflict", 409, "Command id was reused");
      }
      return row.result_json;
    });
  }

  /** This reads commit evidence only. It never renews a Run or retries an append. */
  async httpAppendReceipt(input: {
    requestId: string; spaceId: string; channelId: string; messageId: string;
    principal: MessagePrincipal; runProof?: AppendPostgresMessage["runProof"];
    expectedBodyHash?: string;
  }): Promise<MessageCommitReceipt> {
    const { requestId, spaceId, channelId, principal } = messageScope(input);
    // HTTP command ids have a 200-byte limit; reject rather than truncate a
    // caller's receipt selector into a different command identity.
    const messageId = bounded(input.messageId, "messageId", 160);
    const expectedBodyHash = input.expectedBodyHash === undefined ? undefined
      : digest(input.expectedBodyHash, "expectedBodyHash");
    if (principal.kind !== "user" && principal.kind !== "agent") throw new MessageAuthorityError(
      "forbidden", 403, "Message receipts require a Human or Agent principal");
    if (principal.kind === "agent" && !input.runProof) throw new MessageAuthorityError(
      "agent_run_forbidden", 403, "An Agent receipt requires its exact active Run");
    const placement = await this.placement(requestId, "message.http-append-receipt", spaceId);
    return this.database.transaction({ requestId, operation: "message.http-append-receipt",
      placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch } }, async (tx) => {
      const effective = await effectiveAppendPrincipal(tx, { spaceId, channelId, principal, runProof: input.runProof });
      await messageChannelCapability(tx, { spaceId, channelId, principal: effective.principal },
        "message_content_read");
      const row = (await tx.query<QueryResultRow>({ name: "message_http_append_receipt_v1", text: `SELECT
          (SELECT result_json FROM data.idempotency_keys WHERE space_id=$1 AND idempotency_key=$2
            AND command_kind='message-append' AND expires_at>clock_timestamp()) AS receipt,
          (SELECT jsonb_build_object('bodyHash',body_hash,'sequence',timeline_sequence,
              'senderKind',author_kind,'senderId',author_id)
            FROM data.messages WHERE space_id=$1 AND channel_id=$3 AND message_id=$4
              AND entity_version=1 AND deleted_at IS NULL AND recalled_at IS NULL) AS publication,
          EXISTS (SELECT 1 FROM data.messages WHERE space_id=$1 AND channel_id=$3 AND message_id=$4) AS message_exists`,
        values: [spaceId, `product:append-message:${messageId}`, channelId, messageId], maxRows: 1 }))[0];
      if (!row) throw new MessageAuthorityError("receipt_unavailable", 503, "Message receipt could not be read", true);
      const base = { schemaVersion: 1 as const, channelId, messageId, observedAt: new Date().toISOString() };
      const raw = row?.receipt;
      if (raw === null || raw === undefined) return {
        ...base, status: row.message_exists === true ? "receipt_unavailable" : "not_found" };
      if (typeof raw !== "object" || Array.isArray(raw) || !row.publication ||
          typeof row.publication !== "object" || Array.isArray(row.publication)) {
        return { ...base, status: "receipt_unavailable" };
      }
      const receipt = raw as Record<string, unknown>;
      const publication = row.publication as Record<string, unknown>;
      const sender = receipt.senderSnapshot && typeof receipt.senderSnapshot === "object" && !Array.isArray(receipt.senderSnapshot)
        ? receipt.senderSnapshot as Record<string, unknown> : {};
      const senderId = sender.kind === "agent" ? sender.agentId ?? sender.identityId : sender.userId;
      if (receipt.channelId !== channelId || receipt.messageId !== messageId ||
          receipt.spaceId !== spaceId || (input.runProof && (sender.kind !== "agent" ||
            senderId !== principal.id || sender.instanceId !== input.runProof.instanceId))) {
        return { ...base, status: "receipt_unavailable" };
      }
      if ((sender.kind !== "user" && sender.kind !== "agent") || typeof senderId !== "string" || !senderId ||
          typeof receipt.bodyHash !== "string" || !/^[0-9a-f]{64}$/u.test(receipt.bodyHash) ||
          !Number.isSafeInteger(receipt.sequence) || Number(receipt.sequence) < 1 ||
          publication.bodyHash !== receipt.bodyHash || Number(publication.sequence) !== receipt.sequence ||
          publication.senderKind !== sender.kind || publication.senderId !== senderId) {
        return { ...base, status: "receipt_unavailable" };
      }
      if (expectedBodyHash !== undefined && expectedBodyHash !== receipt.bodyHash) throw new MessageAuthorityError(
        "idempotency_conflict", 409, "This message id was committed with different content");
      return { ...base, status: "committed", sequence: Number(receipt.sequence), bodyHash: receipt.bodyHash,
        ...(typeof receipt.agentSendFingerprint === "string" && /^[0-9a-f]{64}$/u.test(receipt.agentSendFingerprint)
          ? { agentSendFingerprint: receipt.agentSendFingerprint } : {}),
        sender: { kind: sender.kind, id: senderId,
          ...(typeof sender.instanceId === "string" ? { instanceId: sender.instanceId } : {}) } };
    });
  }

  async mutationCandidate(input: {
    requestId: string;
    spaceId: string;
    channelId: string;
    messageId: string;
    principal: MessagePrincipal;
    access?: MessageMutationAccess;
    /** Only delete retry preflight may inspect an already-deleted row; current authorization still applies. */
    includeDeleted?: boolean;
  }): Promise<Record<string, unknown>> {
    const { requestId, spaceId, channelId, principal, messageId } = messageIdentity(input);
    return this.inSpace(requestId, "message.mutation-candidate", spaceId, async (transaction) => {
      const row = await mutableMessage(
        transaction, { spaceId, channelId, messageId, principal }, false, input.access, input.includeDeleted,
      );
      await hydrateTombstoneSenders(transaction, spaceId, [row]);
      return serializeMessage(row);
    });
  }

  async senderRepairCandidate(input: {
    requestId: string;
    spaceId: string;
    channelId: string;
    messageId: string;
    principal: MessagePrincipal;
  }): Promise<Record<string, unknown>> {
    const { requestId, spaceId, channelId, principal, messageId } = messageIdentity(input);
    return this.inSpace(requestId, "message.sender-repair-candidate", spaceId, async (transaction) => {
      await messageChannelCapability(transaction, { spaceId, channelId, principal },
        "message_maintenance_repair");
      const rows = await transaction.query<MessageRow>({
        name: "message_sender_repair_candidate_v1",
        text: `SELECT message_id, channel_id, timeline_sequence, entity_version, author_kind,
            author_id, message_kind, content_hash, payload_kind, payload_ref, reactions_json,
            annotations_json, attachments_json, sent_at, edited_at, recalled_at, deleted_at,
            updated_at, search_rank_sequence, codec_id, payload_schema_version,
            field_presence_base64, payload_bundle_base64, body_hash, sender_snapshot_digest,
            record_digest, record_encoded_bytes
          FROM data.messages WHERE space_id = $1 AND channel_id = $2 AND message_id = $3
            AND deleted_at IS NULL LIMIT 1`,
        values: [spaceId, channelId, messageId], maxRows: 1,
      });
      if (!rows[0]) throw new MessageAuthorityError("message_not_found", 404, "Message not found");
      return serializeMessage(rows[0]);
    });
  }

  async threadRoot(input: {
    requestId: string;
    spaceId: string;
    channelId: string;
    messageId: string;
    sequence: number;
    principal: MessagePrincipal;
  }): Promise<Record<string, unknown>> {
    const { requestId, spaceId, channelId, principal, messageId } = messageIdentity(input);
    const sequence = positive(input.sequence, "sequence");
    return this.inSpace(requestId, "message.thread-root", spaceId, async (transaction) => {
      await messageChannelCapability(transaction, { spaceId, channelId, principal },
        "message_active_command_preflight");
      const rows = await transaction.query<MessageRow>({
        name: "message_thread_root_v1",
        text: `SELECT message_id, channel_id, timeline_sequence, entity_version, author_kind,
            author_id, message_kind, content_hash, payload_kind, payload_ref, reactions_json,
            annotations_json, attachments_json, sent_at, edited_at, recalled_at, deleted_at,
            updated_at, search_rank_sequence, codec_id, payload_schema_version,
            field_presence_base64, payload_bundle_base64, body_hash, sender_snapshot_digest,
            record_digest, record_encoded_bytes
          FROM data.messages WHERE space_id = $1 AND channel_id = $2 AND message_id = $3
            AND timeline_sequence = $4 AND deleted_at IS NULL LIMIT 1`,
        values: [spaceId, channelId, messageId, sequence], maxRows: 1,
      });
      const row = rows[0];
      if (!row || row.recalled_at !== null ||
          (row.author_kind !== "user" && row.author_kind !== "agent") || !row.message_kind) {
        throw new MessageAuthorityError(
          "thread_root_unavailable", 409,
          "Thread root is no longer a live supported message in the parent Channel",
        );
      }
      return {
        messageId: row.message_id,
        channelId: row.channel_id,
        sequence: Number(row.timeline_sequence),
        authorKind: row.author_kind,
        authorId: row.author_id,
        messageKind: row.message_kind,
        entityVersion: Number(row.entity_version),
        sentAt: iso(row.sent_at),
        ...(row.edited_at ? { editedAt: iso(row.edited_at) } : {}),
        payloadKind: row.payload_kind,
        payloadSchemaVersion: row.payload_schema_version,
        bodyHash: row.body_hash,
        senderSnapshotDigest: row.sender_snapshot_digest,
        recordDigest: row.record_digest,
        recordEncodedBytes: row.record_encoded_bytes === null ? null : Number(row.record_encoded_bytes),
        searchRankSeq: row.search_rank_sequence,
        ...(row.payload_bundle_base64 ? { payloadBundleBase64: row.payload_bundle_base64 } : {}),
      };
    });
  }

  async annotationMessageId(input: {
    requestId: string;
    spaceId: string;
    channelId: string;
    annotationId: string;
    principal: MessagePrincipal;
  }): Promise<string> {
    const { requestId, spaceId, channelId, principal } = messageScope(input);
    const annotationId = bounded(input.annotationId, "annotationId");
    return this.inSpace(requestId, "message.annotation-resolve", spaceId, async (transaction) => {
      await messageChannelCapability(transaction, { spaceId, channelId, principal },
        "message_active_command_preflight");
      const rows = await transaction.query<QueryResultRow & { message_id: string | null }>({
        name: "message_annotation_resolve_v1",
        text: `SELECT message_id FROM data.message_annotations WHERE space_id = $1
          AND channel_id = $2 AND annotation_id = $3 LIMIT 1`,
        values: [spaceId, channelId, annotationId], maxRows: 1,
      });
      if (!rows[0]?.message_id) throw new MessageAuthorityError(
        "annotation_not_found", 404, "Annotation not found",
      );
      return rows[0].message_id;
    });
  }

  async updatePrepared(input: PostgresMessageMutationBase & {
    prepared: PreparedPostgresMessageRecord;
    editedAt: string;
  }): Promise<Record<string, unknown>> {
    const mutation = messageMutation(input);
    const { spaceId, channelId, principal, commandId, messageId, expectedVersion, requestDigest } = mutation;
    return this.mutateMessage(mutation, "message.edit", "message-edit", "author", async (transaction, candidate) => {
      if (candidate.recalled_at !== null || candidate.payload_bundle_base64 === null) {
        throw new MessageAuthorityError("message_not_editable", 409, "Message cannot be edited");
      }
      const now = timestamp(input.editedAt, "editedAt");
      const entityVersion = expectedVersion + 1;
      const bodyHash = digest(input.prepared.bodyHash, "prepared.bodyHash");
      const recordDigest = digest(input.prepared.recordDigest, "prepared.recordDigest");
      const senderSnapshotDigest = digest(
        input.prepared.senderSnapshotDigest, "prepared.senderSnapshotDigest",
      );
      const updated = await transaction.query({
        name: "message_edit_update_v1",
        text: `UPDATE data.messages SET entity_version = $4, invocation_input_version = $4, content_hash = $5, edited_at = $6,
          updated_at = $6, codec_id = $7, payload_schema_version = $8,
          field_presence_base64 = $9, payload_bundle_base64 = $10, body_hash = $5,
          sender_snapshot_digest = $11, record_digest = $12, record_encoded_bytes = $13,
          preview_json = $15::jsonb
          WHERE space_id = $1 AND channel_id = $2 AND message_id = $3
            AND entity_version = $14 RETURNING message_id`,
        values: [spaceId, channelId, messageId, entityVersion, bodyHash, now,
          input.prepared.codecId, input.prepared.payloadSchemaVersion,
          input.prepared.fieldPresenceBase64, input.prepared.payloadBundleBase64,
          senderSnapshotDigest, recordDigest, input.prepared.recordEncodedBytes, expectedVersion,
          storedMessagePreview(input.prepared.preview)],
        maxRows: 1,
      });
      requireMessageUpdate(updated);
      const result = {
        messageId, channelId, sequence: Number(candidate.timeline_sequence), entityVersion,
        editedAt: now, committedAt: now, bodyHash, senderSnapshotDigest, recordDigest,
      };
      await finalizeMutation(transaction, {
        spaceId, channelId, messageId, commandId, commandKind: "message-edit", requestDigest,
        entityVersion, mutationKind: "edit", mutation: { recordDigest }, principal, result, now,
      });
      return result;
    });
  }

  async tombstone(input: PostgresMessageMutationBase & {
    kind: "recall" | "delete";
    redactedContentHash: string;
  }): Promise<Record<string, unknown>> {
    const mutation = messageMutation(input);
    const { spaceId, channelId, principal, commandId, messageId, expectedVersion, requestDigest } = mutation;
    const redactedContentHash = digest(input.redactedContentHash, "redactedContentHash");
    const commandKind = `message-${input.kind}`;
    return this.mutateMessage(mutation, commandKind, commandKind, "author", async (transaction, candidate) => {
      const now = new Date().toISOString();
      const entityVersion = expectedVersion + 1;
      const field = input.kind === "recall" ? "recalled_at" : "deleted_at";
      const updated = await transaction.query({
        name: input.kind === "recall" ? "message_recall_update_v1" : "message_delete_update_v1",
        text: `UPDATE data.messages SET ${field} = $4, entity_version = $5, invocation_input_version = $5, updated_at = $4,
          content_hash = $6, payload_kind = 'redacted', payload_ref = $8,
          archive_source_json = NULL, field_presence_base64 = NULL,
          payload_bundle_base64 = NULL, legacy_body = NULL, body_hash = NULL,
          sender_snapshot_digest = NULL, record_digest = NULL, record_encoded_bytes = NULL,
          preview_json = NULL
          WHERE space_id = $1 AND channel_id = $2 AND message_id = $3
            AND entity_version = $7 RETURNING message_id`,
        values: [spaceId, channelId, messageId, now, entityVersion, redactedContentHash,
          expectedVersion, `redacted:${redactedContentHash}`],
        maxRows: 1,
      });
      requireMessageUpdate(updated);
      const result = {
        messageId, channelId, spaceId,
        visibilityScopeId: channelVisibilityScope({ mode: candidate.channel_mode, channelId: channelId, spaceId: spaceId }),
        sequence: Number(candidate.timeline_sequence), entityVersion,
        committedAt: now,
        ...(input.kind === "recall" ? { recalledAt: now } : { deletedAt: now }),
      };
      await finalizeMutation(transaction, {
        spaceId, channelId, messageId, commandId, commandKind, requestDigest, entityVersion,
        mutationKind: input.kind, mutation: { redacted: true }, principal, result, now,
      });
      return result;
    });
  }

  async mutateCollection(input: PostgresMessageCollectionMutation): Promise<Record<string, unknown>> {
    const mutation = messageMutation(input);
    const { spaceId, channelId, principal, commandId, messageId, expectedVersion, requestDigest } = mutation;
    const commandKind = `message-${input.kind}`;
    const access = input.kind === "reaction" ? "participant" : "author";
    return this.mutateMessage(mutation, commandKind, commandKind, access, async (transaction, candidate) => {
      const now = new Date().toISOString();
      const entityVersion = expectedVersion + 1;
      let column: "reactions_json" | "annotations_json" | "attachments_json";
      let collection: Record<string, unknown>[];
      let result: Record<string, unknown>;
      if (input.kind === "reaction") {
        column = "reactions_json";
        collection = structuredClone(candidate.reactions_json) as Record<string, unknown>[];
        const emoji = bounded(input.emoji, "emoji", 80);
        const reactorLabel = bounded(input.reactorLabel, "reactorLabel");
        // The same identity a message from this principal carries.
        const identityId = principal.kind === "user" ? `user:${principal.id}` : principal.id;
        const group = collection.find((entry) => entry.emoji === emoji);
        const reactors = group && Array.isArray(group.reactors)
          ? group.reactors as Record<string, unknown>[] : [];
        const index = reactors.findIndex((entry) => entry.identityId === identityId);
        const added = index < 0;
        if (added) reactors.push({ identityId, label: reactorLabel });
        else reactors.splice(index, 1);
        if (group) {
          group.reactors = reactors;
          if (reactors.length === 0) collection.splice(collection.indexOf(group), 1);
        } else collection.push({ emoji, reactors });
        if (added) {
          await transaction.query({
            name: "message_reaction_upsert_v2",
            text: `INSERT INTO data.message_reactions
              (space_id, channel_id, message_id, emoji, reactor_kind, reactor_user_id, reactor_label,
               created_at, updated_at) VALUES ($1,$2,$3,$4,$8,$5,$6,$7,$7)
              ON CONFLICT (space_id, message_id, emoji, reactor_user_id) DO UPDATE SET
                reactor_kind = EXCLUDED.reactor_kind,
                reactor_label = EXCLUDED.reactor_label, updated_at = EXCLUDED.updated_at`,
            values: [spaceId, channelId, messageId, emoji, principal.id, reactorLabel, now, principal.kind],
            maxRows: 0,
          });
        } else {
          await transaction.query({
            name: "message_reaction_remove_v2",
            text: `DELETE FROM data.message_reactions WHERE space_id = $1 AND message_id = $2
              AND emoji = $3 AND reactor_user_id = $4 AND COALESCE(reactor_kind, 'user') = $5`,
            values: [spaceId, messageId, emoji, principal.id, principal.kind], maxRows: 0,
          });
        }
        result = { messageId, channelId, reactions: collection };
      } else if (input.kind === "annotation") {
        if (principal.kind !== "user") throw new MessageAuthorityError(
          "forbidden", 403, "Annotation actor is invalid",
        );
        column = "annotations_json";
        collection = structuredClone(candidate.annotations_json) as Record<string, unknown>[];
        const annotationId = bounded(input.annotationId, "annotationId");
        const index = collection.findIndex((entry) => entry.id === annotationId);
        // Reserved namespaces hold the Hub's own judgments (annotateAsSystem):
        // no principal writes, replaces or removes one.
        if ((index >= 0 && isReservedAnnotationNamespace(String(collection[index]!.namespace ?? ""))) ||
            (input.action !== "remove" && typeof input.namespace === "string" &&
              isReservedAnnotationNamespace(input.namespace))) {
          throw new MessageAuthorityError("forbidden", 403, "Annotation namespace is reserved");
        }
        if (input.action === "remove") {
          if (index < 0) throw new MessageAuthorityError(
            "annotation_not_found", 404, "Annotation not found",
          );
          collection.splice(index, 1);
          await transaction.query({
            name: "message_annotation_remove_v1",
            text: "DELETE FROM data.message_annotations WHERE space_id = $1 AND annotation_id = $2",
            values: [spaceId, annotationId], maxRows: 0,
          });
          result = { annotationId, messageId, channelId, removed: true };
        } else {
          const namespace = bounded(input.namespace, "namespace", 160);
          const authorLabel = bounded(input.authorLabel ?? principal.id, "authorLabel");
          const payload = input.payload ?? {};
          const annotation = await putMessageAnnotation(transaction, "message_annotation_upsert_v1", {
            spaceId, channelId, messageId, annotationId, namespace, collection, index,
            authorUserId: principal.id, authorLabel, payload, now,
          });
          result = annotation;
        }
      } else {
        column = "attachments_json";
        collection = structuredClone(candidate.attachments_json) as Record<string, unknown>[];
        if (input.action === "remove") {
          const attachmentId = bounded(input.attachmentId, "attachmentId");
          const index = collection.findIndex((entry) => entry.id === attachmentId);
          if (index < 0) throw new MessageAuthorityError(
            "message_attachment_not_found", 404, "Attachment not found",
          );
          collection.splice(index, 1);
          await transaction.query({
            name: "message_attachment_remove_v1",
            text: `DELETE FROM data.message_attachment_refs
              WHERE space_id = $1 AND message_id = $2 AND attachment_id = $3`,
            values: [spaceId, messageId, attachmentId], maxRows: 0,
          });
        } else {
          const sealed = input.sealedAttachments;
          if (!Array.isArray(sealed) || sealed.length < 1 || sealed.length > 10) {
            throw new MessageAuthorityError(
              "attachment_authority_invalid", 400, "Verified attachment receipts are required",
            );
          }
          const existing = new Set(collection.map((entry) => String(entry.id)));
          for (const attachment of sealed) {
            const attachmentId = bounded(attachment.id, "attachment.id");
            if (existing.has(attachmentId)) throw new MessageAuthorityError(
              "message_attachment_conflict", 409, "Attachment is already bound",
            );
            existing.add(attachmentId);
            const presentationResidual = Object.fromEntries(
              ["durationMs", "width", "height", "transcodingStatus"]
                .filter((key) => attachment[key] !== undefined)
                .map((key) => [key, attachment[key]]),
            );
            await transaction.query({
              name: "message_attachment_upsert_v1",
              text: `INSERT INTO data.message_attachment_refs
                (space_id, attachment_id, message_id, channel_id, owner_user_id, object_key,
                 content_hash, encoded_bytes, mime_type, name, presentation_residual_json,
                 version, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,1,$12,$12)`,
              values: [spaceId, attachmentId, messageId, channelId,
                input.attachmentOwnerUserId
                  ? bounded(input.attachmentOwnerUserId, "attachmentOwnerUserId")
                  : principal.kind === "user" ? principal.id : null,
                bounded(attachment.objectKey, "attachment.objectKey", 2_000),
                digest(attachment.contentHash, "attachment.contentHash"),
                positive(attachment.size, "attachment.size"),
                bounded(attachment.mimeType, "attachment.mimeType"),
                bounded(attachment.name, "attachment.name", 1_000),
                Object.keys(presentationResidual).length > 0
                  ? JSON.stringify(presentationResidual) : null,
                now], maxRows: 0,
            });
            collection.push(attachment);
          }
        }
        result = { messageId, channelId, attachments: collection };
      }
      await writeMessageCollection(transaction, `message_${input.kind}_collection_update_v1`, {
        spaceId, channelId, messageId, column,
        invocationInputVersion: input.kind === "reaction" ? "COALESCE(invocation_input_version,$7)" : "$5",
        collection, entityVersion, expectedVersion, now,
      });
      await finalizeMutation(transaction, {
        spaceId, channelId, messageId, commandId, commandKind, requestDigest, entityVersion,
        mutationKind: input.kind, mutation: result, principal, result, now,
      });
      return result;
    });
  }

  /**
   * Record a judgment the Hub made about a message, authored by `system`
   * rather than by any principal (docs/design/conversation-activity.md §3.3).
   * Only trusted Hub code calls this; public annotation writes may not use a
   * reserved `xmatrix.` namespace. Returns null when the message is gone,
   * recalled, or already carries this exact judgment.
   */
  async annotateAsSystem(input: {
    requestId: string;
    spaceId: string;
    channelId: string;
    messageId: string;
    namespace: string;
    annotationId: string;
    payload: Record<string, unknown>;
    requestDigest: string;
  }): Promise<Record<string, unknown> | null> {
    const { requestId, spaceId, channelId } = channelRequest(input);
    const messageId = bounded(input.messageId, "messageId");
    const namespace = bounded(input.namespace, "namespace", 160);
    if (!isReservedAnnotationNamespace(namespace)) throw new MessageAuthorityError(
      "invalid_command", 400, "A system annotation needs a reserved namespace",
    );
    const annotationId = bounded(input.annotationId, "annotationId");
    const requestDigest = digest(input.requestDigest, "requestDigest");
    const commandKind = "message-system-annotation";
    const principal = { kind: "system" as const, id: "xmatrix" };
    return this.inSpace(requestId, commandKind, spaceId, async (transaction) => {
      const rows = await transaction.query<MutableMessageRow>({
        name: "message_system_annotation_candidate_v1",
        text: `SELECT m.* FROM data.messages m WHERE m.space_id = $1 AND m.channel_id = $2
          AND m.message_id = $3 AND m.deleted_at IS NULL AND m.recalled_at IS NULL
          LIMIT 1 FOR UPDATE`,
        values: [spaceId, channelId, messageId], maxRows: 1,
      });
      const candidate = rows[0];
      if (!candidate) return null;
      const collection = structuredClone(candidate.annotations_json) as Record<string, unknown>[];
      const index = collection.findIndex((entry) => entry.id === annotationId);
      const previous = index >= 0 ? collection[index] : undefined;
      if (previous && JSON.stringify(previous.payload) === JSON.stringify(input.payload)) return null;
      const now = new Date().toISOString();
      const expectedVersion = Number(candidate.entity_version);
      const entityVersion = expectedVersion + 1;
      const annotation = await putMessageAnnotation(transaction, "message_system_annotation_upsert_v2", {
        spaceId, channelId, messageId, annotationId, namespace, collection, index,
        authorUserId: SYSTEM_ANNOTATION_AUTHOR, authorLabel: "xMatrix", payload: input.payload, now,
      });
      // A judgment about a message is not new input to whatever it invoked,
      // so unlike an author's annotation it leaves the invocation version alone.
      await writeMessageCollection(transaction, "message_system_annotation_collection_update_v1", {
        spaceId, channelId, messageId, column: "annotations_json", invocationInputVersion: null,
        collection, entityVersion, expectedVersion, now,
      });
      await finalizeMutation(transaction, {
        spaceId, channelId, messageId, requestDigest, entityVersion,
        commandId: `system-annotation:${annotationId}:${entityVersion}`.slice(0, 200),
        commandKind, mutationKind: "annotation", mutation: annotation, principal,
        result: annotation, now,
      });
      return annotation;
    });
  }

  async repairSenderSnapshots(input: PostgresSenderSnapshotRepair): Promise<Record<string, unknown>> {
    const { requestId, spaceId, channelId, principal } = messageScope(input);
    const commandId = bounded(input.commandId, "commandId");
    const requestDigest = digest(input.requestDigest, "requestDigest");
    const agentId = bounded(input.agentId, "agentId");
    const repairedAt = timestamp(input.repairedAt, "repairedAt");
    if (principal.kind !== "user" || input.repairs.length < 1 || input.repairs.length > 64) {
      throw new MessageAuthorityError("invalid_command", 400, "Sender repair is invalid");
    }
    const repairs = input.repairs.map((entry) => ({
      ...entry,
      messageId: bounded(entry.messageId, "repairs.messageId"),
      expectedEntityVersion: positive(entry.expectedEntityVersion, "repairs.expectedEntityVersion"),
      expectedRecordDigest: digest(entry.expectedRecordDigest, "repairs.expectedRecordDigest"),
    })).sort((left, right) => left.messageId.localeCompare(right.messageId));
    if (new Set(repairs.map((entry) => entry.messageId)).size !== repairs.length) {
      throw new MessageAuthorityError("invalid_command", 400, "Repair message ids must be unique");
    }
    return this.inSpace(requestId, "message.sender-repair", spaceId, async (transaction) => {
      const replay = await mutationReplay(transaction, {
        spaceId, commandId, commandKind: "message-sender-repair", requestDigest,
      });
      if (replay) return replay;
      await messageChannelCapability(transaction, { spaceId, channelId, principal },
        "message_maintenance_repair");
      const rows = await transaction.query<MutableMessageRow>({
        name: "message_sender_repair_lock_v1",
        text: `SELECT * FROM data.messages WHERE space_id = $1 AND channel_id = $2
          AND message_id = ANY($3::text[]) AND deleted_at IS NULL ORDER BY message_id FOR UPDATE`,
        values: [spaceId, channelId, repairs.map((entry) => entry.messageId)], maxRows: repairs.length,
      });
      const byId = new Map(rows.map((row) => [row.message_id, row]));
      for (const repair of repairs) {
        const row = byId.get(repair.messageId);
        if (!row || row.author_kind !== "agent" || row.author_id !== agentId ||
            Number(row.entity_version) !== repair.expectedEntityVersion ||
            row.record_digest !== repair.expectedRecordDigest || !row.payload_bundle_base64) {
          throw new MessageAuthorityError(
            "sender_snapshot_repair_conflict", 409,
            "Agent sender repair no longer matches canonical message authority",
          );
        }
      }
      const repaired: Record<string, unknown>[] = [];
      for (const repair of repairs) {
        const nextVersion = repair.expectedEntityVersion + 1;
        const prepared = repair.prepared;
        const updated = await transaction.query({
          name: "message_sender_repair_update_v1",
          text: `UPDATE data.messages SET entity_version = $4, invocation_input_version = $4, updated_at = $5,
            field_presence_base64 = $6, payload_bundle_base64 = $7, body_hash = $8,
            sender_snapshot_digest = $9, record_digest = $10, record_encoded_bytes = $11,
            preview_json = $14::jsonb
            WHERE space_id = $1 AND channel_id = $2 AND message_id = $3
              AND entity_version = $12 AND record_digest = $13 RETURNING message_id`,
          values: [spaceId, channelId, repair.messageId, nextVersion, repairedAt,
            prepared.fieldPresenceBase64, prepared.payloadBundleBase64,
            digest(prepared.bodyHash, "prepared.bodyHash"),
            digest(prepared.senderSnapshotDigest, "prepared.senderSnapshotDigest"),
            digest(prepared.recordDigest, "prepared.recordDigest"),
            positive(prepared.recordEncodedBytes, "prepared.recordEncodedBytes"),
            repair.expectedEntityVersion, repair.expectedRecordDigest,
            storedMessagePreview(prepared.preview)], maxRows: 1,
        });
        if (!updated[0]) throw new MessageAuthorityError(
          "sender_snapshot_repair_conflict", 409, "Agent sender message changed during repair",
        );
        const item = {
          messageId: repair.messageId,
          entityVersion: nextVersion,
          recordDigest: prepared.recordDigest,
          senderSnapshotDigest: prepared.senderSnapshotDigest,
        };
        repaired.push(item);
        await normalizeMessageCreateEvent(transaction, {
          spaceId, channelId, messageId: repair.messageId,
        });
        await transaction.query({
          name: "message_sender_repair_ledger_v1",
          text: `INSERT INTO data.message_mutations
            (space_id, channel_id, message_id, entity_version, mutation_kind, mutation_json,
             actor_kind, actor_id, occurred_at) VALUES ($1,$2,$3,$4,'edit',$5::jsonb,$6,$7,$8)`,
          values: [spaceId, channelId, repair.messageId, nextVersion,
            JSON.stringify({ senderSnapshotRepair: true, ...item }), principal.kind, principal.id,
            repairedAt], maxRows: 0,
        });
        await writeOutbox(transaction, {
          name: "message_sender_repair_outbox_v1",
          outboxId: `message:${spaceId}:${repair.messageId}:${nextVersion}`,
          spaceId,
          topic: "message",
          aggregateKind: "message",
          aggregateId: repair.messageId,
          aggregateSequence: nextVersion,
          payload: item,
          at: repairedAt,
        });
      }
      await transaction.query({
        name: "message_sender_repair_content_revision_v1",
        text: `INSERT INTO data.channel_content_counters
          (space_id, channel_id, content_revision, updated_at) VALUES ($1,$2,$3,$4)
          ON CONFLICT (space_id, channel_id) DO UPDATE SET
            content_revision = data.channel_content_counters.content_revision + EXCLUDED.content_revision,
            updated_at = EXCLUDED.updated_at`,
        values: [spaceId, channelId, repairs.length, repairedAt], maxRows: 0,
      });
      const result = { channelId, repaired, repairedAt };
      await transaction.query({
        name: "message_sender_repair_idempotency_write_v1",
        text: `INSERT INTO data.idempotency_keys
          (space_id, idempotency_key, command_kind, request_digest, result_json,
           commit_sequence, created_at, expires_at)
          VALUES ($1,$2,'message-sender-repair',$3,$4::jsonb,NULL,$5,$6)`,
        values: [spaceId, commandId, requestDigest, JSON.stringify(result), repairedAt,
          new Date(Date.parse(repairedAt) + IDEMPOTENCY_TTL_MS).toISOString()], maxRows: 0,
      });
      return result;
    });
  }

  async acknowledge(input: {
    requestId: string;
    commandId: string;
    requestDigest: string;
    spaceId: string;
    channelId: string;
    principal: MessagePrincipal;
    sequence?: number;
    messageId?: string;
  }): Promise<Record<string, unknown>> {
    const { requestId, spaceId, channelId } = channelRequest(input);
    const commandId = bounded(input.commandId, "commandId");
    const requestDigest = digest(input.requestDigest, "requestDigest");
    const principal = { kind: input.principal.kind, id: bounded(input.principal.id, "principal.id") };
    const messageId = input.messageId === undefined ? undefined : bounded(input.messageId, "messageId");
    if (input.sequence !== undefined && (!Number.isSafeInteger(input.sequence) || input.sequence < 0)) {
      throw new MessageAuthorityError("invalid_command", 400, "sequence is invalid");
    }
    return this.inSpace(requestId, "message.acknowledge", spaceId, async (transaction) => {
      await messageChannelCapability(transaction, { spaceId, channelId, principal },
        "message_viewer_state_update");
      await transaction.query({
        name: "message_ack_idempotency_lock_v1",
        text: `SELECT pg_advisory_xact_lock(
          hashtextextended('message-ack:' || $1::text || ':' || $2::text, 0))`,
        values: [spaceId, commandId], maxRows: 1,
      });
      const replay = await transaction.query<QueryResultRow & {
        command_kind: string; request_digest: string; result_json: Record<string, unknown>;
      }>({
        name: "message_ack_idempotency_read_v1",
        text: `SELECT command_kind, request_digest, result_json FROM data.idempotency_keys
          WHERE space_id = $1 AND idempotency_key = $2 LIMIT 1`,
        values: [spaceId, commandId], maxRows: 1,
      });
      if (replay[0]) {
        if (replay[0].command_kind !== "message-acknowledge" ||
            replay[0].request_digest !== requestDigest) {
          throw new MessageAuthorityError("idempotency_conflict", 409, "Command id was reused");
        }
        return replay[0].result_json;
      }
      const heads = await transaction.query<QueryResultRow & { sequence: string | number }>({
        name: "message_ack_head_v1",
        text: `SELECT COALESCE(MAX(timeline_sequence), 0) AS sequence FROM data.messages
          WHERE space_id = $1 AND channel_id = $2`,
        values: [spaceId, channelId], maxRows: 1,
      });
      const committedSequence = Number(heads[0]?.sequence ?? 0);
      let messageSequence: number | undefined;
      if (messageId !== undefined) {
        const targets = await transaction.query<QueryResultRow & { sequence: string | number }>({
          name: "message_ack_target_v1",
          text: `SELECT timeline_sequence AS sequence FROM data.messages
            WHERE space_id = $1 AND channel_id = $2 AND message_id = $3 LIMIT 1`,
          values: [spaceId, channelId, messageId], maxRows: 1,
        });
        if (!targets[0]) {
          throw new MessageAuthorityError("message_not_found", 404, "Acknowledged message does not exist in this channel");
        }
        messageSequence = Number(targets[0].sequence);
        if (input.sequence !== undefined && input.sequence !== messageSequence) {
          throw new MessageAuthorityError("invalid_command", 400, "sequence does not match messageId");
        }
      }
      const sequence = input.sequence ?? messageSequence ?? committedSequence;
      if (sequence > committedSequence) {
        throw new MessageAuthorityError("ack_ahead_of_commit", 409, "Cursor cannot exceed committed sequence");
      }
      const subjectId = `${principal.kind}:${principal.id}`;
      const cursors = await transaction.query<QueryResultRow & {
        acknowledged_sequence: string | number; version: string | number; updated_at: Date | string;
      }>({
        name: "message_ack_cursor_lock_v1",
        text: `SELECT acknowledged_sequence, version, updated_at FROM data.delivery_cursors
          WHERE space_id = $1 AND subject_id = $2 AND channel_id = $3 FOR UPDATE`,
        values: [spaceId, subjectId, channelId], maxRows: 1,
      });
      const currentSequence = Number(cursors[0]?.acknowledged_sequence ?? 0);
      const ackedSequence = Math.max(currentSequence, sequence);
      const advanced = !cursors[0] || ackedSequence > currentSequence;
      const version = cursors[0] ? Number(cursors[0].version) + (advanced ? 1 : 0) : 1;
      const now = new Date().toISOString();
      await transaction.query({
        name: "message_ack_cursor_write_v1",
        text: `INSERT INTO data.delivery_cursors
          (space_id, subject_id, channel_id, acknowledged_sequence, version, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (space_id, subject_id, channel_id) DO UPDATE SET
            acknowledged_sequence = GREATEST(data.delivery_cursors.acknowledged_sequence,
              EXCLUDED.acknowledged_sequence),
            version = CASE WHEN EXCLUDED.acknowledged_sequence >
              data.delivery_cursors.acknowledged_sequence THEN data.delivery_cursors.version + 1
              ELSE data.delivery_cursors.version END,
            updated_at = CASE WHEN EXCLUDED.acknowledged_sequence >
              data.delivery_cursors.acknowledged_sequence THEN EXCLUDED.updated_at
              ELSE data.delivery_cursors.updated_at END`,
        values: [spaceId, subjectId, channelId, ackedSequence, version, now], maxRows: 0,
      });
      if (advanced) {
        await transaction.query({
          name: "message_ack_attention_revision_v1",
          text: `INSERT INTO data.message_attention_revisions
            (space_id, subject_id, channel_id, revision, updated_at) VALUES ($1,$2,$3,1,$4)
            ON CONFLICT (space_id, subject_id, channel_id) DO UPDATE SET
              revision = data.message_attention_revisions.revision + 1, updated_at = EXCLUDED.updated_at`,
          values: [spaceId, subjectId, channelId, now], maxRows: 0,
        });
      }
      const result = {
        subjectId, channelId, ackedSequence, advanced, committedSequence, version,
        updatedAt: cursors[0] && !advanced ? iso(cursors[0].updated_at) : now,
      };
      await transaction.query({
        name: "message_ack_idempotency_write_v1",
        text: `INSERT INTO data.idempotency_keys
          (space_id, idempotency_key, command_kind, request_digest, result_json,
           commit_sequence, created_at, expires_at)
          VALUES ($1,$2,'message-acknowledge',$3,$4::jsonb,NULL,$5,$6)`,
        values: [spaceId, commandId, requestDigest, JSON.stringify(result), now,
          new Date(Date.parse(now) + IDEMPOTENCY_TTL_MS).toISOString()], maxRows: 0,
      });
      return result;
    });
  }

  async listAnnotations(input: {
    requestId: string;
    spaceId: string;
    channelId: string;
    principal: MessagePrincipal;
    namespace?: string;
    messageId?: string;
    afterCreatedAt?: string;
  }): Promise<{ annotations: Record<string, unknown>[]; cursor: null }> {
    const { requestId, spaceId, channelId, principal } = messageScope(input);
    const namespace = input.namespace ? bounded(input.namespace, "namespace", 160) : null;
    const messageId = input.messageId ? bounded(input.messageId, "messageId") : null;
    const afterCreatedAt = input.afterCreatedAt
      ? timestamp(input.afterCreatedAt, "afterCreatedAt") : null;
    return this.inSpace(requestId, "message.annotations", spaceId, async (transaction) => {
      await messageChannelCapability(transaction, { spaceId, channelId, principal },
        "message_content_read");
      const rows = await transaction.query<QueryResultRow & {
        annotation_id: string; namespace: string; message_id: string | null;
        payload_json: Record<string, unknown>; author_user_id: string; author_label: string;
        version: string | number; created_at: Date | string; updated_at: Date | string;
      }>({
        // Channel-target rows are the retired Channel memory, kept as data
        // only; they are not annotations of a message.
        name: "message_annotations_list_v2",
        text: `SELECT annotation_id, namespace, message_id, payload_json, author_user_id,
            author_label, version, created_at, updated_at FROM data.message_annotations
          WHERE space_id = $1 AND channel_id = $2 AND target_kind <> 'channel'
            AND ($3::text IS NULL OR namespace = $3)
            AND ($4::text IS NULL OR message_id = $4)
            AND ($5::timestamptz IS NULL OR created_at > $5)
          ORDER BY created_at, annotation_id LIMIT 200`,
        values: [spaceId, channelId, namespace, messageId, afterCreatedAt], maxRows: 200,
      });
      return {
        annotations: rows.map((row) => ({
          id: row.annotation_id,
          namespace: row.namespace,
          target: { kind: "message", messageId: row.message_id },
          authorUserId: row.author_user_id,
          authorLabel: row.author_label,
          payload: row.payload_json,
          version: Number(row.version),
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        })),
        cursor: null,
      };
    });
  }

  async attachmentAuthority(input: {
    requestId: string;
    spaceId: string;
    channelId: string;
    messageId: string;
    attachmentId: string;
    principal: MessagePrincipal;
    placement?: PostgresMessagePlacement;
  }): Promise<Record<string, unknown>> {
    const { requestId, spaceId, channelId, principal, messageId } = messageIdentity(input);
    const attachmentId = bounded(input.attachmentId, "attachmentId");
    return this.inSpace(requestId, "message.attachment-authority", spaceId, async (transaction) => {
      const accessChannel = await messageChannelCapability(
        transaction, { spaceId, channelId, principal }, "message_content_read",
      );
      const rows = await transaction.query<QueryResultRow & {
        source_channel_id: string; source_mode: string; object_key: string; content_hash: string;
        encoded_bytes: string | number; mime_type: string; name: string;
        presentation_residual_json: Record<string, unknown> | null; version: string | number;
      }>({
        name: "message_attachment_authority_v1",
        text: `SELECT a.channel_id AS source_channel_id, c.mode AS source_mode, a.object_key,
            a.content_hash, a.encoded_bytes, a.mime_type, a.name,
            a.presentation_residual_json, a.version
          FROM data.message_attachment_refs a JOIN data.messages m
            ON m.space_id = a.space_id AND m.message_id = a.message_id
          JOIN data.channels c ON c.space_id = a.space_id AND c.channel_id = a.channel_id
          WHERE a.space_id = $1 AND a.message_id = $2 AND a.attachment_id = $3
            AND m.deleted_at IS NULL AND m.recalled_at IS NULL LIMIT 1`,
        values: [spaceId, messageId, attachmentId], maxRows: 1,
      });
      const row = rows[0];
      if (!row) throw new MessageAuthorityError(
        "message_attachment_not_found", 404, "Message attachment is not available",
      );
      if (row.source_channel_id !== channelId) {
        const metadata = accessChannel.metadata ?? {};
        if (metadata.kind !== "thread" || metadata.threadRootMessageId !== messageId ||
            metadata.threadRootChannelId !== row.source_channel_id) {
          throw new MessageAuthorityError(
            "message_attachment_not_found", 404, "Message attachment is not available",
          );
        }
      }
      const encodedBytes = Number(row.encoded_bytes);
      const version = Number(row.version);
      if (row.object_key !== `objects/${row.content_hash}` ||
          !/^[a-f0-9]{64}$/u.test(row.content_hash) || !Number.isSafeInteger(encodedBytes) ||
          encodedBytes < 1 || !Number.isSafeInteger(version) || version < 1) {
        throw new MessageAuthorityError(
          "postgres_fact_invalid", 500, "Message attachment authority is corrupt",
        );
      }
      return {
        channelId,
        messageId,
        visibilityScopeId: channelVisibilityScope({ mode: row.source_mode, channelId: row.source_channel_id, spaceId: spaceId }),
        attachment: {
          id: attachmentId, name: row.name, mimeType: row.mime_type,
          size: encodedBytes, version, ...row.presentation_residual_json,
        },
        object: {
          objectKey: row.object_key, contentHash: row.content_hash,
          encodedBytes, checksum: row.content_hash,
        },
      };
    }, input.placement);
  }

  async liveDeliveryRouting(input: {
    requestId: string;
    spaceId: string;
    channelId: string;
    messageId: string;
  }): Promise<{
    recipientUserIds: string[];
    recipientNotifications: Record<string, unknown>[];
  }> {
    const { requestId, spaceId, channelId } = channelRequest(input);
    const messageId = bounded(input.messageId, "messageId");
    return this.inSpace(requestId, "message.live-routing", spaceId, async (transaction) => {
      const messages = await transaction.query<QueryResultRow & {
        author_kind: string; author_id: string; metadata_json: Record<string, unknown> | null;
      }>({
        name: "message_live_routing_source_v1",
        text: `SELECT m.author_kind, m.author_id, c.metadata_json FROM data.messages m
          JOIN data.channels c ON c.space_id = m.space_id AND c.channel_id = m.channel_id
          WHERE m.space_id = $1 AND m.channel_id = $2 AND m.message_id = $3
            AND m.deleted_at IS NULL LIMIT 1`,
        values: [spaceId, channelId, messageId], maxRows: 1,
      });
      if (!messages[0]) throw new MessageAuthorityError("message_not_found", 404, "Message not found");
      const recipientUserIds = await liveRecipientUserIds(transaction, spaceId, channelId);
      const recipientSet = new Set(recipientUserIds);
      const attention = await transaction.query<QueryResultRow & {
        subject_id: string; kind: string;
      }>({
        name: "message_live_routing_attention_v1",
        text: `SELECT subject_id, kind FROM data.message_attention WHERE space_id = $1
          AND channel_id = $2 AND message_id = $3 AND subject_id LIKE 'user:%'
          ORDER BY subject_id LIMIT 10000`,
        values: [spaceId, channelId, messageId], maxRows: 10_000,
      });
      const notifications = new Map<string, Record<string, unknown>>();
      const notified = attention.filter(row => recipientSet.has(row.subject_id.slice("user:".length)));
      // A mention notification carries the recipient's unread attention summary
      // (everything after their acknowledged cursor), exactly as a later catalog
      // read would report it; without it the client cannot badge the Channel.
      const summaries = new Map((notified.length ? await transaction.query<QueryResultRow & {
        subject_id: string; unread_count: string | number; message_id: string; kind: string;
        timeline_sequence: string | number; created_at: Date | string; kinds: string[];
      }>({
        name: "message_live_routing_attention_summary_v1",
        text: `SELECT subject.subject_id,COUNT(*) AS unread_count,
            (ARRAY_AGG(a.message_id ORDER BY a.timeline_sequence DESC))[1] AS message_id,
            (ARRAY_AGG(a.kind ORDER BY a.timeline_sequence DESC))[1] AS kind,
            MAX(a.timeline_sequence) AS timeline_sequence,
            (ARRAY_AGG(a.created_at ORDER BY a.timeline_sequence DESC))[1] AS created_at,
            ARRAY_AGG(DISTINCT a.kind) AS kinds
          FROM unnest($3::text[]) subject(subject_id)
          JOIN data.message_attention a ON a.space_id=$1 AND a.channel_id=$2 AND a.subject_id=subject.subject_id
          WHERE a.timeline_sequence>COALESCE((SELECT acknowledged_sequence FROM data.delivery_cursors cursor_row
            WHERE cursor_row.space_id=$1 AND cursor_row.channel_id=$2 AND cursor_row.subject_id=subject.subject_id), 0)
          GROUP BY subject.subject_id`,
        values: [spaceId, channelId, notified.map(row => row.subject_id)], maxRows: notified.length,
      }) : []).map(row => {
        const at = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
        return [row.subject_id, { channelId, unreadAttentionCount: Number(row.unread_count), lastAttentionAt: at,
          lastMessageId: row.message_id, lastMessageSequence: Number(row.timeline_sequence),
          primaryTriggerKind: row.kind,
          triggerKinds: ["broadcast", "mention", "reply"].filter(kind => row.kinds.includes(kind)), updatedAt: at }];
      }));
      for (const row of notified) {
        const attentionSummary = summaries.get(row.subject_id);
        notifications.set(row.subject_id.slice("user:".length), { userId: row.subject_id.slice("user:".length),
          notification: { reason: row.kind, ...(attentionSummary ? { attention: attentionSummary } : {}) } });
      }
      return { recipientUserIds, recipientNotifications: [...notifications.values()] };
    });
  }

  async liveRecipientUserIds(input: {
    requestId: string;
    spaceId: string;
    channelId: string;
  }): Promise<string[]> {
    const { requestId, spaceId, channelId } = channelRequest(input);
    return this.inSpace(requestId, "message.live-recipients", spaceId, (transaction) => liveRecipientUserIds(transaction, spaceId, channelId));
  }

  /**
   * The newest live messages, across every Channel of the Space the reader may
   * read, strictly older than a search rank. Search matches decoded bodies in
   * the Hub; this read only bounds and authorizes the candidates.
   */
  async searchCandidates(input: MessageSearchCandidatesInput): Promise<MessageSearchCandidate[]> {
    if (input.principal.kind !== "user" && input.principal.kind !== "agent") {
      throw new MessageAuthorityError("invalid_principal", 400, "principal is invalid");
    }
    const spaceId = bounded(input.spaceId, "spaceId");
    const principalId = bounded(input.principal.id, "principal.id");
    const limit = input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_CANDIDATE_PAGE) {
      throw new MessageAuthorityError("invalid_request", 400, "Search candidate limit is invalid");
    }
    const beforeRank = input.beforeRank === undefined ? null : bounded(input.beforeRank, "beforeRank");
    const placement = await this.placement(input.requestId, "message.search", spaceId);
    const rows = await this.database.transaction({
      requestId: input.requestId, operation: "message.search", statement: "single_read",
      placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
    }, (transaction) => transaction.query<QueryResultRow>({
      name: "message_search_candidates_v2",
      text: `WITH readable AS MATERIALIZED (
          SELECT c.channel_id FROM data.channels c
          WHERE c.space_id=$1 AND ${channelCapabilityPredicate({ capability: "message_content_read",
            channelAlias: "c", principalKindSql: "$2::text", principalIdSql: "$3::text" })}
        )
        SELECT m.message_id,m.channel_id,m.timeline_sequence,m.entity_version,m.search_rank_sequence,
          m.author_kind,m.author_id,m.payload_bundle_base64,m.legacy_body,m.attachments_json,m.sent_at
        FROM data.messages m
        WHERE m.space_id=$1 AND m.channel_id IN (SELECT channel_id FROM readable)
          AND m.deleted_at IS NULL AND m.recalled_at IS NULL
          AND ($4::text IS NULL OR m.search_rank_sequence < $4)
        ORDER BY m.search_rank_sequence DESC LIMIT $5`,
      values: [spaceId, input.principal.kind, principalId, beforeRank, limit],
      maxRows: limit,
    }));
    return rows.map((row) => ({
      messageId: String(row.message_id),
      channelId: String(row.channel_id),
      timelineSequence: Number(row.timeline_sequence),
      entityVersion: Number(row.entity_version),
      searchRankSequence: String(row.search_rank_sequence),
      authorKind: String(row.author_kind),
      authorId: String(row.author_id),
      payloadBundleBase64: typeof row.payload_bundle_base64 === "string" ? row.payload_bundle_base64 : null,
      legacyBody: typeof row.legacy_body === "string" ? row.legacy_body : null,
      attachmentNames: attachmentNamesOf(row.attachments_json),
      sentAt: new Date(row.sent_at as string).toISOString(),
    }));
  }

  async history(input: MessageHistoryInput): Promise<MessageHistoryPage> {
    if (this.ownsRequestSession) return this.historyInSession(input);
    const session = this.database.openSession();
    try {
      return await new PostgresMessageRepository(session, true).historyInSession(input);
    } finally {
      await session.close();
    }
  }

  /**
   * One history page in one fenced statement: the Space placement fence, the
   * reader's Channel capability, the bounded page, its authorized Thread
   * summaries and the Channel's head counters, all from one snapshot. Only a
   * page that still carries legacy attachment edges or tombstoned authors
   * needs a further read, fenced the same way.
   */
  private async historyInSession(input: MessageHistoryInput): Promise<MessageHistoryPage> {
    const { requestId, spaceId, channelId, principal } = messageScope(input);
    const limit = Math.min(input.limit ?? 50, MAX_HISTORY_PAGE);
    const selectedBounds = [input.before, input.beforeSequence, input.afterSequence]
      .filter((value) => value !== undefined).length;
    if (!Number.isSafeInteger(limit) || limit < 1 || selectedBounds > 1) {
      throw new MessageAuthorityError("invalid_request", 400, "History bounds are invalid");
    }
    const beforeTime = input.before === undefined ? null : new Date(input.before);
    if (beforeTime && !Number.isFinite(beforeTime.getTime())) {
      throw new MessageAuthorityError("invalid_request", 400, "History before timestamp is invalid");
    }
    const before = input.beforeSequence === undefined ? null : positive(input.beforeSequence, "beforeSequence");
    const after = input.afterSequence === undefined
      ? null
      : nonnegative(input.afterSequence, "afterSequence");
    const placement = input.resolvedPlacement
      ? activeMessagePlacement(spaceId, input.resolvedPlacement)
      : await this.placement(requestId, "message.history", spaceId);
    const read = <T>(callback: (transaction: DatabaseTransaction) => Promise<T>) =>
      this.database.transaction({
        requestId, operation: "message.history", statement: "single_read",
        placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
      }, callback);
    const direction = after === null ? "DESC" : "ASC";
    const rows = await read((transaction) => transaction.query<HistoryPageRow>({
      name: "message_history_page_v3",
      // A Channel About session reads the history of the Channel it summarizes.
      text: `WITH history_input AS (
          SELECT $1::text AS space_id,$2::text AS channel_id,
            $7::text AS principal_kind,$8::text AS principal_id
        ), ${channelCapabilityCte({ capability: "message_content_read", inputCte: "history_input",
          channelAboutSessionRead: true })},
        history_page AS MATERIALIZED (
          SELECT message_id, channel_id, timeline_sequence, entity_version, author_kind,
            author_id, message_kind, content_hash, payload_kind, payload_ref, reactions_json,
            annotations_json, attachments_json, sent_at, edited_at, recalled_at, deleted_at,
            updated_at, search_rank_sequence, codec_id, payload_schema_version,
            field_presence_base64, payload_bundle_base64, body_hash, sender_snapshot_digest,
            record_digest, record_encoded_bytes
          FROM data.messages
          WHERE EXISTS (SELECT 1 FROM authorized_channel)
            AND space_id = $1 AND channel_id = $2 AND deleted_at IS NULL
            AND ($3::bigint IS NULL OR timeline_sequence < $3)
            AND ($4::bigint IS NULL OR timeline_sequence > $4)
            AND ($5::timestamptz IS NULL OR sent_at < $5)
          ORDER BY timeline_sequence ${direction} LIMIT $6
        ), thread_candidates AS MATERIALIZED (
          SELECT DISTINCT ON (c.metadata_json->>'threadRootMessageId')
            c.metadata_json->>'threadRootMessageId' AS root_message_id,
            c.metadata_json->>'threadRootCopyMessageId' AS root_copy_message_id,
            c.channel_id AS thread_channel_id,
            GREATEST(c.updated_at,COALESCE(c.activity_at,c.updated_at)) AS thread_updated_at
          FROM data.channels c
          WHERE c.space_id=$1 AND c.metadata_json->>'threadRootChannelId'=$2
            AND c.metadata_json->>'kind'='thread'
            AND c.metadata_json->>'threadRootMessageId' IN (
              SELECT shown.message_id FROM history_page shown
              ORDER BY shown.timeline_sequence ${direction} LIMIT $9)
            AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
              principalKindSql: "$7::text", principalIdSql: "$8::text" })}
          ORDER BY c.metadata_json->>'threadRootMessageId',
            c.updated_at DESC,c.channel_id
        ), thread_summaries AS MATERIALIZED (
          -- PostgreSQL 17 inlines an unmarked CTE and would repeat this reply
          -- count once per history row. The count itself stays the same.
          SELECT thread.root_message_id,thread.thread_channel_id,thread.thread_updated_at,
            (SELECT COUNT(*) FROM data.messages reply
              WHERE reply.space_id=$1 AND reply.channel_id=thread.thread_channel_id
                AND reply.deleted_at IS NULL
                AND reply.message_id<>COALESCE(thread.root_copy_message_id,'')
                AND reply.message_id<>thread.root_message_id) AS reply_count,
            COALESCE(preview.reply_rows,'[]'::jsonb) AS reply_rows
          FROM thread_candidates thread
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(to_jsonb(reply_row) ORDER BY reply_row.timeline_sequence) AS reply_rows
            FROM (SELECT reply.* FROM data.messages reply
              WHERE reply.space_id=$1 AND reply.channel_id=thread.thread_channel_id
                AND reply.deleted_at IS NULL
                AND reply.message_id<>COALESCE(thread.root_copy_message_id,'')
                AND reply.message_id<>thread.root_message_id
              ORDER BY reply.timeline_sequence DESC LIMIT 2) reply_row
          ) preview ON TRUE
        ), history_metadata AS MATERIALIZED (
          SELECT COALESCE(granted.authorized, FALSE) AS history_authorized,
            context.name AS channel_name,context.metadata_json AS channel_metadata,
            context.updated_at AS channel_updated_at,
            (SELECT run_id FROM data.runs WHERE $7='agent' AND run_id=$8 AND channel_id=$2
              AND metadata_json->>'routedAs'='management_channel_about' AND granted.authorized) AS about_run_id,
            CASE WHEN granted.authorized THEN COALESCE((SELECT acknowledged_sequence
              FROM data.delivery_cursors
              WHERE space_id=$1 AND channel_id=$2 AND subject_id=$10 LIMIT 1), 0) END
              AS acknowledged_sequence,
            CASE WHEN granted.authorized THEN COALESCE((SELECT content_revision
              FROM data.channel_content_counters
              WHERE space_id = $1 AND channel_id = $2 LIMIT 1), 0) END AS content_revision,
            CASE WHEN granted.authorized THEN COALESCE((SELECT MAX(timeline_sequence)
              FROM data.messages WHERE space_id = $1 AND channel_id = $2), 0) END
              AS history_head_sequence
          FROM (SELECT 1) one LEFT JOIN authorized_channel granted ON TRUE
          LEFT JOIN data.channels context ON context.space_id=$1 AND context.channel_id=$2 AND granted.authorized
        )
        SELECT meta.history_authorized,meta.acknowledged_sequence,meta.content_revision,
          meta.history_head_sequence,meta.channel_name,meta.channel_metadata,meta.channel_updated_at,meta.about_run_id,
          page.*,thread.thread_channel_id,thread.thread_updated_at,
          thread.reply_count,thread.reply_rows
        FROM history_metadata meta
        LEFT JOIN history_page page ON meta.history_authorized
        LEFT JOIN thread_summaries thread ON thread.root_message_id=page.message_id
        ORDER BY page.timeline_sequence ${direction}`,
      values: [spaceId, channelId, before, after, beforeTime?.toISOString() ?? null, limit + 1,
        principal.kind, principal.id, limit, `${principal.kind}:${principal.id}`],
      maxRows: limit + 1,
    }));
    const head = rows[0];
    requireAuthorizedChannel(head?.history_authorized, messageCapabilityError);
    const pageRows = rows.filter((row): row is HistoryPageRow & MessageRow => row.message_id !== null);
    const page = pageRows.slice(0, limit);
    if (after === null) page.reverse();
    const threadRows: ThreadSummaryRow[] = page.flatMap((row) => row.thread_channel_id === null ? [] : [{
      root_message_id: row.message_id,
      thread_channel_id: row.thread_channel_id,
      thread_updated_at: row.thread_updated_at ?? "",
      reply_count: row.reply_count ?? 0,
      reply_rows: row.reply_rows ?? [],
    }]);
    // Each follow-up queries only when the page needs it; otherwise it is no round trip.
    await read((transaction) => hydrateHistoryAttachmentVersions(transaction, spaceId, channelId, page));
    await read((transaction) => hydrateTombstoneSenders(transaction, spaceId,
      [...page, ...threadRows.flatMap((row) => row.reply_rows)]));
    const threadSummaries = new Map(threadRows.map((row) => [
      row.root_message_id, serializeThreadSummary(row),
    ]));
    const aboutInput = head?.about_run_id ? await this.database.transaction({
      requestId, operation: "message.history.about-input",
      placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
    }, (tx) => recordAboutInput(tx, {
      channel: { space_id: spaceId, channel_id: channelId, name: head.channel_name!,
        metadata_json: head.channel_metadata!, updated_at: head.channel_updated_at! },
      runId: head.about_run_id!, contentRevision: Number(head.content_revision),
      references: page.map((row) => ({ messageId: row.message_id, channelId: row.channel_id,
        sequence: Number(row.timeline_sequence), entityVersion: Number(row.entity_version),
        contentHash: row.content_hash, payloadKind: row.payload_kind, payloadRef: row.payload_ref,
        recordDigest: row.record_digest, bodyHash: row.body_hash,
        // Bundled records are stored inline rather than in a separately fetchable object.
        ...(row.payload_bundle_base64 ? { payloadBundleBase64: row.payload_bundle_base64,
          codecId: row.codec_id, payloadSchemaVersion: row.payload_schema_version } : {}) })),
    })) : undefined;
    return {
      ...(aboutInput ? { aboutInput } : {}),
      messages: page.map((row) => {
        const message = serializeMessage(row);
        const threadSummary = threadSummaries.get(row.message_id);
        return threadSummary ? { ...message, threadSummary } : message;
      }),
      hasMore: pageRows.length > limit,
      principalAckedSequence: Number(head?.acknowledged_sequence ?? 0),
      contentRevision: Number(head?.content_revision ?? 0),
      historyHeadSequence: Number(head?.history_head_sequence ?? 0),
    };
  }
}

/** Who answered a link, as the committed reply shows them. The relay into the
 *  link's Channel is written under the link owner's authority, so it carries
 *  the replier's name and face, never their identity. An Agent replier also
 *  names its exact Instance, so live delivery of the relay can skip it: an
 *  Instance answering its own link must not get its answer back as a turn. */
function replierPresentation(snapshot: Record<string, unknown>): {
  kind: "user" | "agent"; label: string; avatarUrl?: string; agentId?: string; instanceId?: string;
} {
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
  const agent = snapshot.kind === "agent";
  return {
    kind: agent ? "agent" : "user",
    label: text(snapshot.label) ?? text(snapshot.name) ?? text(snapshot.agentName) ?? "Someone",
    ...(text(snapshot.avatarUrl) ? { avatarUrl: text(snapshot.avatarUrl) } : {}),
    ...(agent && text(snapshot.agentId) && text(snapshot.instanceId)
      ? { agentId: text(snapshot.agentId), instanceId: text(snapshot.instanceId) } : {}),
  };
}
