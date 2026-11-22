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

function varintByteLength(n: number): number {
  let bytes = 1;
  let value = n >>> 0;
  while (value >= 0x80) {
    value >>>= 7;
    bytes += 1;
  }
  return bytes;
}

function v8StringMaxBytes(value: string): number {
  let hasTwoByte = false;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0xff) {
      hasTwoByte = true;
      break;
    }
  }
  if (!hasTwoByte) return 1 + varintByteLength(value.length) + value.length;
  const byteLength = value.length * 2;
  // V8 pads two-byte strings by up to 1 byte (0x00) for 2-byte alignment.
  return 2 + varintByteLength(byteLength) + byteLength;
}

/**
 * Sound upper bound on V8's `ValueSerializer` byte size for JSON-shaped
 * hibernation attachments, which is what Cloudflare Durable Objects enforce in
 * `WebSocket.serializeAttachment` (16 KiB). UTF-8 JSON length undercounts
 * strings containing any UTF-16 code unit above 0xFF (encoded as two-byte
 * UTF-16 for the whole string plus alignment padding), own `undefined`
 * properties, and boxed doubles.
 */
export function hibernationStructuredCloneMaxBytes(value: unknown): number {
  const active = new Set<object>();
  const walk = (current: unknown): number => {
    if (current === null || current === undefined || typeof current === "boolean") return 1;
    if (typeof current === "number") return 9;
    if (typeof current === "string") return v8StringMaxBytes(current);
    if (typeof current !== "object") return Number.POSITIVE_INFINITY;
    if (active.has(current)) return Number.POSITIVE_INFINITY;
    active.add(current);
    try {
      if (Array.isArray(current)) {
        let total = 1 + varintByteLength(current.length);
        for (let i = 0; i < current.length; i += 1) {
          total += walk(current[i]);
          if (!Number.isFinite(total)) return Number.POSITIVE_INFINITY;
        }
        return total + 1 + varintByteLength(0) + varintByteLength(current.length);
      }
      const keys = Object.keys(current);
      let total = 1;
      for (let i = 0; i < keys.length; i += 1) {
        total += v8StringMaxBytes(keys[i]) + walk((current as Record<string, unknown>)[keys[i]]);
        if (!Number.isFinite(total)) return Number.POSITIVE_INFINITY;
      }
      return total + 1 + varintByteLength(keys.length);
    } finally {
      active.delete(current);
    }
  };
  // 2-byte V8 ValueSerializer header (kVersion 0xFF + version).
  return 2 + walk(value);
}

export function hibernationBoundedJson(value: unknown): boolean {
  try {
    return utf8ByteLength(JSON.stringify(value)) <=
      RUNTIME_HIBERNATION_MAX_ATTACHMENT_BYTES &&
      hibernationStructuredCloneMaxBytes(value) <=
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
