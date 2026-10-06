import { requireLowercaseSha256, requireSafeIntegerRange } from "../field-validation.js";
import { utf8ByteLength } from "../hex.js";
import type { ProjectionObjectRef } from "./projection.js";
/** Product UX media read-through companion to Authority channel-history (no Local Replica required). */
export const RELAY_V2_MESSAGE_ATTACHMENT_PRODUCT_MEDIA_PATH =
  "/api/relay-v2/message-attachments/product-media" as const;
export const RELAY_V2_BLOB_UPLOAD_INTENT_PATH =
  "/api/relay-v2/private-r2/upload-intents" as const;
export const RELAY_V2_BLOB_UPLOAD_PREFIX =
  "/api/relay-v2/private-r2/uploads" as const;
export const RELAY_V2_BLOB_REF_PATH =
  "/api/relay-v2/private-r2/blob-refs" as const;
export const RELAY_V2_BLOB_UPLOAD_CHECKSUM_HEADER =
  "x-xmatrix-content-sha256" as const;
/** Ordinary product write ceiling; the larger read ceiling covers migrated history. */
export const RELAY_V2_MESSAGE_ATTACHMENT_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const RELAY_V2_MESSAGE_ATTACHMENT_MAX_BYTES = 1024 * 1024 * 1024;

export interface RelayV2MessageAttachmentDescriptor {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  version: number;
  durationMs?: number;
  width?: number;
  height?: number;
  /** Open presentation state; consumers must tolerate future values. */
  transcodingStatus?: string;
}

/** Canonical metadata selected by Authority; no client-provided object coordinates are accepted. */
export interface RelayV2MessageAttachmentAuthority {
  attachment: RelayV2MessageAttachmentDescriptor;
  object: ProjectionObjectRef;
}

export class RelayV2MessageAttachmentProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RelayV2MessageAttachmentProtocolError";
  }
}

function fail(code: string, message: string): never {
  throw new RelayV2MessageAttachmentProtocolError(code, message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_envelope", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFieldsWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
      keys.some((key) => !allowed.has(key))) {
    fail("invalid_envelope", `${field} contains missing or unexpected fields`);
  }
}

function boundedString(value: unknown, field: string, maxBytes = 200): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    utf8ByteLength(value) > maxBytes || /\p{Cc}/u.test(value)
  ) {
    fail("invalid_envelope", `${field} is invalid`);
  }
  return value;
}

function integer(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  return requireSafeIntegerRange(value, minimum, maximum, () =>
    new RelayV2MessageAttachmentProtocolError("invalid_envelope", `${field} is outside its allowed range`));
}

function sha256(value: unknown, field: string): string {
  return requireLowercaseSha256(value, () =>
    new RelayV2MessageAttachmentProtocolError("invalid_envelope", `${field} must be a lowercase SHA-256 digest`));
}

const ATTACHMENT_PRESENTATION_FIELDS = [
  "durationMs", "height", "transcodingStatus", "width",
] as const;

function parseAttachmentPresentation(
  value: Record<string, unknown>,
  field: string,
): Pick<RelayV2MessageAttachmentDescriptor,
  "durationMs" | "height" | "transcodingStatus" | "width"> {
  return {
    ...(Object.prototype.hasOwnProperty.call(value, "durationMs")
      ? { durationMs: integer(value.durationMs, `${field}.durationMs`) } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "width")
      ? { width: integer(value.width, `${field}.width`, 1) } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "height")
      ? { height: integer(value.height, `${field}.height`, 1) } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "transcodingStatus")
      ? { transcodingStatus: boundedString(
          value.transcodingStatus,
          `${field}.transcodingStatus`,
          128,
        ) }
      : {}),
  };
}

/**
 * Parses the exact metadata-only Authority authority shape. Projection importers
 * normalize their verified payload records to this shape before persisting it.
 */
export function parseRelayV2MessageAttachmentAuthority(
  value: unknown,
): RelayV2MessageAttachmentAuthority {
  const input = record(value, "attachment authority");
  exactFieldsWithOptional(input, [
    "contentHash",
    "id",
    "mimeType",
    "name",
    "objectKey",
    "size",
    "version",
  ], ATTACHMENT_PRESENTATION_FIELDS, "attachment authority");
  const contentHash = sha256(input.contentHash, "attachment authority.contentHash");
  const objectKey = boundedString(input.objectKey, "attachment authority.objectKey", 512);
  const attachment: RelayV2MessageAttachmentDescriptor = {
    id: boundedString(input.id, "attachment authority.id"),
    name: boundedString(input.name, "attachment authority.name", 512),
    mimeType: boundedString(input.mimeType, "attachment authority.mimeType", 200),
    size: integer(
      input.size,
      "attachment authority.size",
      1,
      RELAY_V2_MESSAGE_ATTACHMENT_MAX_BYTES,
    ),
    version: integer(input.version, "attachment authority.version", 1),
    ...parseAttachmentPresentation(input, "attachment authority"),
  };
  if (objectKey !== `objects/${contentHash}`) {
    fail("integrity_mismatch", "message attachment authority object reference is noncanonical");
  }
  return {
    attachment,
    object: {
      objectKey,
      contentHash,
      encodedBytes: attachment.size,
      checksum: contentHash,
    },
  };
}
