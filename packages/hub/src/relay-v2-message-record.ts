// @ts-ignore -- Node's native TS loader requires the extension; Wrangler resolves this same source.
import { messageResidualFieldForbidden } from "./relay-message-residual-ownership.ts";
import {
  CANONICAL_CLONE_CBOR_V1_ENCODING,
  canonicalCloneFieldPresence,
  canonicalCloneLogicalRecord,
  decodeCanonicalCloneCborV1,
  digestCanonicalCloneCborV1,
  digestCanonicalCloneCborV1Bytes,
  encodeCanonicalCloneCborV1,
  type CanonicalCloneFieldPresenceEntry, utf8ByteLength } from "@xmatrix/protocol";

/**
 * The message aggregate owns exactly one payload bundle. Reactions, content
 * references and per-user attention/read state are independent facts and are
 * deliberately rejected from the residual envelope.
 */
export const RELAY_V2_MESSAGE_RECORD_CODEC_ID = CANONICAL_CLONE_CBOR_V1_ENCODING;
export const RELAY_V2_MESSAGE_PAYLOAD_SCHEMA_VERSION = 1;

const MAX_ID_BYTES = 320;
const MAX_KIND_BYTES = 128;
const MAX_SENDER_SNAPSHOT_BYTES = 32 * 1024;
const MAX_RESIDUAL_BYTES = 64 * 1024;
export const RELAY_V2_MESSAGE_INLINE_RECORD_MAX_BYTES = 160 * 1024;

const FIELD = Object.freeze({
  presence: 0,
  messageId: 1,
  channelId: 2,
  timelineSequence: 3,
  senderKind: 4,
  senderId: 5,
  messageKind: 6,
  payloadSchemaVersion: 7,
  entityVersion: 8,
  sentAt: 9,
  editedAt: 10,
  recalledAt: 11,
  deletedAt: 12,
  body: 13,
  senderSnapshot: 14,
  residual: 15,
  // 16 was used by an unreleased draft for searchRankSeq. Search rank is a
  // projection cursor, not a canonical message fact, so the field id remains
  // reserved and is intentionally absent from the record.
  reservedSearchRankSeq: 16,
} as const);

export class RelayV2MessageRecordError extends Error {
  readonly code:
    | "invalid-field"
    | "invalid-residual-owner"
    | "invalid-snapshot"
    | "record-too-large"
    | "record-integrity";

  constructor(code: RelayV2MessageRecordError["code"], message: string) {
    super(message);
    this.name = "RelayV2MessageRecordError";
    this.code = code;
  }
}

export interface RelayV2MessageRecordInput {
  messageId: string;
  channelId: string;
  timelineSequence: number;
  senderKind: string;
  senderId: string;
  /** Bounded open business kind. It is not a database enum. */
  messageKind: string;
  payloadSchemaVersion: number;
  entityVersion: number;
  sentAt: string;
  editedAt?: string | null;
  recalledAt?: string | null;
  deletedAt?: string | null;
  body: string;
  /** Immutable, sent-time display/runtime snapshot. */
  senderSnapshot: Record<string, unknown>;
  /** Only unextracted message-owned fields. */
  residual?: Record<string, unknown>;
  /** Projection-only compatibility input. It is deliberately not encoded. */
  searchRankSeq?: string;
}

export interface RelayV2MessagePayloadBundle {
  body: string;
  senderSnapshot: Record<string, unknown>;
  residual?: Record<string, unknown>;
}

export interface RelayV2MessageRichFields {
  replyToMessageId?: string;
  appMetadata?: Record<string, unknown>;
}

export function relayV2MessageRichFieldsFromBundle(
  bundle: RelayV2MessagePayloadBundle | null,
): RelayV2MessageRichFields {
  const residual = bundle?.residual;
  if (!residual) return {};
  const replyToMessageId = typeof residual.replyToMessageId === "string" &&
      residual.replyToMessageId.length > 0
    ? residual.replyToMessageId
    : undefined;
  const directAppMetadata = residual.appMetadata;
  const legacyMetadata = residual.metadata;
  const appMetadata = directAppMetadata && typeof directAppMetadata === "object" &&
      !Array.isArray(directAppMetadata)
    ? directAppMetadata as Record<string, unknown>
    : legacyMetadata && typeof legacyMetadata === "object" && !Array.isArray(legacyMetadata)
      ? {
          ...legacyMetadata as Record<string, unknown>,
          ...(Array.isArray(residual.appMentions) ? { appMentions: residual.appMentions } : {}),
        }
      : Array.isArray(residual.appMentions)
        ? { appMentions: residual.appMentions }
        : undefined;
  return {
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(appMetadata ? { appMetadata } : {}),
  };
}

export interface PreparedRelayV2MessageRecord {
  codecId: typeof RELAY_V2_MESSAGE_RECORD_CODEC_ID;
  payloadSchemaVersion: number;
  fieldPresenceBytes: Uint8Array;
  payloadBundleBytes: Uint8Array;
  bodyHash: string;
  senderSnapshotDigest: string;
  recordDigest: string;
  recordEncodedBytes: number;
}

function fail(code: RelayV2MessageRecordError["code"], message: string): never {
  throw new RelayV2MessageRecordError(code, message);
}

function boundedText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > maxBytes) {
    fail("invalid-field", `${field} must be a non-empty bounded string`);
  }
  return value;
}

function openKind(value: unknown, field: string): string {
  const kind = boundedText(value, field, MAX_KIND_BYTES);
  if (kind.normalize("NFC") !== kind || /[\p{Cc}\p{Cf}]/u.test(kind)) {
    fail("invalid-field", `${field} must be NFC text without control characters`);
  }
  return kind;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("invalid-field", `${field} must be a positive safe integer`);
  }
  return value as number;
}

function timestamp(value: unknown, field: string): string {
  const text = boundedText(value, field, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(text) ||
      !Number.isFinite(Date.parse(text))) {
    fail("invalid-field", `${field} must be a canonical UTC timestamp`);
  }
  const canonical = new Date(text).toISOString();
  const expected = text.includes(".")
    ? text.replace(/\.(\d{1,3})Z$/u, (_match, fraction: string) => `.${fraction.padEnd(3, "0")}Z`)
    : text.replace(/Z$/u, ".000Z");
  if (canonical !== expected) fail("invalid-field", `${field} is not a real UTC calendar timestamp`);
  return canonical;
}

function optionalTimestamp(
  input: RelayV2MessageRecordInput,
  field: "editedAt" | "recalledAt" | "deletedAt",
): { state: 0 | 1 | 2; value?: string | null } {
  if (!Object.prototype.hasOwnProperty.call(input, field)) return { state: 0 };
  const value = input[field];
  if (value === null) return { state: 1, value: null };
  return { state: 2, value: timestamp(value, field) };
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(field === "senderSnapshot" ? "invalid-snapshot" : "invalid-field", `${field} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(field === "senderSnapshot" ? "invalid-snapshot" : "invalid-field", `${field} must use a plain prototype`);
  }
  return value as Record<string, unknown>;
}

function assertResidualOwnership(residual: Record<string, unknown>): void {
  const duplicate = Object.keys(residual).find((field) => messageResidualFieldForbidden(field));
  if (duplicate) {
    fail("invalid-residual-owner", `residual.${duplicate} belongs to another canonical field or aggregate`);
  }
}

function presenceEntry(fieldId: number, state: 0 | 1 | 2): CanonicalCloneFieldPresenceEntry {
  return [fieldId, state];
}

async function prepareRelayV2MessageRecordWithBudget(
  input: RelayV2MessageRecordInput,
  maxRecordBytes: number,
): Promise<PreparedRelayV2MessageRecord> {
  const messageId = boundedText(input.messageId, "messageId", MAX_ID_BYTES);
  const channelId = boundedText(input.channelId, "channelId", MAX_ID_BYTES);
  const timelineSequence = positiveInteger(input.timelineSequence, "timelineSequence");
  const senderKind = openKind(input.senderKind, "senderKind");
  const senderId = boundedText(input.senderId, "senderId", MAX_ID_BYTES);
  const messageKind = openKind(input.messageKind, "messageKind");
  const payloadSchemaVersion = positiveInteger(input.payloadSchemaVersion, "payloadSchemaVersion");
  const entityVersion = positiveInteger(input.entityVersion, "entityVersion");
  const sentAt = timestamp(input.sentAt, "sentAt");
  if (typeof input.body !== "string") fail("invalid-field", "body must be a string");
  const senderSnapshot = plainRecord(input.senderSnapshot, "senderSnapshot");
  const residualPresent = Object.prototype.hasOwnProperty.call(input, "residual");
  const residual = residualPresent ? plainRecord(input.residual, "residual") : undefined;
  if (residual) assertResidualOwnership(residual);

  const senderSnapshotBytes = encodeCanonicalCloneCborV1(senderSnapshot);
  if (senderSnapshotBytes.byteLength > MAX_SENDER_SNAPSHOT_BYTES) {
    fail("invalid-snapshot", "senderSnapshot exceeds its byte budget");
  }
  const residualBytes = residual ? encodeCanonicalCloneCborV1(residual) : null;
  if (residualBytes && residualBytes.byteLength > MAX_RESIDUAL_BYTES) {
    fail("record-too-large", "message residual exceeds its byte budget");
  }

  const edited = optionalTimestamp(input, "editedAt");
  const recalled = optionalTimestamp(input, "recalledAt");
  const deleted = optionalTimestamp(input, "deletedAt");
  const presence = canonicalCloneFieldPresence([
    presenceEntry(FIELD.messageId, 2), presenceEntry(FIELD.channelId, 2),
    presenceEntry(FIELD.timelineSequence, 2), presenceEntry(FIELD.senderKind, 2),
    presenceEntry(FIELD.senderId, 2), presenceEntry(FIELD.messageKind, 2),
    presenceEntry(FIELD.payloadSchemaVersion, 2), presenceEntry(FIELD.entityVersion, 2),
    presenceEntry(FIELD.sentAt, 2), presenceEntry(FIELD.editedAt, edited.state),
    presenceEntry(FIELD.recalledAt, recalled.state), presenceEntry(FIELD.deletedAt, deleted.state),
    presenceEntry(FIELD.body, 2), presenceEntry(FIELD.senderSnapshot, 2),
    presenceEntry(FIELD.residual, residualPresent ? 2 : 0),
  ]);
  const entries: Array<readonly [number, unknown]> = [
    [FIELD.presence, presence], [FIELD.messageId, messageId], [FIELD.channelId, channelId],
    [FIELD.timelineSequence, timelineSequence], [FIELD.senderKind, senderKind],
    [FIELD.senderId, senderId], [FIELD.messageKind, messageKind],
    [FIELD.payloadSchemaVersion, payloadSchemaVersion], [FIELD.entityVersion, entityVersion],
    [FIELD.sentAt, sentAt], [FIELD.body, input.body], [FIELD.senderSnapshot, senderSnapshot],
  ];
  if (edited.state !== 0) entries.push([FIELD.editedAt, edited.value]);
  if (recalled.state !== 0) entries.push([FIELD.recalledAt, recalled.value]);
  if (deleted.state !== 0) entries.push([FIELD.deletedAt, deleted.value]);
  if (residualPresent) entries.push([FIELD.residual, residual]);

  const recordBytes = encodeCanonicalCloneCborV1(canonicalCloneLogicalRecord(entries));
  if (recordBytes.byteLength > maxRecordBytes) {
    fail("record-too-large", "canonical message record exceeds its byte budget");
  }
  const payloadBundle: RelayV2MessagePayloadBundle = {
    body: input.body,
    senderSnapshot,
    ...(residualPresent ? { residual } : {}),
  };
  return {
    codecId: RELAY_V2_MESSAGE_RECORD_CODEC_ID,
    payloadSchemaVersion,
    fieldPresenceBytes: encodeCanonicalCloneCborV1(presence),
    payloadBundleBytes: encodeCanonicalCloneCborV1(payloadBundle),
    // Clone strings are exact UTF-16 code units. Hashing TextEncoder output
    // would collapse an unpaired surrogate and U+FFFD to the same bytes.
    bodyHash: await digestCanonicalCloneCborV1(input.body),
    senderSnapshotDigest: await digestCanonicalCloneCborV1(senderSnapshot),
    recordDigest: await digestCanonicalCloneCborV1Bytes(recordBytes),
    recordEncodedBytes: recordBytes.byteLength,
  };
}

/** Prepare every digest/byte string before entering a synchronous Authority SQL transaction. */
export async function prepareRelayV2MessageRecord(
  input: RelayV2MessageRecordInput,
): Promise<PreparedRelayV2MessageRecord> {
  return prepareRelayV2MessageRecordWithBudget(input, RELAY_V2_MESSAGE_INLINE_RECORD_MAX_BYTES);
}

function decodeRelayV2MessagePayloadBundleWithBudget(
  bytes: Uint8Array,
  maxEncodedBytes: number,
): RelayV2MessagePayloadBundle {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxEncodedBytes) {
    fail("record-too-large", "message payload bundle exceeds its byte budget");
  }
  const value = decodeCanonicalCloneCborV1(bytes);
  const bundle = plainRecord(value, "payloadBundle");
  const keys = Object.keys(bundle).sort();
  const allowed = bundle.residual === undefined
    ? ["body", "senderSnapshot"]
    : ["body", "residual", "senderSnapshot"];
  if (JSON.stringify(keys) !== JSON.stringify(allowed) || typeof bundle.body !== "string") {
    fail("record-integrity", "message payload bundle fields are invalid");
  }
  const senderSnapshot = plainRecord(bundle.senderSnapshot, "senderSnapshot");
  if (encodeCanonicalCloneCborV1(senderSnapshot).byteLength > MAX_SENDER_SNAPSHOT_BYTES) {
    fail("record-integrity", "message sender snapshot exceeds its byte budget");
  }
  if (bundle.residual !== undefined) {
    const residual = plainRecord(bundle.residual, "residual");
    assertResidualOwnership(residual);
    if (encodeCanonicalCloneCborV1(residual).byteLength > MAX_RESIDUAL_BYTES) {
      fail("record-integrity", "message residual exceeds its byte budget");
    }
  }
  return bundle as unknown as RelayV2MessagePayloadBundle;
}

export function decodeRelayV2MessagePayloadBundle(bytes: Uint8Array): RelayV2MessagePayloadBundle {
  return decodeRelayV2MessagePayloadBundleWithBudget(
    bytes,
    RELAY_V2_MESSAGE_INLINE_RECORD_MAX_BYTES,
  );
}
