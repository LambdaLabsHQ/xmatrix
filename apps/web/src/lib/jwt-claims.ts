export type UnverifiedJwtClaims = {
  exp?: unknown;
  sub?: unknown;
};

// This is parsing only. Callers must never treat these unverified claims as
// authentication; the Hub still verifies whichever credential is forwarded.
export function decodeUnverifiedJwtClaims(token: string): UnverifiedJwtClaims | null {
  const [, payloadSegment] = token.trim().split(".");
  if (!payloadSegment) return null;

  try {
    const padded = payloadSegment
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(payloadSegment.length / 4) * 4, "=");
    const payload = JSON.parse(globalThis.atob(padded)) as unknown;
    return payload && typeof payload === "object" ? payload as UnverifiedJwtClaims : null;
  } catch {
    return null;
  }
}
