import { ControlError } from "./control-error.js";
import { storedIso } from "./stored-values.js";
import { requireAgentChannelAccess, type AgentChannelRunProof } from "./agent-channel-access.js";
import { initialMessageSource } from "./runtime-initial-input.js";
import {
  channelVisibilityScope,
  immutableContentObjectKey, parseRestrictedChannelContentScope, restrictedChannelContentScope,
  uploadScopeCoversRefScope } from "@xmatrix/protocol";
import { commandDigest as digest, commandJson as stable } from "./command-digest.js";
import type { QueryResultRow } from "pg";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { writeOutbox } from "./outbox.js";
import { advanceSpaceControlHead } from "./space-control-head.js";
import {
  requireChannelCapability,
  type ChannelCapability,
  type ChannelCapabilityFailure,
} from "./channel-capability-policy.js";
import { PostgresEntitySpaceDirectory, type EntitySpaceRouteKind } from "./entity-directory.js";
import {
  PostgresChannelSpaceDirectory,
  WritableSpacePlacements,
  type SpacePlacement,
} from "./placement.js";
import { commandFields } from "./command-fields.js";
import { readSpaceCommandReplay, storeSpaceCommandReplay } from "./command-replay.js";


const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_INTENT_TTL_MS = 24 * 60 * 60 * 1_000;
const GC_SAFETY_MS = 31 * 24 * 60 * 60 * 1_000;
const DECISION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const EMPTY_CHILDREN_DIGEST = "724809a3b6b987bfe99046f9337504fc07d77ab9b4e889f2b3f828fd05c76177";

export type ContentPrincipal = { kind: "user" | "agent"; id: string };

export class ContentControlError extends ControlError {
  override name = "ContentControlError";
}

function channelCapabilityError(failure: ChannelCapabilityFailure): ContentControlError {
  return new ContentControlError(failure.code, failure.status, failure.message);
}

const { text } = commandFields((field) =>
  new ContentControlError("invalid_command", 400, `${field} is invalid`));

function hash(value: string, field: string): string {
  const result = text(value, field, 64);
  if (!/^[0-9a-f]{64}$/u.test(result)) {
    throw new ContentControlError("invalid_command", 400, `${field} is invalid`);
  }
  return result;
}

function positive(value: number, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ContentControlError("invalid_command", 400, `${field} is invalid`);
  }
  return value;
}

function command(input: { requestId: string; commandId: string }) {
  return { requestId: text(input.requestId, "requestId", 200), commandId: text(input.commandId, "commandId") };
}

function spaceRequest(input: { requestId: string; spaceId: string }) {
  return { requestId: text(input.requestId, "requestId", 200), spaceId: text(input.spaceId, "spaceId") };
}

/** A bounded maintenance pass over rows older than `retentionMs`. */
function maintenancePass(input: { requestId: string; spaceId: string; limit?: number }, retentionMs: number) {
  const now = new Date().toISOString();
  return { ...spaceRequest(input), limit: positive(input.limit ?? 50, "limit", 100), now,
    cutoff: new Date(Date.parse(now) - retentionMs).toISOString() };
}

function serializeIntent(row: QueryResultRow): Record<string, unknown> {
  return {
    intentId: row.intent_id, scopeId: row.scope_id, contentHash: row.content_hash,
    objectKey: row.object_key, encodedBytes: Number(row.encoded_bytes), checksum: row.checksum,
    state: row.status, version: Number(row.version), createdAt: storedIso(row.created_at),
    expiresAt: storedIso(row.expires_at),
  };
}

function serializeRef(row: QueryResultRow): Record<string, unknown> {
  return {
    refId: row.ref_id, scopeId: row.root_set_id, ownerKind: row.owner_kind,
    ownerId: row.owner_id, contentHash: row.checksum, objectKey: row.storage_key,
    encodedBytes: Number(row.byte_length), checksum: row.checksum, version: 1,
    createdAt: storedIso(row.created_at),
  };
}

export class PostgresContentRepository {
  private readonly spaces: WritableSpacePlacements;
  private readonly channelDirectory: PostgresChannelSpaceDirectory;
  private readonly entityDirectory: PostgresEntitySpaceDirectory;

  constructor(private readonly database: AuthorityDatabase, shardId: string) {
    if (database.cacheMode !== "disabled") throw new ContentControlError(
      "cached_authority_forbidden", 500, "Content authority requires uncached PostgreSQL",
    );
    text(shardId, "shardId");
    this.spaces = new WritableSpacePlacements(database, () =>
      new ContentControlError("space_placement_unavailable", 503, "Space placement is unavailable", true));
    this.channelDirectory = new PostgresChannelSpaceDirectory(database);
    this.entityDirectory = new PostgresEntitySpaceDirectory(database);
  }

  private async resolveScope(requestId: string, scopeId: string): Promise<{
    spaceId: string; channelId: string | null; readerUserId?: string;
  }> {
    let restricted: ReturnType<typeof parseRestrictedChannelContentScope>;
    try { restricted = parseRestrictedChannelContentScope(text(scopeId, "scopeId")); }
    catch { throw new ContentControlError("invalid_command", 400, "scopeId is invalid"); }
    if (restricted) {
      const route = await this.channelDirectory.resolve(
        { requestId, operation: "content.scope.resolve" }, restricted.channelId);
      if (!route) throw new ContentControlError("not_found", 404, "Content scope is unavailable");
      return { spaceId: route.spaceId, ...restricted };
    }
    const match = /^(space|channel):(.+)$/u.exec(text(scopeId, "scopeId"));
    if (!match) throw new ContentControlError("invalid_command", 400, "scopeId is invalid");
    if (match[1] === "space") return { spaceId: match[2]!, channelId: null };
    const route = await this.channelDirectory.resolve(
      { requestId, operation: "content.scope.resolve" }, match[2]!,
    );
    if (!route) throw new ContentControlError("not_found", 404, "Content scope is unavailable");
    return { spaceId: route.spaceId, channelId: match[2]! };
  }

  private async publishEntityRoute(
    requestId: string,
    placement: SpacePlacement,
    kind: EntitySpaceRouteKind,
    entityId: string,
    state: "active" | "deleted",
    entityVersion: number,
  ): Promise<void> {
    const rows = await this.database.transaction({
      requestId,
      operation: `${kind}.directory-source`,
      placement: { spaceId: placement.spaceId, shardId: placement.shardId,
        placementEpoch: placement.placementEpoch },
    }, (tx) => tx.query<QueryResultRow & { route_version: string | number; updated_at: string }>({
      name: "content_entity_route_source_v1",
      text: `SELECT commit_sequence AS route_version,updated_at
        FROM data.space_control_heads WHERE space_id = $1 LIMIT 1`,
      values: [placement.spaceId], maxRows: 1,
    }));
    if (!rows[0]) throw new ContentControlError(
      "entity_directory_source_incomplete", 503, "Content directory source is incomplete", true,
    );
    await this.entityDirectory.publish({
      requestId, operation: `${kind}.directory-publish`,
    }, {
      kind, entityId, spaceId: placement.spaceId, shardId: placement.shardId,
      placementEpoch: placement.placementEpoch, entityVersion,
      routeVersion: Number(rows[0].route_version), state, updatedAt: rows[0].updated_at,
    });
  }

  private async lockRestrictedObject(tx: DatabaseTransaction, spaceId: string, objectKey: string): Promise<void> {
    await tx.query({ name: "content_restricted_object_fence_v1",
      text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      values: [JSON.stringify([spaceId, objectKey])], maxRows: 1 });
  }

  private async requireUncollectedObject(tx: DatabaseTransaction, spaceId: string, objectKey: string): Promise<void> {
    await this.lockRestrictedObject(tx, spaceId, objectKey);
    const retired = await tx.query({ name: "content_restricted_retirement_v1",
      text: `SELECT object_id FROM data.content_gc_candidates WHERE space_id=$1 AND storage_key=$2
        AND reason IN ('decision-expired','decision-upload-expired') AND status IN ('leased','deleted','failed') LIMIT 1`,
      values: [spaceId, objectKey], maxRows: 1 });
    if (retired.length) throw new ContentControlError("content_object_retired", 409, "Content object was retired");
  }

  private async authorize(
    tx: DatabaseTransaction,
    scope: { spaceId: string; channelId: string | null; readerUserId?: string },
    principal: ContentPrincipal,
    capability: Extract<ChannelCapability,
      "content_history_read" | "content_new_work" | "content_terminalize">,
  ): Promise<void> {
    if (scope.readerUserId && (principal.kind !== "user" || principal.id !== scope.readerUserId)) {
      throw new ContentControlError("forbidden", 403, "Content scope access denied");
    }
    if (scope.channelId) {
      await requireChannelCapability(tx, { capability, channelId: scope.channelId,
        spaceId: scope.spaceId, principal, error: channelCapabilityError });
      return;
    }
    if (principal.kind === "user") {
      const rows = await tx.query<QueryResultRow & { role: string }>({
        name: "content_authorize_user_v2",
        text: "SELECT role FROM data.space_members WHERE space_id=$1 AND user_id=$2 LIMIT 1",
        values: [scope.spaceId, principal.id], maxRows: 1,
      });
      if (!rows[0]) throw new ContentControlError("forbidden", 403, "Content scope access denied");
      return;
    }
    const rows = await tx.query({
      name: "content_authorize_agent_v3",
      text: `SELECT instance.instance_id FROM data.instances instance
        JOIN data.run_agent_registrations binding ON binding.run_id = instance.run_id
        WHERE binding.space_id = $1 AND instance.instance_id = $2 LIMIT 1`,
      values: [scope.spaceId, principal.id], maxRows: 1,
    });
    if (!rows[0]) throw new ContentControlError("forbidden", 403, "Content scope access denied");
  }

  private replay(
    tx: DatabaseTransaction, spaceId: string, commandId: string, kind: string, requestDigest: string,
  ): Promise<Record<string, unknown> | null> {
    return readSpaceCommandReplay(tx, "content_idempotency_read_v1",
      { spaceId, commandId, commandKind: kind, requestDigest },
      () => new ContentControlError("idempotency_conflict", 409, "command id was reused"));
  }

  private async commit(
    tx: DatabaseTransaction,
    input: { spaceId: string; commandId: string; kind: string; requestDigest: string;
      aggregateId: string; result: Record<string, unknown>; now: string },
  ): Promise<void> {
    const sequence = await advanceSpaceControlHead(tx, {
      name: "content_head_advance_v1", spaceId: input.spaceId, at: input.now,
    });
    if (sequence === undefined) throw new ContentControlError(
      "space_control_head_missing", 500, "Space control head is unavailable",
    );
    await writeOutbox(tx, {
      name: "content_outbox_v1",
      outboxId: `content:${input.spaceId}:${sequence}`,
      spaceId: input.spaceId,
      topic: "content",
      aggregateKind: "content",
      aggregateId: input.aggregateId,
      aggregateSequence: sequence,
      payload: input.result,
      at: input.now,
    });
    await storeSpaceCommandReplay(tx, "content_idempotency_write_v1", { ...input, commandKind: input.kind,
      commitSequence: sequence, at: input.now, ttlMs: IDEMPOTENCY_TTL_MS });
  }

  async createIntent(input: {
    requestId: string; commandId: string; intentId: string; scopeId: string;
    contentHash: string; encodedBytes: number; expiresAt: string; principal: ContentPrincipal; purpose?: "summon_decision";
  }): Promise<Record<string, unknown>> {
    const { requestId, commandId } = command(input);
    const intentId = text(input.intentId, "intentId");
    const scopeId = text(input.scopeId, "scopeId");
    const contentHash = hash(input.contentHash, "contentHash");
    const encodedBytes = positive(input.encodedBytes, "encodedBytes", MAX_BLOB_BYTES);
    const expiresAt = new Date(input.expiresAt).toISOString();
    const now = new Date().toISOString();
    if (Date.parse(expiresAt) <= Date.parse(now) ||
        Date.parse(expiresAt) > Date.parse(now) + MAX_INTENT_TTL_MS) {
      throw new ContentControlError("invalid_blob_intent", 400, "blob expiry is invalid");
    }
    const scope = await this.resolveScope(requestId, scopeId);
    if (input.purpose !== undefined && (input.purpose !== "summon_decision" || !scope.readerUserId)) {
      throw new ContentControlError("invalid_decision_scope", 400, "Decision upload requires a restricted scope");
    }
    const requestDigest = await digest(input);
    const placement = await this.spaces.resolve(requestId, "content.intent.create", scope.spaceId);
    const result = await this.spaces.transaction(requestId, "content.intent.create", placement, async (tx) => {
      if (scope.readerUserId) {
        await this.authorize(tx, scope, input.principal, "content_new_work");
        await this.requireUncollectedObject(tx, scope.spaceId, immutableContentObjectKey(scopeId, contentHash));
      }
      const prior = await this.replay(
        tx, scope.spaceId, commandId, "create-blob-intent", requestDigest,
      );
      if (prior) return prior;
      await this.authorize(tx, scope, input.principal, "content_new_work");
      const objectKey = immutableContentObjectKey(scopeId, contentHash);
      const existing = await tx.query<QueryResultRow>({
        name: "content_intent_existing_v1",
        text: "SELECT * FROM data.blob_upload_intents WHERE intent_id = $1 FOR UPDATE",
        values: [intentId], maxRows: 1,
      });
      let result: Record<string, unknown>;
      if (existing[0]) {
        const row = existing[0];
        if (row.space_id !== scope.spaceId || row.scope_id !== scopeId ||
            row.content_hash !== contentHash || row.object_key !== objectKey ||
            (row.purpose ?? undefined) !== input.purpose || Number(row.encoded_bytes) !== encodedBytes || row.status !== "pending" ||
            new Date(row.expires_at as Date | string).toISOString() !== expiresAt) {
          throw new ContentControlError(
            "blob_intent_conflict", 409, "intentId was reused with another payload",
          );
        }
        result = serializeIntent(row);
      } else {
        await tx.query({
          name: "content_intent_gc_cancel_v1",
          text: "DELETE FROM data.content_gc_candidates WHERE space_id = $1 AND storage_key = $2",
          values: [scope.spaceId, objectKey], maxRows: 0,
        });
        await tx.query({
          name: "content_intent_insert_v1",
          text: `INSERT INTO data.blob_upload_intents
            (space_id,intent_id,scope_id,content_hash,object_key,encoded_bytes,checksum,
             status,version,created_at,expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,$4,'pending',1,$7,$8)`,
          values: [scope.spaceId, intentId, scopeId, contentHash, objectKey,
            encodedBytes, now, expiresAt], maxRows: 0,
        });
        if (input.purpose) await tx.query({ name: "content_decision_intent_mark_v1",
          text: "UPDATE data.blob_upload_intents SET purpose='summon_decision' WHERE space_id=$1 AND intent_id=$2",
          values: [scope.spaceId, intentId], maxRows: 0 });
        result = { intentId, scopeId, contentHash, objectKey, encodedBytes,
          checksum: contentHash, state: "pending", version: 1, createdAt: now, expiresAt };
      }
      await this.commit(tx, { spaceId: scope.spaceId, commandId, kind: "create-blob-intent",
        requestDigest, aggregateId: intentId, result, now });
      return result;
    });
    await this.publishEntityRoute(
      requestId, placement, "content-intent", intentId, "active", Number(result.version ?? 1),
    );
    return result;
  }

  async readIntent(input: {
    requestId: string; intentId: string; principal: ContentPrincipal;
  }): Promise<Record<string, unknown>> {
    const requestId = text(input.requestId, "requestId", 200);
    const intentId = text(input.intentId, "intentId");
    const route = await this.entityDirectory.resolve(
      { requestId, operation: "content.intent.locate" }, "content-intent", intentId,
    );
    const routedPlacement = route
      ? await this.spaces.resolve(requestId, "content.intent.locate-routed", route.spaceId) : null;
    const located = await this.database.transaction(
      route && routedPlacement ? {
        requestId, operation: "content.intent.locate-routed",
        placement: { spaceId: route.spaceId, shardId: routedPlacement.shardId,
          placementEpoch: routedPlacement.placementEpoch },
      } : { requestId, operation: "content.intent.locate-legacy" },
      (tx) => tx.query<QueryResultRow>({
        name: route ? "content_intent_locate_routed_v1" : "content_intent_locate_legacy_v1",
        text: `SELECT space_id,scope_id FROM data.blob_upload_intents
          WHERE intent_id = $1${route ? " AND space_id = $2" : ""} LIMIT 1`,
        values: route ? [intentId, route.spaceId] : [intentId], maxRows: 1,
      }),
    );
    if (!located[0]) throw new ContentControlError(
      "blob_intent_unavailable", 404, "live pending upload intent is required",
    );
    const scope = await this.resolveScope(requestId, String(located[0].scope_id));
    return this.spaces.transaction(requestId, "content.intent.read", scope.spaceId, async (tx) => {
      await this.authorize(tx, scope, input.principal, "content_history_read");
      const rows = await tx.query<QueryResultRow>({
        name: "content_intent_read_v1",
        text: `SELECT * FROM data.blob_upload_intents WHERE space_id = $1 AND intent_id = $2
          AND status = 'pending' AND expires_at > clock_timestamp() LIMIT 1`,
        values: [scope.spaceId, intentId], maxRows: 1,
      });
      if (!rows[0]) throw new ContentControlError(
        "blob_intent_unavailable", 404, "live pending upload intent is required",
      );
      if (rows[0].purpose === "summon_decision") throw new ContentControlError(
        "decision_writer_required", 403, "Decision uploads require the internal decision writer");
      return serializeIntent(rows[0]);
    });
  }

  async commitRef(input: {
    requestId: string; commandId: string; intentId: string; expectedIntentVersion: number;
    refId: string; ownerKind: string; ownerId: string; scopeId: string; objectKey: string;
    checksum: string; encodedBytes: number; verifiedAt: string; principal: ContentPrincipal;
  }): Promise<Record<string, unknown>> {
    const { requestId, commandId } = command(input);
    const intentId = text(input.intentId, "intentId");
    const refId = text(input.refId, "refId");
    const ownerKind = text(input.ownerKind, "ownerKind", 80);
    const ownerId = text(input.ownerId, "ownerId");
    const scopeId = text(input.scopeId, "scopeId");
    const checksum = hash(input.checksum, "checksum");
    const encodedBytes = positive(input.encodedBytes, "encodedBytes", MAX_BLOB_BYTES);
    positive(input.expectedIntentVersion, "expectedIntentVersion");
    const verifiedAt = new Date(input.verifiedAt).toISOString();
    const now = new Date().toISOString();
    if (Date.parse(verifiedAt) > Date.parse(now) + 60_000 ||
        Date.parse(verifiedAt) < Date.parse(now) - 5 * 60_000) {
      throw new ContentControlError("stale_blob_verification", 409, "gateway verification is stale");
    }
    if (input.objectKey !== immutableContentObjectKey(scopeId, checksum)) throw new ContentControlError(
      "blob_object_mismatch", 409, "verified object metadata is not canonical",
    );
    const scope = await this.resolveScope(requestId, scopeId);
    const requestDigest = await digest(input);
    const placement = await this.spaces.resolve(requestId, "content.ref.commit", scope.spaceId);
    const result = await this.spaces.transaction(requestId, "content.ref.commit", placement, async (tx) => {
      if (scope.readerUserId) {
        await this.authorize(tx, scope, input.principal, "content_terminalize");
        await this.requireUncollectedObject(tx, scope.spaceId, input.objectKey);
      }
      const prior = await this.replay(tx, scope.spaceId, commandId, "commit-blob-ref", requestDigest);
      if (prior) return prior;
      await this.authorize(tx, scope, input.principal, "content_terminalize");
      const existing = await tx.query<QueryResultRow>({
        name: "content_ref_existing_v1",
        text: `SELECT r.*,o.storage_key,o.checksum,o.byte_length FROM data.content_refs r
          JOIN data.content_objects o ON o.space_id = r.space_id AND o.object_id = r.child_object_id
          WHERE r.space_id = $1 AND r.generation = 0 AND r.ref_id = $2 LIMIT 2 FOR UPDATE OF r`,
        values: [scope.spaceId, refId], maxRows: 2,
      });
      if (existing.length > 1) throw new ContentControlError(
        "blob_ref_conflict", 409, "refId is ambiguous",
      );
      let result: Record<string, unknown>;
      if (existing[0]) {
        const row = existing[0];
        if (row.root_set_id !== scopeId || row.owner_kind !== ownerKind || row.owner_id !== ownerId ||
            row.storage_key !== input.objectKey || row.checksum !== checksum ||
            Number(row.byte_length) !== encodedBytes) {
          throw new ContentControlError("blob_ref_conflict", 409, "refId was reused with another object");
        }
        result = serializeRef(row);
      } else {
        const intents = await tx.query<QueryResultRow>({
          name: "content_ref_intent_lock_v1",
          text: `SELECT * FROM data.blob_upload_intents WHERE space_id = $1
            AND intent_id = $2 FOR UPDATE`,
          values: [scope.spaceId, intentId], maxRows: 1,
        });
        const intent = intents[0];
        if (!intent || intent.status !== "pending" ||
            new Date(intent.expires_at as Date | string).getTime() <= Date.parse(now)) {
          throw new ContentControlError(
            "blob_intent_unavailable", 409, "live pending upload intent is required",
          );
        }
        if (Number(intent.version) !== input.expectedIntentVersion) throw new ContentControlError(
          "blob_intent_version_conflict", 409, "upload intent version changed",
        );
        // The intent was found in this Space; a Space-scope upload may be
        // referenced into any of its Channels, whose visibility this ref sets.
        if (!uploadScopeCoversRefScope(String(intent.scope_id), scopeId, scope.spaceId) ||
            intent.object_key !== input.objectKey ||
            intent.checksum !== checksum || Number(intent.encoded_bytes) !== encodedBytes) {
          throw new ContentControlError(
            "blob_object_mismatch", 409, "verified object metadata does not match intent",
          );
        }
        const objectId = scope.readerUserId ? `scoped:${scopeId}:sha256:${checksum}` : `sha256:${checksum}`;
        const objects = await tx.query<QueryResultRow>({
          name: "content_object_lock_v1",
          text: `SELECT * FROM data.content_objects WHERE space_id = $1 AND object_id = $2 FOR UPDATE`,
          values: [scope.spaceId, objectId], maxRows: 1,
        });
        if (objects[0] && (objects[0].object_kind !== "xmatrix.blob.v1" ||
            objects[0].storage_key !== input.objectKey || objects[0].checksum !== checksum ||
            Number(objects[0].byte_length) !== encodedBytes ||
            Number(objects[0].direct_child_count) !== 0)) {
          throw new ContentControlError(
            "blob_object_mismatch", 409, "content object identity is immutable",
          );
        }
        if (!objects[0]) await tx.query({
          name: "content_object_insert_v1",
          text: `INSERT INTO data.content_objects
            (space_id,object_id,object_kind,storage_key,checksum,byte_length,
             direct_child_count,direct_child_bytes,direct_children_digest,created_at,gc_not_before)
            VALUES ($1,$2,'xmatrix.blob.v1',$3,$4,$5,0,0,$6,$7,$8)`,
          values: [scope.spaceId, objectId, input.objectKey, checksum, encodedBytes,
            EMPTY_CHILDREN_DIGEST, now, new Date(Date.parse(now) + GC_SAFETY_MS).toISOString()],
          maxRows: 0,
        });
        await tx.query({
          name: "content_ref_insert_v1",
          text: `INSERT INTO data.content_refs
            (space_id,root_set_id,generation,ref_id,owner_kind,owner_id,parent_object_id,
             child_object_id,edge_ordinal,edge_key,parent_manifest_digest,child_checksum,
             child_bytes,logical_bytes,owner_descriptor,created_at)
            VALUES ($1,$2,0,$3,$4,$5,NULL,$6,NULL,NULL,NULL,$7,$8,$8,NULL,$9)`,
          values: [scope.spaceId, scopeId, refId, ownerKind, ownerId, objectId,
            checksum, encodedBytes, now], maxRows: 0,
        });
        await tx.query({
          name: "content_ref_intent_consume_v1",
          text: "DELETE FROM data.blob_upload_intents WHERE space_id = $1 AND intent_id = $2",
          values: [scope.spaceId, intentId], maxRows: 0,
        });
        await tx.query({
          name: "content_ref_gc_cancel_v1",
          text: "DELETE FROM data.content_gc_candidates WHERE space_id = $1 AND object_id = $2",
          values: [scope.spaceId, objectId], maxRows: 0,
        });
        result = { refId, scopeId, ownerKind, ownerId, contentHash: checksum,
          objectKey: input.objectKey, encodedBytes, checksum, version: 1, createdAt: now };
      }
      await this.commit(tx, { spaceId: scope.spaceId, commandId, kind: "commit-blob-ref",
        requestDigest, aggregateId: refId, result, now });
      return result;
    });
    await this.publishEntityRoute(
      requestId, placement, "content-intent", intentId, "deleted", input.expectedIntentVersion + 1,
    );
    await this.publishEntityRoute(requestId, placement, "content-ref", refId, "active", 1);
    return result;
  }

  private async locateRef(requestId: string, refId: string): Promise<QueryResultRow> {
    const route = await this.entityDirectory.resolve(
      { requestId, operation: "content.ref.locate" }, "content-ref", refId,
    );
    const routedPlacement = route
      ? await this.spaces.resolve(requestId, "content.ref.locate-routed", route.spaceId) : null;
    const rows = await this.database.transaction(
      route && routedPlacement ? {
        requestId, operation: "content.ref.locate-routed",
        placement: { spaceId: route.spaceId, shardId: routedPlacement.shardId,
          placementEpoch: routedPlacement.placementEpoch },
      } : { requestId, operation: "content.ref.locate-legacy" },
      (tx) => tx.query<QueryResultRow>({
        name: route ? "content_ref_locate_routed_v1" : "content_ref_locate_legacy_v1",
        text: `SELECT r.space_id,r.root_set_id FROM data.content_refs r
          WHERE r.generation = 0 AND r.ref_id = $1${route ? " AND r.space_id = $2" : ""} LIMIT 2`,
        values: route ? [refId, route.spaceId] : [refId], maxRows: 2,
      }),
    );
    if (rows.length !== 1) throw new ContentControlError(
      rows.length ? "blob_ref_conflict" : "blob_ref_not_found",
      rows.length ? 409 : 404,
      rows.length ? "blob reference is ambiguous" : "blob reference not found",
    );
    return rows[0]!;
  }

  async readRef(input: {
    requestId: string; refId: string; principal: ContentPrincipal;
  }): Promise<Record<string, unknown>> {
    const requestId = text(input.requestId, "requestId", 200);
    const refId = text(input.refId, "refId");
    const located = await this.locateRef(requestId, refId);
    const scope = await this.resolveScope(requestId, String(located.root_set_id));
    return this.spaces.transaction(requestId, "content.ref.read", scope.spaceId, async (tx) => {
      await this.authorize(tx, scope, input.principal, "content_history_read");
      const rows = await tx.query<QueryResultRow>({
        name: "content_ref_read_v1",
        text: `SELECT r.*,o.storage_key,o.checksum,o.byte_length,o.created_at
          FROM data.content_refs r JOIN data.content_objects o
            ON o.space_id = r.space_id AND o.object_id = r.child_object_id
          WHERE r.space_id = $1 AND r.root_set_id = $2 AND r.generation = 0
            AND r.ref_id = $3 LIMIT 1`,
        values: [scope.spaceId, located.root_set_id, refId], maxRows: 1,
      });
      if (!rows[0]) throw new ContentControlError("blob_ref_not_found", 404, "blob reference not found");
      // Decision evidence has additional source-publication and expiry checks.
      // Generic blob reads must not bypass the dedicated forensic reader.
      if (rows[0].owner_kind === "summon_decision") throw new ContentControlError(
        "decision_reader_required", 403, "Decision records require the decision evidence endpoint",
      );
      return serializeRef(rows[0]);
    });
  }

  /** Dedicated forensic access; generic private blob reads remain owner-only. */
  async summonDecisionRefs(input: {
    requestId: string; channelId: string; sourceMessageId: string; principal: ContentPrincipal;
    refId?: string; afterRefId?: string; limit?: number; runProof?: AgentChannelRunProof;
  }): Promise<{ refs: Record<string, unknown>[]; nextCursor: string | null }> {
    if (input.principal.kind === "agent" && !input.runProof) throw new ContentControlError("forbidden", 403, "Decision inputs require an exact Agent Run");
    const requestId = text(input.requestId, "requestId", 200);
    const channelId = text(input.channelId, "channelId");
    const sourceMessageId = text(input.sourceMessageId, "sourceMessageId");
    const scope = await this.resolveScope(requestId, `channel:${channelId}`);
    const limit = positive(input.limit ?? 50, "limit", 50);
    const refId = input.refId === undefined ? null : text(input.refId, "refId");
    const after = input.afterRefId === undefined ? null : text(input.afterRefId, "afterRefId");
    return this.spaces.transaction(requestId, "content.summon-decisions.read", scope.spaceId, async tx => {
      let actorUserId = input.principal.id;
      if (input.principal.kind === "agent") {
        await requireAgentChannelAccess(tx, { spaceId: scope.spaceId, channelId,
          agentId: input.principal.id, runProof: input.runProof!, capability: "content_history_read" });
        // Derive the restricted root from the persisted source, never request metadata.
        const source = (await tx.query({ name: "content_decision_source_owner_v3", text: `SELECT
            CASE WHEN m.author_kind='user' THEN m.author_id WHEN m.author_kind='system' THEN choice.author_user_id
              ELSE binding.owner_user_id END AS owner_user_id
          FROM data.messages m
          LEFT JOIN data.instances author ON m.author_kind='agent' AND author.instance_id=m.author_id
          LEFT JOIN data.run_agent_registrations binding ON binding.run_id=author.run_id AND binding.space_id=m.space_id
          LEFT JOIN data.first_message_launch_choices choice ON m.author_kind='system' AND m.author_id='xmatrix'
            AND choice.space_id=m.space_id AND choice.channel_id=m.channel_id
            AND m.message_id='xmatrix-summon:'||choice.message_id AND choice.choice='start'
          WHERE m.space_id=$1 AND m.channel_id=$2 AND m.message_id=$3
            AND m.author_kind IN ('user','agent','system') LIMIT 1`,
          values: [scope.spaceId, channelId, sourceMessageId], maxRows: 1 }))[0];
        if (typeof source?.owner_user_id !== "string") throw new ContentControlError("not_found", 404, "Decision source is unavailable");
        actorUserId = source.owner_user_id;
      } else {
        await this.authorize(tx, scope, input.principal, "content_history_read");
      }
      const scopeId = restrictedChannelContentScope(channelId, actorUserId);
      if (!await initialMessageSource(tx, { spaceId: scope.spaceId, channelId,
        messageId: sourceMessageId, actorUserId })) {
        throw new ContentControlError("not_found", 404, "Decision source is unavailable");
      }
      const rows = await tx.query<QueryResultRow>({ name: "content_summon_decision_refs_v1",
        text: `SELECT r.*,o.storage_key,o.checksum,o.byte_length FROM data.content_refs r
          JOIN data.content_objects o ON o.space_id=r.space_id AND o.object_id=r.child_object_id
          WHERE r.space_id=$1 AND r.root_set_id=$2 AND r.generation=0
            AND r.owner_kind='summon_decision' AND r.owner_id=$3
            AND r.created_at > $4::timestamptz
            AND ($5::text IS NULL OR r.ref_id=$5) AND ($6::text IS NULL OR r.ref_id>$6)
          ORDER BY r.ref_id LIMIT $7`,
        values: [scope.spaceId, scopeId, sourceMessageId, new Date(Date.now() - DECISION_RETENTION_MS).toISOString(),
          refId, after, limit + 1], maxRows: limit + 1,
      });
      return { refs: rows.slice(0, limit).map(serializeRef),
        nextCursor: rows.length > limit ? String(rows[limit - 1]!.ref_id) : null };
    });
  }

  /** Retire only server-owned abandoned decision uploads after the safety window. */
  async retireDecisionUploads(input: { requestId: string; spaceId: string; limit?: number }): Promise<number> {
    const { requestId, spaceId, limit, now, cutoff } = maintenancePass(input, GC_SAFETY_MS);
    const placement = await this.spaces.resolve(requestId, "content.decisions.orphans", spaceId);
    const retired = await this.spaces.transaction(requestId, "content.decisions.orphans", placement, async tx => {
      const candidates = await tx.query<QueryResultRow>({ name: "content_decision_orphan_scan_v1",
        text: `SELECT intent_id,scope_id,object_key,checksum FROM data.blob_upload_intents
          WHERE space_id=$1 AND purpose='summon_decision' AND expires_at <= $2::timestamptz
          ORDER BY expires_at,intent_id LIMIT $3`, values: [spaceId, cutoff, limit], maxRows: limit });
      const retired: Array<{ intentId: string; version: number }> = [];
      for (const row of candidates) {
        const scopeId = String(row.scope_id), objectKey = String(row.object_key), checksum = String(row.checksum);
        if (!parseRestrictedChannelContentScope(scopeId) || immutableContentObjectKey(scopeId, checksum) !== objectKey) {
          throw new ContentControlError("invalid_decision_storage", 409, "Decision storage scope is invalid");
        }
        await this.lockRestrictedObject(tx, spaceId, objectKey);
        const current = await tx.query<QueryResultRow>({ name: "content_decision_orphan_lock_v1",
          text: `SELECT version FROM data.blob_upload_intents WHERE space_id=$1 AND intent_id=$2
            AND purpose='summon_decision' AND expires_at <= $3::timestamptz FOR UPDATE SKIP LOCKED`,
          values: [spaceId, row.intent_id, cutoff], maxRows: 1 });
        if (!current[0]) continue;
        await tx.query({ name: "content_decision_orphan_retire_v1",
          text: "DELETE FROM data.blob_upload_intents WHERE space_id=$1 AND intent_id=$2",
          values: [spaceId, row.intent_id], maxRows: 0 });
        const objectId = `scoped:${scopeId}:sha256:${checksum}`;
        const referenced = await tx.query({ name: "content_decision_orphan_referenced_v1",
          text: "SELECT 1 FROM data.content_refs WHERE space_id=$1 AND child_object_id=$2 LIMIT 1",
          values: [spaceId, objectId], maxRows: 1 });
        if (!referenced.length) await tx.query({ name: "content_decision_orphan_nominate_v1",
          text: `INSERT INTO data.content_gc_candidates
            (space_id,object_id,storage_key,content_hash,reason,unreferenced_at,not_before,
             status,version,lease_until,attempts,last_checked_at,created_at,updated_at)
            VALUES ($1,$2,$3,$4,'decision-upload-expired',$5,$6,'pending',1,NULL,0,NULL,$5,$5)
            ON CONFLICT (space_id,object_id) DO NOTHING`,
          values: [spaceId,objectId,objectKey,checksum,now,new Date(Date.parse(now)+GC_SAFETY_MS).toISOString()], maxRows: 0 });
        retired.push({ intentId: String(row.intent_id), version: Number(current[0].version) + 1 });
      }
      if (retired.length) await this.commit(tx, { spaceId, commandId: `decision-orphans:${crypto.randomUUID()}`,
        kind: "retire-decision-uploads", requestDigest: await digest({ spaceId, cutoff, retired }), aggregateId: spaceId,
        result: { retired }, now });
      return retired;
    });
    for (const row of retired) await this.publishEntityRoute(requestId, placement, "content-intent", row.intentId, "deleted", row.version);
    return retired.length;
  }

  async nextDecisionMaintenance(input: { requestId: string; spaceId: string }): Promise<number | null> {
    const { requestId, spaceId } = spaceRequest(input);
    return this.spaces.transaction(requestId, "content.decisions.next", spaceId, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "content_decision_next_maintenance_v1",
        text: `SELECT MIN(due_at) AS due_at FROM (
          SELECT MIN(created_at)+interval '30 days' AS due_at FROM data.content_refs
            WHERE space_id=$1 AND generation=0 AND owner_kind='summon_decision'
          UNION ALL SELECT MIN(GREATEST(not_before,COALESCE(lease_until,not_before))) AS due_at
            FROM data.content_gc_candidates WHERE space_id=$1 AND reason IN ('decision-expired','decision-upload-expired')
              AND status IN ('pending','leased') AND attempts < 100
          UNION ALL SELECT MIN(expires_at)+interval '31 days' AS due_at FROM data.blob_upload_intents
            WHERE space_id=$1 AND purpose='summon_decision'
        ) due`, values: [spaceId], maxRows: 1 });
      return rows[0]?.due_at ? new Date(rows[0].due_at as string | Date).getTime() : null;
    });
  }

  async dueDecisionObjects(input: { requestId: string; spaceId: string; limit?: number }): Promise<string[]> {
    const { requestId, spaceId } = spaceRequest(input);
    const limit = positive(input.limit ?? 10, "limit", 100);
    return this.spaces.transaction(requestId, "content.decisions.due", spaceId, async tx => (await tx.query<QueryResultRow>({
      name: "content_decision_gc_due_v1",
      text: `SELECT storage_key FROM data.content_gc_candidates WHERE space_id=$1
        AND reason IN ('decision-expired','decision-upload-expired') AND not_before <= clock_timestamp() AND attempts < 100
        AND (status='pending' OR (status='leased' AND lease_until <= clock_timestamp()))
        ORDER BY not_before,object_id LIMIT $2`, values: [spaceId, limit], maxRows: limit,
    })).map(row => String(row.storage_key)));
  }

  /** Internal collector lease. Retirement is irreversible for this immutable key;
   * retries may delete the same bytes, but cannot race with a new reference. */
  async claimDecisionObject(input: { requestId: string; spaceId: string; objectKey: string }):
    Promise<{ objectKey: string; objectId: string; version: number } | null> {
    const { requestId, spaceId } = spaceRequest(input);
    const objectKey = text(input.objectKey, "objectKey", 1024);
    const parts = /^restricted\/([^/]+)\/objects\/([a-f0-9]{64})$/.exec(objectKey);
    if (!parts || !parseRestrictedChannelContentScope(decodeURIComponent(parts[1]!)) ||
        immutableContentObjectKey(decodeURIComponent(parts[1]!), parts[2]!) !== objectKey) {
      throw new ContentControlError("invalid_decision_storage", 400, "Decision storage scope is invalid");
    }
    return this.spaces.transaction(requestId, "content.decisions.collect", spaceId, async tx => {
      await this.lockRestrictedObject(tx, spaceId, objectKey);
      const rows = await tx.query<QueryResultRow>({ name: "content_decision_gc_claim_v1",
        text: `SELECT g.* FROM data.content_gc_candidates g LEFT JOIN data.content_objects o
          ON o.space_id=g.space_id AND o.object_id=g.object_id
          WHERE g.space_id=$1 AND g.storage_key=$2
          AND ((o.object_id IS NULL AND g.reason='decision-upload-expired') OR
            (o.storage_key=g.storage_key AND o.checksum=g.content_hash AND o.gc_not_before <= clock_timestamp()))
          AND g.reason IN ('decision-expired','decision-upload-expired') AND g.not_before <= clock_timestamp() AND g.attempts < 100
          AND (g.status='pending' OR (g.status='leased' AND g.lease_until <= clock_timestamp()))
          FOR UPDATE OF g`, values: [spaceId, objectKey], maxRows: 1 });
      const row = rows[0];
      if (!row) return null;
      if (row.content_hash !== parts[2] || row.object_id !== `scoped:${decodeURIComponent(parts[1]!)}:sha256:${parts[2]}`) {
        throw new ContentControlError("invalid_decision_storage", 409, "Decision object identity is invalid");
      }
      const retained = await tx.query({ name: "content_decision_gc_retained_v1",
        text: `SELECT 1 WHERE EXISTS (SELECT 1 FROM data.content_refs WHERE space_id=$1 AND child_object_id=$2)
          OR EXISTS (SELECT 1 FROM data.blob_upload_intents WHERE space_id=$1 AND object_key=$3)`,
        values: [spaceId, row.object_id, objectKey], maxRows: 1 });
      if (retained.length) return null;
      const claimed = await tx.query<QueryResultRow>({ name: "content_decision_gc_lease_v1",
        text: `UPDATE data.content_gc_candidates SET status='leased', version=version+1,
          lease_until=clock_timestamp()+interval '5 minutes', attempts=attempts+1,
          last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE space_id=$1 AND object_id=$2 RETURNING version`,
        values: [spaceId, row.object_id], maxRows: 1 });
      const result = { objectKey, objectId: String(row.object_id), version: Number(claimed[0]!.version) };
      await this.commit(tx, { spaceId, commandId: `decision-gc:${crypto.randomUUID()}`, kind: "claim-decision-object",
        requestDigest: await digest(result), aggregateId: result.objectId,
        result: { objectId: result.objectId, version: result.version, status: "leased" }, now: new Date().toISOString() });
      return result;
    });
  }

  async completeDecisionObject(input: { requestId: string; spaceId: string; objectId: string; version: number }): Promise<boolean> {
    const { requestId, spaceId } = spaceRequest(input);
    const objectId = text(input.objectId, "objectId");
    const version = positive(input.version, "version");
    return this.spaces.transaction(requestId, "content.decisions.collected", spaceId, async tx => {
      const rows = await tx.query({ name: "content_decision_gc_complete_v1",
        text: `UPDATE data.content_gc_candidates SET status='deleted',version=version+1,
          lease_until=NULL,last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE space_id=$1 AND object_id=$2 AND version=$3 AND status='leased'
            AND reason IN ('decision-expired','decision-upload-expired') RETURNING object_id`, values: [spaceId, objectId, version], maxRows: 1 });
      if (!rows.length) return false;
      await this.commit(tx, { spaceId, commandId: `decision-gc-done:${crypto.randomUUID()}`, kind: "complete-decision-object",
        requestDigest: await digest({ objectId, version }), aggregateId: objectId,
        result: { objectId, version: version + 1, status: "deleted" }, now: new Date().toISOString() });
      return true;
    });
  }

  /** Internal maintenance only: expire bounded decision refs, retaining GC safety.
   * This does not delete payload bytes; the content collector owns that step. */
  async expireDecisionRefs(input: { requestId: string; spaceId: string; limit?: number }):
    Promise<{ expired: number; refIds: string[] }> {
    const { requestId, spaceId, limit, now, cutoff } = maintenancePass(input, DECISION_RETENTION_MS);
    const placement = await this.spaces.resolve(requestId, "content.decisions.expire", spaceId);
    const result = await this.spaces.transaction(requestId, "content.decisions.expire", placement, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "content_decision_expiry_lock_v1",
        text: `SELECT r.ref_id,r.root_set_id,r.child_object_id,o.storage_key,o.checksum,o.gc_not_before
          FROM data.content_refs r JOIN data.content_objects o
            ON o.space_id=r.space_id AND o.object_id=r.child_object_id
          WHERE r.space_id=$1 AND r.generation=0 AND r.owner_kind='summon_decision'
            AND r.created_at <= $2::timestamptz
          ORDER BY r.created_at,r.ref_id LIMIT $3 FOR UPDATE OF r,o SKIP LOCKED`,
        values: [spaceId, cutoff, limit], maxRows: limit,
      });
      for (const row of rows) {
        const restricted = parseRestrictedChannelContentScope(String(row.root_set_id));
        if (!restricted || row.storage_key !== immutableContentObjectKey(String(row.root_set_id), String(row.checksum))) {
          throw new ContentControlError("invalid_decision_storage", 409, "Decision storage scope is invalid");
        }
        await tx.query({ name: "content_decision_expire_v1",
          text: `DELETE FROM data.content_refs WHERE space_id=$1 AND root_set_id=$2
            AND generation=0 AND ref_id=$3 AND owner_kind='summon_decision'
            AND created_at <= $4::timestamptz`,
          values: [spaceId, row.root_set_id, row.ref_id, cutoff], maxRows: 0 });
        const remaining = await tx.query({ name: "content_decision_remaining_v1",
          text: `SELECT ref_id FROM data.content_refs WHERE space_id=$1 AND child_object_id=$2 LIMIT 1`,
          values: [spaceId, row.child_object_id], maxRows: 1 });
        if (!remaining.length) await tx.query({ name: "content_decision_gc_nominate_v1",
          text: `INSERT INTO data.content_gc_candidates
            (space_id,object_id,storage_key,content_hash,reason,unreferenced_at,not_before,
             status,version,lease_until,attempts,last_checked_at,created_at,updated_at)
            VALUES ($1,$2,$3,$4,'decision-expired',$5,$6,'pending',1,NULL,0,NULL,$5,$5)
            ON CONFLICT (space_id,object_id) DO NOTHING`,
          values: [spaceId,row.child_object_id,row.storage_key,row.checksum,now,
            new Date(Math.max(Date.parse(now) + GC_SAFETY_MS,
              new Date(row.gc_not_before as Date | string).getTime())).toISOString()], maxRows: 0 });
      }
      const result = { expired: rows.length, refIds: rows.map(row => String(row.ref_id)) };
      if (rows.length) await this.commit(tx, { spaceId, commandId: `decision-expiry:${crypto.randomUUID()}`,
        kind: "expire-decision-refs", requestDigest: await digest({ spaceId, cutoff, refIds: result.refIds }),
        aggregateId: spaceId, result, now });
      return result;
    });
    for (const refId of result.refIds) await this.publishEntityRoute(requestId, placement, "content-ref", refId, "deleted", 2);
    return result;
  }

  async releaseRef(input: {
    requestId: string; commandId: string; refId: string; expectedRefVersion: number;
    notBefore?: string; principal: ContentPrincipal;
  }): Promise<Record<string, unknown>> {
    const { requestId, commandId } = command(input);
    const refId = text(input.refId, "refId");
    if (input.expectedRefVersion !== 1) throw new ContentControlError(
      "blob_ref_version_conflict", 409, "blob reference version changed",
    );
    const located = await this.locateRef(requestId, refId);
    const scope = await this.resolveScope(requestId, String(located.root_set_id));
    const requestDigest = await digest(input);
    const now = new Date().toISOString();
    const placement = await this.spaces.resolve(requestId, "content.ref.release", scope.spaceId);
    const result = await this.spaces.transaction(requestId, "content.ref.release", placement, async (tx) => {
      if (scope.readerUserId) await this.authorize(tx, scope, input.principal, "content_terminalize");
      const prior = await this.replay(tx, scope.spaceId, commandId, "release-blob-ref", requestDigest);
      if (prior) return prior;
      await this.authorize(tx, scope, input.principal, "content_terminalize");
      const rows = await tx.query<QueryResultRow>({
        name: "content_ref_release_lock_v1",
        text: `SELECT r.*,o.storage_key,o.checksum,o.gc_not_before
          FROM data.content_refs r JOIN data.content_objects o
            ON o.space_id = r.space_id AND o.object_id = r.child_object_id
          WHERE r.space_id = $1 AND r.root_set_id = $2 AND r.generation = 0
            AND r.ref_id = $3 FOR UPDATE OF r,o`,
        values: [scope.spaceId, located.root_set_id, refId], maxRows: 1,
      });
      const row = rows[0];
      if (!row) throw new ContentControlError("blob_ref_not_found", 404, "blob reference not found");
      await tx.query({
        name: "content_ref_release_v1",
        text: `DELETE FROM data.content_refs WHERE space_id = $1 AND root_set_id = $2
          AND generation = 0 AND ref_id = $3`,
        values: [scope.spaceId, located.root_set_id, refId], maxRows: 0,
      });
      const remaining = await tx.query({
        name: "content_ref_remaining_v1",
        text: `SELECT ref_id FROM data.content_refs
          WHERE space_id = $1 AND child_object_id = $2 LIMIT 1`,
        values: [scope.spaceId, row.child_object_id], maxRows: 1,
      });
      const requested = input.notBefore ? new Date(input.notBefore).getTime() : 0;
      const notBefore = new Date(Math.max(requested, Date.parse(now) + GC_SAFETY_MS,
        new Date(row.gc_not_before as Date | string).getTime())).toISOString();
      if (!remaining[0]) await tx.query({
        name: "content_gc_nominate_v1",
        text: `INSERT INTO data.content_gc_candidates
          (space_id,object_id,storage_key,content_hash,reason,unreferenced_at,not_before,
           status,version,lease_until,attempts,last_checked_at,created_at,updated_at)
          VALUES ($1,$2,$3,$4,'blob-unreferenced',$5,$6,'pending',1,NULL,0,NULL,$5,$5)
          ON CONFLICT (space_id,object_id) DO UPDATE SET
            not_before = GREATEST(data.content_gc_candidates.not_before,EXCLUDED.not_before),
            status = 'pending',version = data.content_gc_candidates.version + 1,
            lease_until = NULL,updated_at = EXCLUDED.updated_at`,
        values: [scope.spaceId, row.child_object_id, row.storage_key, row.checksum, now, notBefore],
        maxRows: 0,
      });
      const result = { released: true, refId, objectKey: row.storage_key,
        contentHash: row.checksum, notBefore };
      await this.commit(tx, { spaceId: scope.spaceId, commandId, kind: "release-blob-ref",
        requestDigest, aggregateId: refId, result, now });
      return result;
    });
    await this.publishEntityRoute(requestId, placement, "content-ref", refId, "deleted", 2);
    return result;
  }

  async sealAttachments(input: {
    requestId: string; channelId: string; messageId: string; actorUserId: string;
    attachments: Array<{ attachmentId: string; objectKey: string; contentHash: string;
      encodedBytes: number; mimeType: string; name: string;
      presentationResidual?: Record<string, unknown> }>;
  }): Promise<Record<string, unknown>[]> {
    const requestId = text(input.requestId, "requestId", 200);
    const channelId = text(input.channelId, "channelId");
    const messageId = text(input.messageId, "messageId");
    const actorUserId = text(input.actorUserId, "actorUserId");
    if (!Array.isArray(input.attachments) || input.attachments.length < 1 ||
        input.attachments.length > 10) {
      throw new ContentControlError("invalid_command", 400, "Attachment count is invalid");
    }
    const scope = await this.resolveScope(requestId, `channel:${channelId}`);
    const now = new Date().toISOString();
    return this.spaces.transaction(requestId, "content.attachment.seal", scope.spaceId, async (tx) => {
      await this.authorize(tx, scope, { kind: "user", id: actorUserId }, "content_new_work");
      const channels = await tx.query<QueryResultRow & { mode: string }>({
        name: "content_attachment_channel_v1",
        text: "SELECT mode FROM data.channels WHERE space_id = $1 AND channel_id = $2 LIMIT 1",
        values: [scope.spaceId, channelId], maxRows: 1,
      });
      if (!channels[0]) throw new ContentControlError("not_found", 404, "Channel not found");
      const rootSetId = channelVisibilityScope({ mode: channels[0].mode, channelId, spaceId: scope.spaceId });
      const seen = new Set<string>();
      const results: Record<string, unknown>[] = [];
      for (const attachment of input.attachments) {
        const attachmentId = text(attachment.attachmentId, "attachmentId");
        if (seen.has(attachmentId)) throw new ContentControlError(
          "invalid_command", 400, "Attachment IDs must be unique",
        );
        seen.add(attachmentId);
        const contentHash = hash(attachment.contentHash, "contentHash");
        const encodedBytes = positive(attachment.encodedBytes, "encodedBytes", 1024 * 1024 * 1024);
        if (attachment.objectKey !== `objects/${contentHash}`) throw new ContentControlError(
          "invalid_command", 400, "Attachment object metadata is invalid",
        );
        const refs = await tx.query<QueryResultRow>({
          name: "content_attachment_ref_lock_v1",
          text: `SELECT r.*,o.storage_key,o.checksum,o.byte_length FROM data.content_refs r
            JOIN data.content_objects o ON o.space_id = r.space_id AND o.object_id = r.child_object_id
            WHERE r.space_id = $1 AND r.root_set_id = $2 AND r.generation = 0
              AND r.owner_id = $3 AND r.owner_kind IN ('message_attachment','message-attachment')
              AND r.ref_id = $4 LIMIT 1 FOR UPDATE OF r`,
          values: [scope.spaceId, rootSetId, messageId, attachmentId], maxRows: 1,
        });
        const ref = refs[0];
        if (!ref || ref.storage_key !== attachment.objectKey || ref.checksum !== contentHash ||
            Number(ref.byte_length) !== encodedBytes) {
          throw new ContentControlError(
            "attachment_authority_conflict", 409, "Verified attachment ownership is unavailable",
          );
        }
        let descriptor = { attachmentId, channelId, messageId, ownerUserId: actorUserId,
          name: text(attachment.name, "name", 512), mimeType: text(attachment.mimeType, "mimeType", 200),
          version: 1, createdAt: now, updatedAt: now,
          ...(attachment.presentationResidual
            ? { presentationResidual: attachment.presentationResidual } : {}) };
        const encoded = new TextEncoder().encode(stable(descriptor));
        if (ref.owner_descriptor) {
          let existing: typeof descriptor;
          try {
            existing = JSON.parse(new TextDecoder().decode(
              ref.owner_descriptor as Uint8Array,
            )) as typeof descriptor;
          } catch {
            throw new ContentControlError(
              "attachment_authority_conflict", 409, "Attachment ownership descriptor is invalid",
            );
          }
          if (existing.attachmentId !== attachmentId || existing.channelId !== channelId ||
              existing.messageId !== messageId || existing.ownerUserId !== actorUserId ||
              existing.name !== descriptor.name || existing.mimeType !== descriptor.mimeType) {
            throw new ContentControlError(
            "attachment_authority_conflict", 409, "Attachment ownership is already bound differently",
            );
          }
          descriptor = existing;
        } else await tx.query({
          name: "content_attachment_bind_v1",
          text: `UPDATE data.content_refs SET owner_descriptor = $5
            WHERE space_id = $1 AND root_set_id = $2 AND generation = 0
              AND ref_id = $3 AND owner_id = $4 AND owner_descriptor IS NULL`,
          values: [scope.spaceId, rootSetId, attachmentId, messageId, encoded], maxRows: 0,
        });
        results.push({ id: attachmentId, channelId, messageId,
          kind: attachment.mimeType.startsWith("image/") ? "image"
            : attachment.mimeType.startsWith("video/") ? "video"
              : attachment.mimeType.startsWith("audio/") ? "audio" : "file",
          objectKey: attachment.objectKey, contentHash, size: encodedBytes,
          mimeType: descriptor.mimeType, name: descriptor.name, version: 1,
          ...descriptor.presentationResidual });
      }
      return results;
    });
  }
}
