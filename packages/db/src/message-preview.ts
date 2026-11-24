import { postgresJsonText, utf8ByteLength } from "@xmatrix/protocol";

import { DatabaseContractError } from "./errors.js";

/**
 * What chat lists show of a message: its one-line body and its sender as they
 * were when it was written. The writer derives it from the payload it stores
 * in the same statement; it is only ever shown, never read as the message.
 */
export interface MessagePreview {
  bodyPreview: string;
  senderSnapshot: Record<string, unknown>;
}

const MAX_BODY_PREVIEW_CHARACTERS = 1_000;
const MAX_STORED_PREVIEW_BYTES = 40 * 1024;

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") return postgresJsonText(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (plainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) result[postgresJsonText(key)] = sanitizeJsonValue(entry);
    }
    return result;
  }
  return value;
}

/** A preview as it is stored: bounded JSON of exactly its two fields. */
export function storedMessagePreview(value: MessagePreview): string {
  if (!plainObject(value) || typeof value.bodyPreview !== "string" ||
      value.bodyPreview.length > MAX_BODY_PREVIEW_CHARACTERS || !plainObject(value.senderSnapshot)) {
    throw new DatabaseContractError("message preview is invalid");
  }
  const stored = JSON.stringify({
    bodyPreview: postgresJsonText(value.bodyPreview),
    senderSnapshot: sanitizeJsonValue(value.senderSnapshot),
  });
  if (utf8ByteLength(stored) > MAX_STORED_PREVIEW_BYTES) {
    throw new DatabaseContractError("message preview is too large");
  }
  return stored;
}

/** A stored preview, or null for a message written before previews were kept. */
export function readMessagePreview(value: unknown): MessagePreview | null {
  if (value === null || value === undefined) return null;
  if (!plainObject(value) || typeof value.bodyPreview !== "string" || !plainObject(value.senderSnapshot)) {
    throw new DatabaseContractError("stored message preview is invalid");
  }
  return { bodyPreview: value.bodyPreview, senderSnapshot: value.senderSnapshot };
}

/**
 * A newest-message read for a list preview: the stored preview, and the
 * payload only for a message that has none.
 */
export function messagePreviewColumnsSql(alias: string): string {
  return `${alias}.preview_json,
    CASE WHEN ${alias}.preview_json IS NULL THEN ${alias}.payload_bundle_base64 END AS payload_bundle_base64,
    CASE WHEN ${alias}.preview_json IS NULL THEN ${alias}.legacy_body END AS legacy_body`;
}
