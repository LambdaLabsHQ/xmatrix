import { utf8ByteLength } from "@xmatrix/protocol";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export function relayControlPlaneBoundedText(
  value: unknown,
  field: string,
  maximumBytes = 200,
): string {
  if (typeof value !== "string") throw new Error(`${field} is invalid`);
  const normalized = value.trim();
  if (!normalized || utf8ByteLength(normalized) > maximumBytes) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

/** Bounded-value primitives for the Channel coordinator's stored identities. */
export function relayControlPlaneIntegerAtLeast(
  value: unknown,
  minimum: number,
  field: string,
): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(value) || numeric < minimum) throw new Error(`${field} is invalid`);
  return numeric;
}

export function relayControlPlaneDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}
