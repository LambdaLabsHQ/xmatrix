import { ControlError } from "@xmatrix/db";
import { immutableContentObjectKey } from "@xmatrix/protocol";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const INTENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/u;

export const RELAY_R2_UPLOAD_GATEWAY_DEFAULT_PATH = "/api/relay-v2/private-r2/upload";
export const RELAY_R2_UPLOAD_CHECKSUM_HEADER = "x-xmatrix-content-sha256";

export type RelayR2UploadGatewayErrorCode =
  | "method_not_allowed"
  | "invalid_request"
  | "not_authorized"
  | "object_conflict"
  | "storage_unavailable";

export class RelayR2UploadGatewayError extends ControlError {
  declare readonly code: RelayR2UploadGatewayErrorCode;
  override name = "RelayR2UploadGatewayError";
  constructor(code: RelayR2UploadGatewayErrorCode, status: number, message: string) {
    super(code, status, message);
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

function fail(code: RelayR2UploadGatewayErrorCode, status: number, message: string): never {
  throw new RelayR2UploadGatewayError(code, status, message);
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
    fail("storage_unavailable", 503, "private object storage is unavailable");
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
    fail("storage_unavailable", 503, "private object storage is unavailable");
  }
}
