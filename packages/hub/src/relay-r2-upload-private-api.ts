import { immutableContentObjectKey, lowercaseHex , utf8ByteLength } from "@xmatrix/protocol";
// Production composition for authenticated private immutable uploads.
// PostgreSQL content stores intent/ref metadata; this module owns only bounded
// request parsing and R2 I/O.
import { ControlError, PostgresContentRepository } from "@xmatrix/db";
import { domainErrorResponse, transientError } from "./error-contract";
import { createPostgresAuthorityDatabase, type PostgresAuthorityFleetEnv } from "./postgres-authority-fleet";
import {
  POSTGRES_AUTHORITY_TIMEOUTS,
  postgresAuthorityShardId,
  type PostgresAuthorityBindingEnv,
} from "./postgres-authority-http";
import {
  RELAY_R2_UPLOAD_CHECKSUM_HEADER,
  RelayR2UploadGatewayError,
  executeRelayR2UploadGatewayRequest,
  type RelayPrivateR2UploadPort,
  type RelayR2LiveUploadIntentContext,
  type RelayR2StoredUploadMetadata,
} from "./relay-r2-upload-gateway";
import { PRIVATE_JSON_HEADERS } from "./private-json-response";

const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9:_-]{1,160}$/u;
const MAX_JSON_BYTES = 8 * 1024;

export const RELAY_R2_UPLOAD_INTENT_PATH = "/api/relay-v2/private-r2/upload-intents";
export const RELAY_R2_UPLOAD_PREFIX = "/api/relay-v2/private-r2/uploads";
export const RELAY_R2_BLOB_REF_PATH = "/api/relay-v2/private-r2/blob-refs";
export const RELAY_R2_BLOB_REF_RELEASE_PATH = "/api/relay-v2/private-r2/blob-refs/release";

/** The blob intents and references the upload API records. */
export type RelayR2ContentAuthority = Pick<PostgresContentRepository,
  "createIntent" | "readIntent" | "commitRef" | "readRef" | "releaseRef">;

/** Blob intents and references live with their scope on its Space shard. */
export function relayContentRepository(env: PostgresAuthorityBindingEnv & PostgresAuthorityFleetEnv): PostgresContentRepository {
  const shardId = postgresAuthorityShardId(env, "content");
  return new PostgresContentRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-content", ...POSTGRES_AUTHORITY_TIMEOUTS,
  }), shardId);
}

export interface RelayR2UploadPrincipal {
  kind: "user" | "agent";
  id: string;
}

export class RelayR2UploadPrivateApiError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly retryable = false) {
    super(message);
    this.name = "RelayR2UploadPrivateApiError";
  }
}

type JsonRecord = Record<string, unknown>;

function fail(code: string, status: number, message: string, retryable = false): never {
  throw new RelayR2UploadPrivateApiError(code, status, message, retryable);
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request", 400, "JSON object required");
  return value as JsonRecord;
}

function exactFields(value: JsonRecord, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("invalid_request", 400, "request contains missing or unexpected fields");
  }
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) fail("invalid_request", 400, `${field} is invalid`);
  return value;
}

function bounded(value: unknown, field: string, maxBytes = 200): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || utf8ByteLength(value) > maxBytes) {
    fail("invalid_request", 400, `${field} is invalid`);
  }
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("invalid_request", 400, "contentHash is invalid");
  return value;
}

function integer(value: unknown, field: string, min = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail("invalid_request", 400, `${field} is invalid`);
  return value as number;
}

async function json(request: Request): Promise<JsonRecord> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    fail("invalid_request", 415, "Content-Type must be application/json");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_JSON_BYTES)) {
    fail("invalid_request", 413, "request body is too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_JSON_BYTES) fail("invalid_request", 413, "request body is too large");
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof RelayR2UploadPrivateApiError) throw error;
    fail("invalid_request", 400, "request body must be valid UTF-8 JSON");
  }
}

/**
 * One content authority call: its rejection keeps its code, status and retry
 * policy; any other failure is the authority being unavailable, retryable only
 * when it is a transient outage.
 */
async function contentCall(call: () => Promise<unknown>): Promise<JsonRecord> {
  let value: unknown;
  try {
    value = await call();
  } catch (error) {
    if (error instanceof ControlError) {
      fail(error.code, error.status, "blob authority rejected the request", error.retryable);
    }
    fail("authority_unavailable", 503, "blob authority is unavailable", transientError(error));
  }
  return record(value);
}

function principal(value: RelayR2UploadPrincipal): RelayR2UploadPrincipal {
  if (value.kind !== "user" && value.kind !== "agent") {
    fail("not_authorized", 403, "upload principal kind is invalid");
  }
  return { kind: value.kind, id: bounded(value.id, "principal.id") };
}

function intentContext(value: JsonRecord): RelayR2LiveUploadIntentContext & { version: number } {
  const contentHash = hash(value.contentHash);
  const objectKey = bounded(value.objectKey, "objectKey", 1024);
  if (objectKey !== immutableContentObjectKey(bounded(value.scopeId, "scopeId"), contentHash) || value.checksum !== contentHash || value.state !== "pending") {
    fail("authority_unavailable", 503, "blob authority returned a noncanonical intent");
  }
  const expiresAt = Date.parse(bounded(value.expiresAt, "expiresAt"));
  if (!Number.isSafeInteger(expiresAt)) fail("authority_unavailable", 503, "blob authority returned an invalid expiry");
  return {
    intentId: id(value.intentId, "intentId"),
    visibilityScopeId: bounded(value.scopeId, "scopeId"),
    contentHash,
    checksumSha256: contentHash,
    encodedSize: integer(value.encodedBytes, "encodedBytes"),
    finalKey: objectKey,
    expiresAt,
    state: "pending",
    allowStaging: true,
    version: integer(value.version, "version"),
  };
}

async function readIntent(
  content: RelayR2ContentAuthority,
  actor: RelayR2UploadPrincipal,
  intentId: string,
  expectedScopeId?: string,
) {
  const intent = intentContext(await contentCall(() => content.readIntent({
    requestId: crypto.randomUUID(), intentId, principal: principal(actor),
  })));
  if (expectedScopeId !== undefined && intent.visibilityScopeId !== expectedScopeId) {
    fail("not_authorized", 403, "upload intent is outside this Agent Run's channel");
  }
  return intent;
}

async function readExistingRef(
  content: RelayR2ContentAuthority,
  actor: RelayR2UploadPrincipal,
  refId: string,
): Promise<JsonRecord | null> {
  try {
    return await contentCall(() => content.readRef({ requestId: crypto.randomUUID(), refId, principal: principal(actor) }));
  } catch (error) {
    if (error instanceof RelayR2UploadPrivateApiError && error.code === "blob_ref_not_found") return null;
    throw error;
  }
}

function uploadMetadata(object: R2Object): RelayR2StoredUploadMetadata {
  const native = object.checksums?.sha256 ? lowercaseHex(object.checksums.sha256) : undefined;
  const customHash = object.customMetadata?.["xmatrix-content-hash"];
  const checksumSha256 = native ?? customHash;
  if (!checksumSha256 || !SHA256.test(checksumSha256) || (native && customHash && native !== customHash)) {
    throw new Error("R2 object has no trustworthy SHA-256 metadata");
  }
  return {
    size: object.size,
    checksumSha256,
    etag: object.etag,
    customMetadata: { ...object.customMetadata },
  };
}

export function cloudflareRelayPrivateR2UploadPort(bucket: R2Bucket): RelayPrivateR2UploadPort {
  return {
    async head(key) {
      const object = await bucket.head(key);
      return object ? uploadMetadata(object) : null;
    },
    async putIfAbsent(key, body, input) {
      // R2 returns the stored object when the conditional write wins and null
      // when another writer already created the key. Use that authoritative
      // result directly on the common path; a preflight HEAD plus a readback
      // HEAD made the UI sit on "Wrapping up" for two needless R2 round trips.
      const created = await bucket.put(key, body, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: input.checksumSha256,
        customMetadata: { ...input.customMetadata },
      });
      const stored = created ?? await bucket.head(key);
      if (!stored) throw new Error("conditional upload did not materialize");
      return { outcome: created ? "created" : "exists", metadata: uploadMetadata(stored) };
    },
    async copyIfAbsent(sourceKey, destinationKey, input) {
      const source = await bucket.get(sourceKey, { onlyIf: { etagMatches: input.sourceEtag } });
      if (!source || !("body" in source)) throw new Error("staging source changed");
      const created = await bucket.put(destinationKey, source.body, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: input.checksumSha256,
        customMetadata: { ...input.customMetadata },
      });
      const stored = created ?? await bucket.head(destinationKey);
      if (!stored) throw new Error("conditional finalization did not materialize");
      return { outcome: created ? "created" : "exists", metadata: uploadMetadata(stored) };
    },
    async deleteIfEtag(key, etag) {
      const current = await bucket.head(key);
      if (current?.etag === etag) await bucket.delete(key);
    },
  };
}

export async function handleRelayR2UploadIntentCreate(input: {
  request: Request;
  principal: RelayR2UploadPrincipal;
  expectedScopeId?: string;
  content: RelayR2ContentAuthority;
}): Promise<Response> {
  const value = await json(input.request);
  exactFields(value, ["requestId", "intentId", "visibilityScopeId", "contentHash", "encodedSize", "expiresAt"]);
  const visibilityScopeId = bounded(value.visibilityScopeId, "visibilityScopeId");
  if (input.expectedScopeId !== undefined && visibilityScopeId !== input.expectedScopeId) {
    fail("not_authorized", 403, "uploads are limited to this Agent Run's channel");
  }
  const commandId = id(value.requestId, "requestId");
  const result = await contentCall(() => input.content.createIntent({
    requestId: commandId,
    commandId,
    intentId: id(value.intentId, "intentId"),
    scopeId: visibilityScopeId,
    contentHash: hash(value.contentHash),
    encodedBytes: integer(value.encodedSize, "encodedSize"),
    expiresAt: bounded(value.expiresAt, "expiresAt"),
    principal: principal(input.principal),
  }));
  const intent = intentContext(result);
  return Response.json({
    intentId: intent.intentId,
    visibilityScopeId: intent.visibilityScopeId,
    contentHash: intent.contentHash,
    encodedSize: intent.encodedSize,
    expiresAt: new Date(intent.expiresAt).toISOString(),
    upload: {
      finalPath: `${RELAY_R2_UPLOAD_PREFIX}/${encodeURIComponent(intent.intentId)}/scope/${encodeURIComponent(intent.visibilityScopeId)}`,
      stagingPath: `${RELAY_R2_UPLOAD_PREFIX}/${encodeURIComponent(intent.intentId)}/staging/scope/${encodeURIComponent(intent.visibilityScopeId)}`,
      verifyPath: `${RELAY_R2_UPLOAD_PREFIX}/${encodeURIComponent(intent.intentId)}/verify/scope/${encodeURIComponent(intent.visibilityScopeId)}`,
      checksumHeader: RELAY_R2_UPLOAD_CHECKSUM_HEADER,
    },
  }, { headers: { "cache-control": "private, no-store" } });
}

interface IntentObjectInput {
  principal: RelayR2UploadPrincipal;
  expectedScopeId?: string;
  intentId: string;
  content: RelayR2ContentAuthority;
  bucket: R2Bucket;
}

function uploadIntent(input: IntentObjectInput): Promise<RelayR2LiveUploadIntentContext> {
  return readIntent(input.content, input.principal, id(input.intentId, "intentId"), input.expectedScopeId);
}

export async function handleRelayR2UploadPut(input: IntentObjectInput & {
  request: Request;
  mode: "direct" | "staging";
  now: number;
}): Promise<Response> {
  const intent = await uploadIntent(input);
  const verified = await executeRelayR2UploadGatewayRequest({
    request: input.request,
    gatewayPath: new URL(input.request.url).pathname,
    now: input.now,
    visibilityScopeId: intent.visibilityScopeId,
    intent,
    mode: input.mode,
    bucket: cloudflareRelayPrivateR2UploadPort(input.bucket),
  });
  return Response.json(verified, { headers: { "cache-control": "private, no-store" } });
}

async function verifyIntentObject(bucket: R2Bucket, intent: RelayR2LiveUploadIntentContext): Promise<RelayR2StoredUploadMetadata> {
  const metadata = await cloudflareRelayPrivateR2UploadPort(bucket).head(intent.finalKey);
  if (
    !metadata || metadata.size !== intent.encodedSize || metadata.checksumSha256 !== intent.contentHash ||
    metadata.customMetadata["xmatrix-content-hash"] !== intent.contentHash ||
    metadata.customMetadata["xmatrix-encoded-size"] !== String(intent.encodedSize)
  ) fail("object_not_verified", 409, "final immutable object does not match the live intent");
  return metadata;
}

export async function handleRelayR2UploadVerify(input: IntentObjectInput): Promise<Response> {
  const intent = await uploadIntent(input);
  const metadata = await verifyIntentObject(input.bucket, intent);
  return Response.json({
    intentId: intent.intentId, objectKey: intent.finalKey, contentHash: intent.contentHash,
    encodedSize: intent.encodedSize, etag: metadata.etag, verified: true,
  }, { headers: { "cache-control": "private, no-store" } });
}

export async function handleRelayR2BlobRefCommit(input: {
  request: Request;
  principal: RelayR2UploadPrincipal;
  expectedScopeId?: string;
  now: number;
  content: RelayR2ContentAuthority;
  bucket: R2Bucket;
}): Promise<Response> {
  const value = await json(input.request);
  exactFields(value, ["requestId", "intentId", "refId", "ownerKind", "ownerId", "visibilityScopeId"]);
  const refId = id(value.refId, "refId");
  const ownerKind = bounded(value.ownerKind, "ownerKind", 80);
  if (ownerKind === "summon_decision") fail("not_authorized", 403, "decision evidence is server-authored");
  const ownerId = bounded(value.ownerId, "ownerId");
  const visibilityScopeId = bounded(value.visibilityScopeId, "visibilityScopeId");
  if (input.expectedScopeId !== undefined && visibilityScopeId !== input.expectedScopeId) {
    fail("not_authorized", 403, "blob references are limited to this Agent Run's channel");
  }
  const existing = await readExistingRef(input.content, input.principal, refId);
  if (existing) {
    if (
      existing.scopeId !== visibilityScopeId || existing.ownerKind !== ownerKind ||
      existing.ownerId !== ownerId
    ) fail("blob_ref_conflict", 409, "refId was reused with another business reference");
    return Response.json(existing, { headers: { "cache-control": "private, no-store" } });
  }
  const intent = await readIntent(
    input.content,
    input.principal,
    id(value.intentId, "intentId"),
    input.expectedScopeId,
  );
  // The upload made the object exist; this ref sets who sees it. A Space-scope
  // upload may go into a Channel's scope — the authority holds it to the
  // intent's own Space — and any other upload only into its own scope.
  if (intent.visibilityScopeId !== visibilityScopeId &&
      !(intent.visibilityScopeId.startsWith("space:") && visibilityScopeId.startsWith("channel:"))) {
    fail("not_authorized", 403, "intent scope mismatch");
  }
  await verifyIntentObject(input.bucket, intent);
  const commandId = id(value.requestId, "requestId");
  const committed = await contentCall(() => input.content.commitRef({
    requestId: commandId,
    commandId,
    intentId: intent.intentId,
    expectedIntentVersion: intent.version,
    refId,
    ownerKind,
    ownerId,
    scopeId: visibilityScopeId,
    objectKey: intent.finalKey,
    checksum: intent.contentHash,
    encodedBytes: intent.encodedSize,
    verifiedAt: new Date(input.now).toISOString(),
    principal: principal(input.principal),
  }));
  return Response.json(committed, { headers: { "cache-control": "private, no-store" } });
}

export async function handleRelayR2BlobRefRelease(input: {
  request: Request;
  principal: RelayR2UploadPrincipal;
  expectedScopeId?: string;
  content: RelayR2ContentAuthority;
}): Promise<Response> {
  const value = await json(input.request);
  const fields = ["requestId", "refId", "expectedRefVersion"];
  if (value.notBefore !== undefined) fields.push("notBefore");
  if (value.visibilityScopeId !== undefined) fields.push("visibilityScopeId");
  exactFields(value, fields);
  const refId = id(value.refId, "refId");
  if (value.visibilityScopeId !== undefined &&
      bounded(value.visibilityScopeId, "visibilityScopeId") !== input.expectedScopeId) {
    fail("not_authorized", 403, "blob reference release scope mismatch");
  }
  if (input.expectedScopeId !== undefined) {
    const existing = await readExistingRef(input.content, input.principal, refId);
    if (!existing || existing.scopeId !== input.expectedScopeId) {
      fail("not_authorized", 403, "blob reference is outside this Agent Run's channel");
    }
  }
  const commandId = id(value.requestId, "requestId");
  const released = await contentCall(() => input.content.releaseRef({
    requestId: commandId,
    commandId,
    refId,
    expectedRefVersion: integer(value.expectedRefVersion, "expectedRefVersion"),
    ...(value.notBefore === undefined ? {} : { notBefore: bounded(value.notBefore, "notBefore") }),
    principal: principal(input.principal),
  }));
  return Response.json(released, { headers: { "cache-control": "private, no-store" } });
}

export function relayR2UploadPrivateApiErrorResponse(error: unknown): Response | undefined {
  if (error instanceof RelayR2UploadPrivateApiError || error instanceof RelayR2UploadGatewayError) {
    return domainErrorResponse(error, PRIVATE_JSON_HEADERS);
  }
  return undefined;
}
