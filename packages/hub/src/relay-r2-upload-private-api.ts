import { immutableContentObjectKey, lowercaseHex, PAGE_MEDIA_OWNER_KIND, pageMediaRefId, utf8ByteLength } from "@xmatrix/protocol";
// Production composition for authenticated private immutable uploads.
// PostgreSQL content stores intent/ref metadata; this module owns only bounded
// request parsing and R2 I/O.
import { ControlError, PostgresContentRepository } from "@xmatrix/db";
import { ServiceUnavailable, transientError } from "./error-contract";
import { createPostgresAuthorityDatabase, type PostgresAuthorityFleetEnv } from "./postgres-authority-fleet";
import {
  POSTGRES_AUTHORITY_TIMEOUTS,
  postgresAuthorityShardId,
  type PostgresAuthorityBindingEnv,
} from "./postgres-authority-http";
import { RELAY_V2_BLOB_PART_BYTES, relayV2BlobUploadPaths } from "@xmatrix/protocol/relay-v2/message-attachment";
import {
  RELAY_R2_UPLOAD_CHECKSUM_HEADER,
  completeRelayR2Multipart,
  executeRelayR2UploadGatewayRequest,
  startRelayR2Multipart,
  uploadRelayR2MultipartPart,
  type RelayPrivateR2UploadPort,
  type RelayR2LiveUploadIntentContext,
  type RelayR2MultipartProgress,
  type RelayR2MultipartState,
  type RelayR2StoredUploadMetadata,
} from "./relay-r2-upload-gateway";

const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9:_-]{1,160}$/u;
const MAX_JSON_BYTES = 8 * 1024;

export const RELAY_R2_UPLOAD_INTENT_PATH = "/api/relay-v2/private-r2/upload-intents";
export const RELAY_R2_UPLOAD_PREFIX = "/api/relay-v2/private-r2/uploads";
export const RELAY_R2_BLOB_REF_PATH = "/api/relay-v2/private-r2/blob-refs";
export const RELAY_R2_BLOB_REF_RELEASE_PATH = "/api/relay-v2/private-r2/blob-refs/release";

/** The blob intents and references the upload API records. */
export type RelayR2ContentAuthority = Pick<PostgresContentRepository,
  "createIntent" | "readIntent" | "commitRef" | "readRef" | "releaseRef" |
  "beginMultipartUpload" | "recordMultipartPart" | "resetMultipartUpload">;

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

export class RelayR2UploadPrivateApiError extends ControlError {
  override name = "RelayR2UploadPrivateApiError";
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
 * One content authority call: its rejection keeps its code, status, reason and
 * retry policy; an outage a replay can survive is logged with its cause and
 * answered as a retryable 503; anything else is a defect and reaches the route
 * boundary unchanged, which reports it with what the route was doing.
 */
async function contentCall(call: () => Promise<unknown>): Promise<JsonRecord> {
  let value: unknown;
  try {
    value = await call();
  } catch (error) {
    if (error instanceof ControlError) fail(error.code, error.status, error.message, error.retryable);
    if (!transientError(error)) throw error;
    console.error("Attachment storage is briefly unavailable", error);
    throw new ServiceUnavailable("authority_unavailable", "Attachments are briefly unavailable; try again");
  }
  return record(value);
}

function principal(value: RelayR2UploadPrincipal): RelayR2UploadPrincipal {
  if (value.kind !== "user" && value.kind !== "agent") {
    fail("not_authorized", 403, "upload principal kind is invalid");
  }
  return { kind: value.kind, id: bounded(value.id, "principal.id") };
}

function multipartState(value: unknown): RelayR2MultipartState {
  const state = record(value);
  if (!Array.isArray(state.etags) || state.etags.some((etag) => typeof etag !== "string" || etag.length === 0) ||
      (state.sha256State !== null && (typeof state.sha256State !== "string" || !SHA256.test(state.sha256State)))) {
    throw new Error("Content authority returned an invalid multipart upload");
  }
  return {
    uploadId: bounded(state.uploadId, "uploadId", 1024),
    partBytes: integer(state.partBytes, "partBytes"),
    etags: state.etags as string[],
    sha256State: state.sha256State as string | null,
  };
}

function intentContext(value: JsonRecord): RelayR2LiveUploadIntentContext & { version: number } {
  const contentHash = hash(value.contentHash);
  const objectKey = bounded(value.objectKey, "objectKey", 1024);
  if (objectKey !== immutableContentObjectKey(bounded(value.scopeId, "scopeId"), contentHash) || value.checksum !== contentHash || value.state !== "pending") {
    throw new Error("Content authority returned a noncanonical upload intent");
  }
  const expiresAt = Date.parse(bounded(value.expiresAt, "expiresAt"));
  if (!Number.isSafeInteger(expiresAt)) throw new Error("Content authority returned an invalid upload intent expiry");
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
    ...(value.multipart === undefined ? {} : { multipart: multipartState(value.multipart) }),
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
    async createMultipart(key, customMetadata) {
      return (await bucket.createMultipartUpload(key, { customMetadata: { ...customMetadata } })).uploadId;
    },
    async uploadPart(key, uploadId, partNumber, body, length) {
      // R2 takes a stream only with a known length; the hashing pipe lost the request's.
      const fixed = new FixedLengthStream(length);
      const [part] = await Promise.all([
        bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, fixed.readable),
        body.pipeTo(fixed.writable),
      ]);
      return part.etag;
    },
    async completeMultipart(key, uploadId, etags) {
      await bucket.resumeMultipartUpload(key, uploadId)
        .complete(etags.map((etag, index) => ({ partNumber: index + 1, etag })));
      const stored = await bucket.head(key);
      if (!stored) throw new Error("completed multipart upload did not materialize");
      return uploadMetadata(stored);
    },
    async abortMultipart(key, uploadId) {
      await bucket.resumeMultipartUpload(key, uploadId).abort();
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
      finalPath: relayV2BlobUploadPaths(intent.intentId, intent.visibilityScopeId).single,
      multipartPath: relayV2BlobUploadPaths(intent.intentId, intent.visibilityScopeId).multipart,
      // A body larger than this goes in parts of exactly this size (RELAY_V2_BLOB_PART_BYTES).
      partBytes: RELAY_V2_BLOB_PART_BYTES,
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

/** The intent's multipart progress, recorded on the live intent by the content authority. */
function multipartProgress(input: IntentObjectInput): RelayR2MultipartProgress {
  const step = async (call: () => Promise<unknown>) => intentContext(await contentCall(call)).multipart;
  const command = () => ({ requestId: crypto.randomUUID(), intentId: input.intentId, principal: principal(input.principal) });
  return {
    async begin(uploadId, partBytes) {
      const state = await step(() => input.content.beginMultipartUpload({ ...command(), uploadId, partBytes }));
      if (!state) throw new Error("Content authority did not record the multipart upload");
      return state;
    },
    async record(uploadId, partNumber, etag, sha256State) {
      const state = await step(() => input.content.recordMultipartPart({
        ...command(), uploadId, partNumber, etag, sha256State,
      }));
      if (!state) throw new Error("Content authority did not record the multipart part");
      return state;
    },
    async reset(uploadId) {
      await step(() => input.content.resetMultipartUpload({ ...command(), uploadId }));
    },
  };
}

const NO_STORE = { headers: { "cache-control": "private, no-store" } } as const;

/** Starts, or resumes, an intent's multipart upload and says which part to send next. */
export async function handleRelayR2MultipartStart(input: IntentObjectInput & { now: number }): Promise<Response> {
  const intent = await uploadIntent(input);
  return Response.json(await startRelayR2Multipart({
    now: input.now, visibilityScopeId: intent.visibilityScopeId, intent,
    bucket: cloudflareRelayPrivateR2UploadPort(input.bucket), progress: multipartProgress(input),
  }), NO_STORE);
}

/** Streams one part of an intent's multipart upload into storage. */
export async function handleRelayR2MultipartPart(input: IntentObjectInput & {
  request: Request; partNumber: string; now: number;
}): Promise<Response> {
  if (!/^[1-9][0-9]{0,4}$/u.test(input.partNumber)) fail("invalid_request", 400, "part number is invalid");
  const intent = await uploadIntent(input);
  return Response.json(await uploadRelayR2MultipartPart({
    request: input.request, now: input.now, visibilityScopeId: intent.visibilityScopeId, intent,
    partNumber: Number(input.partNumber), bucket: cloudflareRelayPrivateR2UploadPort(input.bucket),
    progress: multipartProgress(input),
  }), NO_STORE);
}

/** Publishes an intent's verified parts as its immutable object. */
export async function handleRelayR2MultipartComplete(input: IntentObjectInput & { now: number }): Promise<Response> {
  const intent = await uploadIntent(input);
  return Response.json(await completeRelayR2Multipart({
    now: input.now, visibilityScopeId: intent.visibilityScopeId, intent,
    bucket: cloudflareRelayPrivateR2UploadPort(input.bucket), progress: multipartProgress(input),
  }), NO_STORE);
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
  if (["summon_decision", "connector_result"].includes(ownerKind)) fail("not_authorized", 403, "private records are server-authored");
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
  if (ownerKind === PAGE_MEDIA_OWNER_KIND && refId !== pageMediaRefId(ownerId, intent.contentHash)) {
    fail("invalid_request", 400, "Page media reference must name the uploaded content hash");
  }
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
