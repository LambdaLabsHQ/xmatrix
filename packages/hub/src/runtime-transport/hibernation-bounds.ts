import { utf8ByteLength } from "@xmatrix/protocol";
/*
 * Cloudflare's own limit for `serializeAttachment`. A Machine Daemon session
 * carries its reported metadata (harness inventory, resources, capabilities),
 * which is 3–4 KB in production on its own, so any tighter bound made every
 * daemon frame fail to refresh its attachment.
 */
export const RUNTIME_HIBERNATION_MAX_ATTACHMENT_BYTES = 16_384;
export const RUNTIME_HIBERNATION_MAX_FIELD_BYTES = 512;
export const RUNTIME_HIBERNATION_MAX_AGE_MS = 15 * 60_000;
/** Live Cloudflare sockets may hibernate longer than the serialize TTL. */
export const RUNTIME_HIBERNATION_RESTORE_GRACE_MS = 7 * 24 * 60 * 60_000;

export function hibernationRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hibernationHasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function hibernationHasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).length === keys.length && hibernationHasOnlyKeys(value, keys);
}

export function hibernationValidDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function hibernationValidExpiry(value: unknown): value is string {
  const now = Date.now();
  const expires = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(expires) &&
    expires > now - RUNTIME_HIBERNATION_RESTORE_GRACE_MS &&
    expires <= now + RUNTIME_HIBERNATION_MAX_AGE_MS + 1_000;
}

export function hibernationBoundedString(
  value: unknown,
  maxBytes = RUNTIME_HIBERNATION_MAX_FIELD_BYTES,
): value is string {
  return typeof value === "string" && value.length > 0 &&
    utf8ByteLength(value) <= maxBytes;
}

export function hibernationBoundedJson(value: unknown): boolean {
  try {
    return utf8ByteLength(JSON.stringify(value)) <=
      RUNTIME_HIBERNATION_MAX_ATTACHMENT_BYTES;
  } catch {
    return false;
  }
}

export function nextRuntimeHibernationExpiry(): string {
  return new Date(Date.now() + RUNTIME_HIBERNATION_MAX_AGE_MS).toISOString();
}

/** Preserve only typed optional client version fields in bounded session snapshots. */
export function hibernationClientVersions(session: Record<string, unknown>): {
  clientVersion?: string;
  clientProtocolVersion?: number;
} {
  return {
    ...(typeof session.clientVersion === "string" ? { clientVersion: session.clientVersion } : {}),
    ...(typeof session.clientProtocolVersion === "number" ? { clientProtocolVersion: session.clientProtocolVersion } : {}),
  };
}
