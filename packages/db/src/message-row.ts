import type { QueryResultRow } from "pg";

/** A stored message's columns, as the message authority reads them. */
export interface MessageRow extends QueryResultRow {
  message_id: string;
  channel_id: string;
  timeline_sequence: string | number;
  entity_version: string | number;
  author_kind: string;
  author_id: string;
  message_kind: string;
  content_hash: string;
  payload_kind: string;
  payload_ref: string;
  reactions_json: unknown[];
  annotations_json: unknown[];
  attachments_json: unknown[];
  sent_at: Date | string;
  edited_at: Date | string | null;
  recalled_at: Date | string | null;
  deleted_at: Date | string | null;
  updated_at: Date | string;
  search_rank_sequence: string;
  codec_id: string | null;
  payload_schema_version: number | null;
  field_presence_base64: string | null;
  payload_bundle_base64: string | null;
  body_hash: string | null;
  sender_snapshot_digest: string | null;
  record_digest: string | null;
  record_encoded_bytes: string | number | null;
}

/**
 * A stored message's facts on the wire. `iso` writes its timestamps, failing
 * with the reading authority's own error when PostgreSQL returns an invalid one.
 */
export function serializeMessageRow(row: MessageRow,
  iso: (value: Date | string | null) => string | null): Record<string, unknown> {
  return {
    messageId: row.message_id,
    channelId: row.channel_id,
    sequence: Number(row.timeline_sequence),
    entityVersion: Number(row.entity_version),
    senderKind: row.author_kind,
    senderId: row.author_id,
    messageKind: row.message_kind,
    contentHash: row.content_hash,
    payloadKind: row.payload_kind,
    payloadRef: row.payload_ref,
    reactions: row.reactions_json,
    annotations: row.annotations_json,
    attachments: row.attachments_json,
    sentAt: iso(row.sent_at),
    editedAt: iso(row.edited_at),
    recalledAt: iso(row.recalled_at),
    deletedAt: iso(row.deleted_at),
    updatedAt: iso(row.updated_at),
    searchRankSeq: row.search_rank_sequence,
    codecId: row.codec_id,
    payloadSchemaVersion: row.payload_schema_version,
    fieldPresenceBase64: row.field_presence_base64,
    payloadBundleBase64: row.payload_bundle_base64,
    bodyHash: row.body_hash,
    senderSnapshotDigest: row.sender_snapshot_digest,
    recordDigest: row.record_digest,
    recordEncodedBytes: row.record_encoded_bytes === null ? null : Number(row.record_encoded_bytes),
  };
}
