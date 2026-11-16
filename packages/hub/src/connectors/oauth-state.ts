import { hmacBytes, timingSafeEqual } from "@xmatrix/protocol";
import { base64UrlDecodeBytes, base64UrlEncodeValue } from "../relay-v2-primitives";

/*
 * A connector's signed OAuth state is `<payload>.<HMAC-SHA256 payload>`. The
 * payload is the claims as a deflate-raw-compressed, positionally encoded
 * array, which keeps a full connect state inside the provider's limit: X
 * refuses an authorize request whose `state` is longer than 500 characters
 * with `invalid_request` before consent, while the plain JSON payload (Space,
 * admin, PKCE and connection snapshot claims) is roughly 700.
 *
 * States minted in the older plain-JSON payload still verify until they
 * expire, so a release does not strand a flow that is already in a browser.
 */
const COMPACT_VERSION = "z";
const MAX_STATE_LENGTH = 4_096;
/* A deflate stream can expand ~1,000x; refuse anything that would allocate more. */
const MAX_INFLATED_BYTES = 16 * 1_024;

/** Fixed positions: both ends read this list rather than the object's key order. */
const CLAIM_ORDER = ["providerId", "spaceId", "userId", "nonce", "expiresAt", "clientId", "redirectUri",
  "authorizationStartedAt", "accountId"] as const;
const SNAPSHOT_ORDER = ["connectionVersion", "credentialVersion", "connectionGeneration"] as const;
const KNOWN_CLAIMS = new Set<string>([...CLAIM_ORDER, "connectionSnapshot"]);
const KNOWN_SNAPSHOT = new Set<string>(SNAPSHOT_ORDER);
/* One version slot, the claims, the snapshot, then any unnamed snapshot and claim fields. */
const ARRAY_LENGTH = CLAIM_ORDER.length + 6;

function unnamed(value: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
}

function compact(value: Record<string, unknown>): Record<string, unknown> | null {
  return Object.keys(value).length > 0 ? value : null;
}

/** Claims as one array; a field this file does not name still travels, in a trailing slot. */
function claimsToArray(claims: Record<string, unknown>): unknown[] {
  const snapshot = typeof claims.connectionSnapshot === "object" && claims.connectionSnapshot !== null
    ? claims.connectionSnapshot as Record<string, unknown> : undefined;
  return [
    COMPACT_VERSION,
    ...CLAIM_ORDER.map(key => claims[key] ?? null),
    ...(snapshot ? SNAPSHOT_ORDER.map(key => snapshot[key] ?? null) : [null, null, null]),
    snapshot ? compact(unnamed(snapshot, KNOWN_SNAPSHOT)) : null,
    compact(unnamed(claims, KNOWN_CLAIMS)),
  ];
}

function arrayToClaims(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value) || value.length !== ARRAY_LENGTH || value[0] !== COMPACT_VERSION) return undefined;
  const claims: Record<string, unknown> = {};
  const rest = value.at(-1);
  if (typeof rest === "object" && rest !== null) Object.assign(claims, rest);
  CLAIM_ORDER.forEach((key, index) => { if (value[index + 1] !== null) claims[key] = value[index + 1]; });
  const snapshot: Record<string, unknown> = {};
  const snapshotExtra = value.at(-2);
  if (typeof snapshotExtra === "object" && snapshotExtra !== null) Object.assign(snapshot, snapshotExtra);
  SNAPSHOT_ORDER.forEach((key, index) => {
    const stored = value[CLAIM_ORDER.length + 1 + index];
    if (stored !== null) snapshot[key] = stored;
  });
  if (Object.keys(snapshot).length > 0) claims.connectionSnapshot = snapshot;
  return claims;
}

/** A Blob over an owned ArrayBuffer: `Uint8Array` may be backed by shared memory, which Blob refuses. */
function blobOf(bytes: Uint8Array): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer]);
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = blobOf(bytes).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  const reader = blobOf(bytes).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read().catch(() => undefined);
    if (!chunk || chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_INFLATED_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(chunk.value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return joined;
}

function isCompact(payload: string): boolean {
  return payload.startsWith(COMPACT_VERSION);
}

async function decodeCompact(payload: string): Promise<Record<string, unknown> | undefined> {
  try {
    const inflated = await inflateRaw(base64UrlDecodeBytes(payload.slice(COMPACT_VERSION.length)));
    return inflated && arrayToClaims(JSON.parse(new TextDecoder().decode(inflated)));
  } catch {
    return undefined;
  }
}

function decodeJson(payload: string): Record<string, unknown> | undefined {
  try {
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(payload))) as unknown;
    return typeof claims === "object" && claims !== null && !Array.isArray(claims) ? claims as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Sign the claims of one connect flow into the provider's `state` parameter. */
export async function signOAuthState(claims: Record<string, unknown>, secret: string): Promise<string> {
  const payload = COMPACT_VERSION +
    base64UrlEncodeValue(await deflateRaw(new TextEncoder().encode(JSON.stringify(claimsToArray(claims)))));
  return `${payload}.${base64UrlEncodeValue(await hmacBytes("SHA-256", secret, payload))}`;
}

/** The provider a state was minted for, read before its signature can be checked. */
export async function oauthStateProviderId(state: string): Promise<string> {
  const payload = state.split(".")[0] ?? "";
  const claims = isCompact(payload) ? await decodeCompact(payload) : decodeJson(payload);
  return typeof claims?.providerId === "string" ? claims.providerId : "";
}

/** The claims this Hub signed for a connector flow; undefined when forged, malformed or expired. */
export async function verifyOAuthStateClaims(state: string, secret: string): Promise<Record<string, unknown> | undefined> {
  if (!state || state.length > MAX_STATE_LENGTH) return undefined;
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return undefined;
  const expected = `${payload}.${base64UrlEncodeValue(await hmacBytes("SHA-256", secret, payload))}`;
  if (!timingSafeEqual(expected, state)) return undefined;
  const claims = isCompact(payload) ? await decodeCompact(payload) : decodeJson(payload);
  if (!claims) return undefined;
  const expiresAt = typeof claims.expiresAt === "number" ? claims.expiresAt : 0;
  return expiresAt >= Date.now() ? claims : undefined;
}
