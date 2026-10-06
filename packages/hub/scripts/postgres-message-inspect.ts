#!/usr/bin/env tsx

import process from "node:process";
import { Client } from "pg";

import {
  decodeRelayV2MessagePayloadBundle,
  prepareRelayV2MessageRecord,
  type RelayV2MessageRecordInput,
} from "../src/relay-v2-message-record";
import { base64UrlDecodeBytes, base64UrlEncodeBytes } from "../src/relay-v2-primitives";

interface InspectionClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface MessageInspectionOptions {
  messageId: string;
  spaceId?: string;
  channelId?: string;
  includeBody: boolean;
  previewRepair: boolean;
}

function value(argument: string, name: string): string | undefined {
  const prefix = `--${name}=`;
  if (!argument.startsWith(prefix)) return undefined;
  const result = argument.slice(prefix.length).trim();
  if (!result || new TextEncoder().encode(result).byteLength > 300) {
    throw new Error(`${name} is invalid`);
  }
  return result;
}

export function parseMessageInspectionOptions(argv: readonly string[]): MessageInspectionOptions {
  let messageId: string | undefined;
  let spaceId: string | undefined;
  let channelId: string | undefined;
  let includeBody = false;
  let previewRepair = false;
  for (const argument of argv) {
    if (argument === "--include-body") includeBody = true;
    else if (argument === "--preview-repair") previewRepair = true;
    else if (value(argument, "message-id") !== undefined) messageId = value(argument, "message-id");
    else if (value(argument, "space-id") !== undefined) spaceId = value(argument, "space-id");
    else if (value(argument, "channel-id") !== undefined) channelId = value(argument, "channel-id");
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!messageId) throw new Error("--message-id is required");
  return { messageId, ...(spaceId ? { spaceId } : {}), ...(channelId ? { channelId } : {}),
    includeBody, previewRepair };
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Message timestamp is invalid");
  return date.toISOString();
}

function optionalTimestamp(
  input: Record<string, unknown>,
  presence: Map<number, number>,
  field: "editedAt" | "recalledAt" | "deletedAt",
  fieldId: number,
): void {
  const state = presence.get(fieldId) ?? 0;
  if (state === 1) input[field] = null;
  if (state === 2) input[field] = iso(input[field]);
}

async function decodeAndVerify(row: Record<string, unknown>) {
  if (typeof row.payload_bundle_base64 !== "string" || typeof row.field_presence_base64 !== "string") {
    return { payload: null, verification: { status: "payload_unavailable" } };
  }
  const payload = decodeRelayV2MessagePayloadBundle(
    base64UrlDecodeBytes(row.payload_bundle_base64),
  );
  const rawPresence = (await import("@xmatrix/protocol")).decodeCanonicalCloneCborV1(
    base64UrlDecodeBytes(row.field_presence_base64),
  );
  const entries = rawPresence && typeof rawPresence === "object" &&
      "entries" in rawPresence && Array.isArray(rawPresence.entries)
    ? rawPresence.entries : null;
  if (!entries) throw new Error("Message field presence is invalid");
  const presence = new Map(entries.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Message field presence is invalid");
    return [Number(entry[0]), Number(entry[1])];
  }));
  const preparedInput: Record<string, unknown> = {
    messageId: String(row.message_id), channelId: String(row.channel_id),
    timelineSequence: Number(row.timeline_sequence), senderKind: String(row.author_kind),
    senderId: String(row.author_id), messageKind: String(row.message_kind),
    payloadSchemaVersion: Number(row.payload_schema_version),
    entityVersion: Number(row.entity_version), sentAt: iso(row.sent_at),
    editedAt: row.edited_at, recalledAt: row.recalled_at, deletedAt: row.deleted_at,
    body: payload.body, senderSnapshot: payload.senderSnapshot,
    ...(Object.prototype.hasOwnProperty.call(payload, "residual")
      ? { residual: payload.residual } : {}),
  };
  optionalTimestamp(preparedInput, presence, "editedAt", 10);
  optionalTimestamp(preparedInput, presence, "recalledAt", 11);
  optionalTimestamp(preparedInput, presence, "deletedAt", 12);
  for (const field of ["editedAt", "recalledAt", "deletedAt"] as const) {
    if ((presence.get({ editedAt: 10, recalledAt: 11, deletedAt: 12 }[field]) ?? 0) === 0) {
      delete preparedInput[field];
    }
  }
  const prepared = await prepareRelayV2MessageRecord(
    preparedInput as unknown as RelayV2MessageRecordInput,
  );
  const checks = {
    codecId: prepared.codecId === row.codec_id,
    payloadSchemaVersion: prepared.payloadSchemaVersion === Number(row.payload_schema_version),
    fieldPresence: base64UrlEncodeBytes(prepared.fieldPresenceBytes) === row.field_presence_base64,
    payloadBundle: base64UrlEncodeBytes(prepared.payloadBundleBytes) === row.payload_bundle_base64,
    bodyHash: prepared.bodyHash === row.body_hash,
    senderSnapshotDigest: prepared.senderSnapshotDigest === row.sender_snapshot_digest,
    recordDigest: prepared.recordDigest === row.record_digest,
    recordEncodedBytes: prepared.recordEncodedBytes === Number(row.record_encoded_bytes),
  };
  return { payload, verification: { status: Object.values(checks).every(Boolean) ? "ok" : "mismatch", checks } };
}

function repairPreview(row: Record<string, unknown>): Record<string, unknown> {
  return {
    parameters: {
      spaceId: row.space_id, messageId: row.message_id,
      expectedEntityVersion: Number(row.entity_version), expectedRecordDigest: row.record_digest,
    },
    sql: `BEGIN;
SELECT entity_version,record_digest FROM data.messages
WHERE space_id=$1 AND message_id=$2 FOR UPDATE;
-- Re-encode the intended message with the canonical codec, then bind its complete
-- payload/digest tuple as $5..$11. Never update one digest or payload field alone.
UPDATE data.messages SET codec_id=$5,payload_schema_version=$6,field_presence_base64=$7,
  payload_bundle_base64=$8,body_hash=$9,sender_snapshot_digest=$10,record_digest=$11,
  record_encoded_bytes=$12,invocation_input_version=entity_version+1,entity_version=entity_version+1,updated_at=clock_timestamp()
WHERE space_id=$1 AND message_id=$2 AND entity_version=$3 AND record_digest=$4;
-- Insert the matching mutation/outbox/idempotency facts before replacing ROLLBACK.
ROLLBACK;`,
    executesWrites: false,
  };
}

export async function inspectPostgresMessage(
  client: InspectionClient,
  options: MessageInspectionOptions,
): Promise<Record<string, unknown>> {
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    const messages = await client.query(`SELECT space_id,channel_id,message_id,timeline_sequence,
        entity_version,author_kind,author_id,message_kind,sent_at,edited_at,recalled_at,deleted_at,
        codec_id,payload_schema_version,field_presence_base64,payload_bundle_base64,legacy_body,
        body_hash,sender_snapshot_digest,record_digest,record_encoded_bytes
      FROM data.messages WHERE message_id=$1
        AND ($2::text IS NULL OR space_id=$2) AND ($3::text IS NULL OR channel_id=$3)
      ORDER BY space_id LIMIT 2`, [options.messageId, options.spaceId ?? null, options.channelId ?? null]);
    if (messages.rows.length === 0) throw new Error("Message was not found");
    if (messages.rows.length > 1) throw new Error("Message id is ambiguous; supply --space-id");
    const row = messages.rows[0]!;
    const [{ payload, verification }, attachments, mutations, outbox, idempotency] = await Promise.all([
      decodeAndVerify(row),
      client.query(`SELECT attachment_id,object_key,content_hash,encoded_bytes,mime_type,name,
          presentation_residual_json,version,created_at,updated_at
        FROM data.message_attachment_refs WHERE space_id=$1 AND message_id=$2
        ORDER BY created_at,attachment_id LIMIT 100`, [row.space_id, row.message_id]),
      client.query(`SELECT entity_version,mutation_kind,mutation_json,actor_kind,actor_id,occurred_at
        FROM data.message_mutations WHERE space_id=$1 AND message_id=$2
        ORDER BY entity_version LIMIT 100`, [row.space_id, row.message_id]),
      client.query(`SELECT outbox_id,topic,aggregate_sequence,status,attempts,available_at,
          lease_until,created_at,updated_at FROM data.outbox
        WHERE space_id=$1 AND aggregate_kind='message' AND aggregate_id=$2
        ORDER BY aggregate_sequence,outbox_id LIMIT 100`, [row.space_id, row.message_id]),
      client.query(`SELECT idempotency_key,command_kind,request_digest,commit_sequence,
          created_at,expires_at FROM data.idempotency_keys
        WHERE space_id=$1 AND result_json->>'messageId'=$2
        ORDER BY created_at,idempotency_key LIMIT 100`, [row.space_id, row.message_id]),
    ]);
    const senderSnapshot = payload?.senderSnapshot ?? null;
    const sender = senderSnapshot ? Object.fromEntries(
      ["identityId", "kind", "userId", "agentId", "label", "name", "agentName", "runtime"]
        .flatMap((key) => Object.prototype.hasOwnProperty.call(senderSnapshot, key)
          ? [[key, senderSnapshot[key]]] : []),
    ) : null;
    const report = {
      schemaVersion: 1,
      message: {
        spaceId: row.space_id, channelId: row.channel_id, messageId: row.message_id,
        timelineSequence: Number(row.timeline_sequence), entityVersion: Number(row.entity_version),
        senderKind: row.author_kind, senderId: row.author_id, messageKind: row.message_kind,
        sentAt: iso(row.sent_at), editedAt: iso(row.edited_at), recalledAt: iso(row.recalled_at),
        deletedAt: iso(row.deleted_at), sender,
        residualKeys: payload?.residual ? Object.keys(payload.residual).sort() : [],
        ...(options.includeBody ? { body: payload?.body ?? row.legacy_body ?? null } : {}),
      },
      verification,
      attachments: attachments.rows,
      mutations: mutations.rows,
      outbox: outbox.rows,
      idempotency: idempotency.rows,
      ...(options.previewRepair ? { repairPreview: repairPreview(row) } : {}),
    };
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main() {
  const options = parseMessageInspectionOptions(process.argv.slice(2));
  const connectionString = process.env.POSTGRES_DATABASE_URL?.trim();
  if (!connectionString) throw new Error("POSTGRES_DATABASE_URL is required");
  const client = new Client({ connectionString, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    process.stdout.write(`${JSON.stringify(await inspectPostgresMessage(client, options), null, 2)}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
