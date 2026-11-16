import { ControlError } from "@xmatrix/db";
import { immutableContentObjectKey, ResumableSha256 } from "@xmatrix/protocol";
import {
  RELAY_V2_BLOB_PART_BYTES,
  relayV2BlobPartCount,
} from "@xmatrix/protocol/relay-v2/message-attachment";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const INTENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/u;

export const RELAY_R2_UPLOAD_GATEWAY_DEFAULT_PATH = "/api/relay-v2/private-r2/upload";
export const RELAY_R2_UPLOAD_CHECKSUM_HEADER = "x-xmatrix-content-sha256";

export type RelayR2UploadGatewayErrorCode =
  | "method_not_allowed"
  | "invalid_request"
  | "not_authorized"
  | "object_conflict"
  | "multipart_required"
  | "multipart_part_conflict"
  | "content_mismatch"
  | "storage_unavailable";

export class RelayR2UploadGatewayError extends ControlError {
  declare readonly code: RelayR2UploadGatewayErrorCode;
  override name = "RelayR2UploadGatewayError";
  constructor(code: RelayR2UploadGatewayErrorCode, status: number, message: string, retryable = false) {
    super(code, status, message, retryable);
  }
}

export interface RelayR2LiveUploadIntentContext {
  intentId: string;
  visibilityScopeId: string;
  contentHash: string;
  checksumSha256: string;
  encodedSize: number;
  finalKey: string;
  expiresAt: number;
  state: "pending";
  allowStaging: boolean;
  /** The intent's multipart upload, once started. */
  multipart?: RelayR2MultipartState;
}

/** What the content authority recorded of an intent's multipart upload. */
export interface RelayR2MultipartState {
  uploadId: string;
  partBytes: number;
  /** R2 ETags of the parts recorded so far, in part order. */
  etags: readonly string[];
  /** SHA-256 state after the recorded parts; after the last one, the whole body's digest. */
  sha256State: string | null;
}

/** Records multipart progress on the live intent (content authority). */
export interface RelayR2MultipartProgress {
  /** Records `uploadId`, or returns the upload another request recorded first. */
  begin(uploadId: string, partBytes: number): Promise<RelayR2MultipartState>;
  record(uploadId: string, partNumber: number, etag: string, sha256State: string): Promise<RelayR2MultipartState>;
  reset(uploadId: string): Promise<void>;
}

/** Where a multipart upload stands, as its client is told. */
export interface RelayR2MultipartStatus {
  partBytes: number;
  partCount: number;
  uploadedParts: number;
  /** The immutable object already exists: commit the intent without sending more. */
  complete: boolean;
}

export interface RelayR2StoredUploadMetadata {
  size: number;
  checksumSha256: string;
  etag: string;
  customMetadata: Readonly<Record<string, string>>;
}

export interface RelayR2ConditionalWriteResult {
  outcome: "created" | "exists";
  metadata: RelayR2StoredUploadMetadata;
}

/** A deliberately narrow private bucket port. It cannot create Authority references or list objects. */
export interface RelayPrivateR2UploadPort {
  head(key: string): Promise<RelayR2StoredUploadMetadata | null>;
  putIfAbsent(
    key: string,
    body: ReadableStream<Uint8Array> | ArrayBuffer,
    input: {
      contentLength: number;
      checksumSha256: string;
      customMetadata: Readonly<Record<string, string>>;
    },
  ): Promise<RelayR2ConditionalWriteResult>;
  copyIfAbsent(
    sourceKey: string,
    destinationKey: string,
    input: {
      sourceEtag: string;
      checksumSha256: string;
      customMetadata: Readonly<Record<string, string>>;
    },
  ): Promise<RelayR2ConditionalWriteResult>;
  deleteIfEtag(key: string, etag: string): Promise<void>;
  /** Starts an R2 multipart upload to `key`; nothing is visible there until it completes. */
  createMultipart(key: string, customMetadata: Readonly<Record<string, string>>): Promise<string>;
  /** Streams one part of exactly `length` bytes; returns its ETag. */
  uploadPart(key: string, uploadId: string, partNumber: number,
    body: ReadableStream<Uint8Array>, length: number): Promise<string>;
  /** Publishes the parts, in order, as the object at `key`. */
  completeMultipart(key: string, uploadId: string, etags: readonly string[]): Promise<RelayR2StoredUploadMetadata>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

export interface RelayR2VerifiedUpload {
  intentId: string;
  visibilityScopeId: string;
  objectKey: string;
  contentHash: string;
  encodedSize: number;
  checksumSha256: string;
  etag: string;
  disposition: "created" | "existing";
}

function fail(code: RelayR2UploadGatewayErrorCode, status: number, message: string, retryable = false): never {
  throw new RelayR2UploadGatewayError(code, status, message, retryable);
}

function validatePath(request: Request, gatewayPath: string): void {
  if (!gatewayPath.startsWith("/") || gatewayPath.includes("?") || gatewayPath.includes("#")) {
    fail("invalid_request", 500, "upload gateway route is misconfigured");
  }
  const url = new URL(request.url);
  if (url.pathname !== gatewayPath || url.search !== "") fail("invalid_request", 404, "upload route not found");
}

function parseContentLength(request: Request): number {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^(0|[1-9][0-9]*)$/u.test(raw)) {
    fail("invalid_request", 411, "one exact Content-Length is required");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail("invalid_request", 400, "invalid Content-Length");
  return value;
}

function expectedCustomMetadata(intent: RelayR2LiveUploadIntentContext): Readonly<Record<string, string>> {
  return Object.freeze({
    "xmatrix-content-hash": intent.contentHash,
    "xmatrix-encoded-size": String(intent.encodedSize),
  });
}

function sameCustomMetadata(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key])
  );
}

function validateMetadata(
  metadata: RelayR2StoredUploadMetadata,
  intent: RelayR2LiveUploadIntentContext,
  expected: Readonly<Record<string, string>>,
): void {
  if (
    metadata.size !== intent.encodedSize ||
    metadata.checksumSha256 !== intent.checksumSha256 ||
    metadata.checksumSha256 !== intent.contentHash ||
    typeof metadata.etag !== "string" ||
    metadata.etag.length === 0 ||
    !sameCustomMetadata(metadata.customMetadata, expected)
  ) {
    fail("object_conflict", 409, "immutable object metadata conflicts with the upload intent");
  }
}

function validateIntent(
  intent: RelayR2LiveUploadIntentContext,
  visibilityScopeId: string,
  now: number,
): void {
  if (
    !INTENT_ID_PATTERN.test(intent.intentId) ||
    intent.visibilityScopeId.length === 0 ||
    intent.visibilityScopeId.length > 512 ||
    !SHA256_PATTERN.test(intent.contentHash) ||
    !SHA256_PATTERN.test(intent.checksumSha256) ||
    intent.contentHash !== intent.checksumSha256 ||
    !Number.isSafeInteger(intent.encodedSize) ||
    intent.encodedSize < 0 ||
    !Number.isSafeInteger(intent.expiresAt) ||
    intent.state !== "pending" ||
    intent.finalKey !== immutableContentObjectKey(intent.visibilityScopeId, intent.contentHash)
  ) {
    fail("not_authorized", 403, "invalid upload intent");
  }
  if (visibilityScopeId !== intent.visibilityScopeId) fail("not_authorized", 403, "upload scope mismatch");
  if (!Number.isSafeInteger(now) || now >= intent.expiresAt) fail("not_authorized", 401, "upload intent expired");
}

function stagingKey(intent: RelayR2LiveUploadIntentContext): string {
  return `staging/${intent.intentId}/payload`;
}

async function safeHead(
  bucket: RelayPrivateR2UploadPort,
  key: string,
): Promise<RelayR2StoredUploadMetadata | null> {
  try {
    return await bucket.head(key);
  } catch {
    fail("storage_unavailable", 503, "private object storage is unavailable", true);
  }
}

function verified(
  intent: RelayR2LiveUploadIntentContext,
  metadata: RelayR2StoredUploadMetadata,
  disposition: RelayR2VerifiedUpload["disposition"],
): RelayR2VerifiedUpload {
  return Object.freeze({
    intentId: intent.intentId,
    visibilityScopeId: intent.visibilityScopeId,
    objectKey: intent.finalKey,
    contentHash: intent.contentHash,
    encodedSize: intent.encodedSize,
    checksumSha256: intent.checksumSha256,
    etag: metadata.etag,
    disposition,
  });
}

/**
 * Executes a conditional private upload and returns only verified metadata.
 * Authority must independently revalidate and consume the live intent when committing a reference.
 */
export async function executeRelayR2UploadGatewayRequest(input: {
  request: Request;
  gatewayPath?: string;
  now: number;
  visibilityScopeId: string;
  intent: RelayR2LiveUploadIntentContext;
  mode?: "direct" | "staging";
  bucket: RelayPrivateR2UploadPort;
}): Promise<RelayR2VerifiedUpload> {
  if (input.request.method !== "PUT") fail("method_not_allowed", 405, "upload gateway accepts only PUT");
  validatePath(input.request, input.gatewayPath ?? RELAY_R2_UPLOAD_GATEWAY_DEFAULT_PATH);
  validateIntent(input.intent, input.visibilityScopeId, input.now);
  const length = parseContentLength(input.request);
  if (length !== input.intent.encodedSize) fail("not_authorized", 403, "encoded size does not match intent");
  const checksum = input.request.headers.get(RELAY_R2_UPLOAD_CHECKSUM_HEADER);
  if (checksum !== input.intent.checksumSha256) fail("not_authorized", 403, "checksum does not match intent");
  if (input.request.body === null) fail("invalid_request", 400, "upload body is required");

  const customMetadata = expectedCustomMetadata(input.intent);
  const mode = input.mode ?? "direct";
  if (mode === "staging" && !input.intent.allowStaging) fail("not_authorized", 403, "staging is not authorized");
  const existing = await safeHead(input.bucket, input.intent.finalKey);
  if (existing !== null) {
    validateMetadata(existing, input.intent, customMetadata);
    if (mode === "staging") {
      const temporaryKey = stagingKey(input.intent);
      const staged = await safeHead(input.bucket, temporaryKey);
      if (staged !== null) {
        validateMetadata(staged, input.intent, customMetadata);
        await input.bucket.deleteIfEtag(temporaryKey, staged.etag);
      }
    }
    return verified(input.intent, existing, "existing");
  }

  try {
    if (mode === "direct") {
      const result = await input.bucket.putIfAbsent(input.intent.finalKey, input.request.body, {
        contentLength: length,
        checksumSha256: checksum,
        customMetadata,
      });
      validateMetadata(result.metadata, input.intent, customMetadata);
      return verified(input.intent, result.metadata, result.outcome === "created" ? "created" : "existing");
    }

    const temporaryKey = stagingKey(input.intent);
    const staged = await input.bucket.putIfAbsent(temporaryKey, input.request.body, {
      contentLength: length,
      checksumSha256: checksum,
      customMetadata,
    });
    validateMetadata(staged.metadata, input.intent, customMetadata);
    const finalized = await input.bucket.copyIfAbsent(temporaryKey, input.intent.finalKey, {
      sourceEtag: staged.metadata.etag,
      checksumSha256: checksum,
      customMetadata,
    });
    validateMetadata(finalized.metadata, input.intent, customMetadata);
    await input.bucket.deleteIfEtag(temporaryKey, staged.metadata.etag);
    return verified(input.intent, finalized.metadata, finalized.outcome === "created" ? "created" : "existing");
  } catch (error) {
    if (error instanceof RelayR2UploadGatewayError) throw error;
    fail("storage_unavailable", 503, "private object storage is unavailable", true);
  }
}

/** A storage call; anything but the gateway's own refusal is storage being unavailable. */
async function storage<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RelayR2UploadGatewayError || error instanceof ControlError) throw error;
    fail("storage_unavailable", 503, "private object storage is unavailable", true);
  }
}

function multipartStatus(
  intent: RelayR2LiveUploadIntentContext,
  state: RelayR2MultipartState,
  complete = false,
): RelayR2MultipartStatus {
  return {
    partBytes: state.partBytes,
    partCount: relayV2BlobPartCount(intent.encodedSize, state.partBytes),
    uploadedParts: state.etags.length,
    complete,
  };
}

/** The immutable object, when it already exists with exactly the intent's bytes. */
async function existingObject(
  bucket: RelayPrivateR2UploadPort,
  intent: RelayR2LiveUploadIntentContext,
): Promise<RelayR2StoredUploadMetadata | null> {
  const existing = await safeHead(bucket, intent.finalKey);
  if (existing) validateMetadata(existing, intent, expectedCustomMetadata(intent));
  return existing;
}

/** Drops the intent's own multipart upload once it can never complete, or is not needed. */
async function abandonMultipart(
  bucket: RelayPrivateR2UploadPort,
  progress: RelayR2MultipartProgress,
  intent: RelayR2LiveUploadIntentContext,
  uploadId: string,
): Promise<void> {
  // An upload R2 already completed or expired has nothing left to abort.
  await bucket.abortMultipart(intent.finalKey, uploadId).catch(() => undefined);
  await progress.reset(uploadId);
}

/**
 * Starts, or resumes, the multipart upload of an intent's body. The parts go
 * straight to R2 under the intent's content-addressed key: R2 shows nothing
 * there until the upload completes, which happens only after every part was
 * hashed on its way through and the digest matched the intent.
 */
export async function startRelayR2Multipart(input: {
  now: number;
  visibilityScopeId: string;
  intent: RelayR2LiveUploadIntentContext;
  bucket: RelayPrivateR2UploadPort;
  progress: RelayR2MultipartProgress;
  partBytes?: number;
}): Promise<RelayR2MultipartStatus> {
  validateIntent(input.intent, input.visibilityScopeId, input.now);
  const partBytes = input.partBytes ?? RELAY_V2_BLOB_PART_BYTES;
  if (await existingObject(input.bucket, input.intent)) {
    const recorded = input.intent.multipart;
    if (recorded) await abandonMultipart(input.bucket, input.progress, input.intent, recorded.uploadId);
    return { partBytes, partCount: relayV2BlobPartCount(input.intent.encodedSize, partBytes),
      uploadedParts: 0, complete: true };
  }
  if (input.intent.multipart) return multipartStatus(input.intent, input.intent.multipart);
  const uploadId = await storage(() =>
    input.bucket.createMultipart(input.intent.finalKey, expectedCustomMetadata(input.intent)));
  const recorded = await input.progress.begin(uploadId, partBytes);
  if (recorded.uploadId !== uploadId) {
    await input.bucket.abortMultipart(input.intent.finalKey, uploadId).catch(() => undefined);
  }
  return multipartStatus(input.intent, recorded);
}

/**
 * Streams part `partNumber` into R2 while carrying the body's SHA-256 on from
 * the parts before it. Parts go in order, each exactly the agreed size (the
 * last one the rest). The last part must complete the intent's digest, or the
 * whole upload is dropped and has to start again. A part already recorded is
 * not sent again: its replay answers with the recorded progress.
 */
export async function uploadRelayR2MultipartPart(input: {
  request: Request;
  now: number;
  visibilityScopeId: string;
  intent: RelayR2LiveUploadIntentContext;
  partNumber: number;
  bucket: RelayPrivateR2UploadPort;
  progress: RelayR2MultipartProgress;
}): Promise<RelayR2MultipartStatus> {
  if (input.request.method !== "PUT") fail("method_not_allowed", 405, "upload parts accept only PUT");
  validateIntent(input.intent, input.visibilityScopeId, input.now);
  const multipart = input.intent.multipart;
  if (!multipart) fail("multipart_required", 409, "start the multipart upload before sending parts");
  const partCount = relayV2BlobPartCount(input.intent.encodedSize, multipart.partBytes);
  const partNumber = input.partNumber;
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
    fail("invalid_request", 400, `part number must be from 1 to ${partCount}`);
  }
  const length = partNumber < partCount
    ? multipart.partBytes
    : input.intent.encodedSize - multipart.partBytes * (partCount - 1);
  if (parseContentLength(input.request) !== length) {
    fail("invalid_request", 400, `part ${partNumber} must be exactly ${length} bytes`);
  }
  const recorded = multipart.etags.length;
  if (partNumber <= recorded) {
    await input.request.body?.cancel().catch(() => undefined);
    return multipartStatus(input.intent, multipart);
  }
  if (partNumber !== recorded + 1) {
    fail("multipart_part_conflict", 409, `part ${partNumber} is out of order; send part ${recorded + 1}`);
  }
  if (input.request.body === null) fail("invalid_request", 400, "upload body is required");
  if (recorded > 0 && multipart.sha256State === null) fail("object_conflict", 409, "multipart digest state is missing");
  const digest = recorded === 0
    ? new ResumableSha256()
    : new ResumableSha256({ state: multipart.sha256State!, processedBytes: recorded * multipart.partBytes });
  const hashed = input.request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      digest.update(chunk);
      controller.enqueue(chunk);
    },
  }));
  const etag = await storage(() =>
    input.bucket.uploadPart(input.intent.finalKey, multipart.uploadId, partNumber, hashed, length));
  if (digest.bytes !== (partNumber - 1) * multipart.partBytes + length) {
    fail("invalid_request", 400, `part ${partNumber} did not carry exactly ${length} bytes`);
  }
  let state: string;
  if (partNumber === partCount) {
    state = digest.digest();
    if (state !== input.intent.contentHash) {
      await abandonMultipart(input.bucket, input.progress, input.intent, multipart.uploadId);
      fail("content_mismatch", 409, "the uploaded bytes do not match the intent's SHA-256; upload the file again");
    }
  } else {
    state = digest.save();
  }
  return multipartStatus(input.intent,
    await input.progress.record(multipart.uploadId, partNumber, etag, state));
}

/**
 * Publishes a multipart upload whose every part was recorded, and so whose
 * digest already matched, as the intent's immutable object. A repeated call
 * after a lost answer finds the object and returns it.
 */
export async function completeRelayR2Multipart(input: {
  now: number;
  visibilityScopeId: string;
  intent: RelayR2LiveUploadIntentContext;
  bucket: RelayPrivateR2UploadPort;
  progress: RelayR2MultipartProgress;
}): Promise<RelayR2VerifiedUpload> {
  validateIntent(input.intent, input.visibilityScopeId, input.now);
  const multipart = input.intent.multipart;
  const existing = await existingObject(input.bucket, input.intent);
  if (existing) {
    if (multipart) await abandonMultipart(input.bucket, input.progress, input.intent, multipart.uploadId);
    return verified(input.intent, existing, "existing");
  }
  if (!multipart) fail("multipart_required", 409, "start the multipart upload before completing it");
  const partCount = relayV2BlobPartCount(input.intent.encodedSize, multipart.partBytes);
  if (multipart.etags.length !== partCount || multipart.sha256State !== input.intent.contentHash) {
    fail("multipart_part_conflict", 409,
      `${multipart.etags.length} of ${partCount} parts are uploaded; send part ${multipart.etags.length + 1}`);
  }
  const metadata = await storage(() =>
    input.bucket.completeMultipart(input.intent.finalKey, multipart.uploadId, multipart.etags));
  validateMetadata(metadata, input.intent, expectedCustomMetadata(input.intent));
  return verified(input.intent, metadata, "created");
}
