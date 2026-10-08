import { domainErrorResponse } from "./error-contract";
import { PRIVATE_JSON_HEADERS } from "./private-json-response";
import { readBoundedStream } from "./read-bounded-stream";
import { plainRecord } from "@xmatrix/protocol";
import {
  parseRelayV2MessageAttachmentAuthority,
  type RelayV2MessageAttachmentAuthority,
} from "@xmatrix/protocol/relay-v2/message-attachment";
// @ts-expect-error Node's native TS runner requires .ts; Wrangler resolves and validates the same source.
import { RelayR2DownloadGatewayError, type RelayPrivateR2ObjectMetadata } from "./relay-r2-download-gateway.ts";
import { lowercaseHex, utf8ByteLength } from "@xmatrix/protocol";
const decoder = new TextDecoder("utf-8", { fatal: true });
const SHA256 = /^[0-9a-f]{64}$/u;
const RELAY_R2_ATTACHMENT_AUTHORITY_MAX_BYTES = 16 * 1024;
const RELAY_PRODUCT_ATTACHMENT_MEDIA_MAX_REQUEST_BYTES = 4 * 1024;

/** Product UX media read-through companion to Authority channel-history. */
export const RELAY_V2_MESSAGE_ATTACHMENT_PRODUCT_MEDIA_PATH =
  "/api/relay-v2/message-attachments/product-media" as const;

export type RelayR2PrivateApiErrorCode =
  | "invalid_request"
  | "not_authenticated"
  | "not_authorized"
  | "migration_disabled"
  | "capability_security_unavailable"
  | "private_storage_unavailable";

export class RelayR2PrivateApiError extends Error {
  readonly code: RelayR2PrivateApiErrorCode;
  readonly status: number;
  /** A transient failure of storage or the attachment authority a replay can survive. */
  readonly retryable: boolean;

  constructor(code: RelayR2PrivateApiErrorCode, status: number, message: string, retryable = false) {
    super(message);
    this.name = "RelayR2PrivateApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** Answers whether a user may read one message attachment, and where its bytes are. */
export type RelayR2MessageAttachmentAuthority = (input: {
  channelId: string;
  messageId: string;
  attachmentId: string;
  principal: { kind: "user"; id: string };
}) => Promise<Response>;

function apiError(
  code: RelayR2PrivateApiErrorCode,
  status: number,
  message: string,
  retryable = false,
): RelayR2PrivateApiError {
  return new RelayR2PrivateApiError(code, status, message, retryable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return plainRecord(value) !== undefined;
}

function boundedString(value: unknown, field: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    utf8ByteLength(value) > maxBytes ||
    /\p{Cc}/u.test(value)
  ) {
    throw apiError("invalid_request", 400, `${field} is invalid`);
  }
  return value;
}

async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  declared: string | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw apiError("invalid_request", 413, "request body exceeds its byte limit");
    }
  }
  return readBoundedStream(body, maxBytes, () => apiError("invalid_request", 413, "request body exceeds its byte limit"));
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw apiError("invalid_request", 415, "Content-Type must be application/json");
  }
  const buffer = await readBoundedBytes(
    request.body,
    request.headers.get("content-length"),
    maxBytes,
  );
  if (buffer.byteLength === 0) {
    throw apiError("invalid_request", 400, "request body is invalid");
  }
  try {
    return JSON.parse(decoder.decode(buffer));
  } catch {
    throw apiError("invalid_request", 400, "request body must be valid UTF-8 JSON");
  }
}

async function readBoundedInternalJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBytes(
      response.body,
      response.headers.get("content-length"),
      maxBytes,
    );
  } catch {
    throw apiError(
      "capability_security_unavailable",
      503,
      "capability authority returned an invalid response",
    );
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw apiError(
      "capability_security_unavailable",
      503,
      "capability authority returned an invalid response",
    );
  }
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

const MESSAGE_ATTACHMENT_PRESENTATION_FIELDS = [
  "durationMs", "height", "transcodingStatus", "width",
] as const;

function hasRequiredOptionalFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((field) => Object.prototype.hasOwnProperty.call(value, field)) &&
    keys.every((field) => allowed.has(field));
}

export function relayR2PrivateApiErrorResponse(error: unknown): Response | undefined {
  if (error instanceof RelayR2PrivateApiError || error instanceof RelayR2DownloadGatewayError) {
    return domainErrorResponse(error, PRIVATE_JSON_HEADERS);
  }
  return undefined;
}

async function readAuthoritativeMessageAttachment(input: {
  attachmentAuthority: RelayR2MessageAttachmentAuthority;
  userId: string;
  channelId: string;
  messageId: string;
  attachmentId: string;
  expectedVisibilityScopeId?: string;
}): Promise<RelayV2MessageAttachmentAuthority> {
  let response: Response;
  try {
    response = await input.attachmentAuthority({
      channelId: input.channelId,
      messageId: input.messageId,
      attachmentId: input.attachmentId,
      principal: { kind: "user", id: input.userId },
    });
  } catch {
    throw apiError(
      "capability_security_unavailable",
      503,
      "message attachment authority is temporarily unavailable",
      true,
    );
  }
  const payload = await readBoundedInternalJson(
    response,
    RELAY_R2_ATTACHMENT_AUTHORITY_MAX_BYTES,
  );
  if (!response.ok) {
    throw apiError(
      response.status >= 500 ? "capability_security_unavailable" : "not_authorized",
      response.status >= 500 ? 503 : 403,
      response.status >= 500
        ? "message attachment authority is temporarily unavailable"
        : "message attachment is not available to this principal",
      response.status >= 500 && isRecord(payload) && payload.retryable === true,
    );
  }
  if (
    !isRecord(payload) ||
    !hasExactFields(payload, [
      "attachment",
      "channelId",
      "messageId",
      "object",
      "visibilityScopeId",
    ]) ||
    !isRecord(payload.attachment) ||
    !hasRequiredOptionalFields(
      payload.attachment,
      ["id", "mimeType", "name", "size", "version"],
      MESSAGE_ATTACHMENT_PRESENTATION_FIELDS,
    ) ||
    !isRecord(payload.object) ||
    !hasExactFields(payload.object, ["checksum", "contentHash", "encodedBytes", "objectKey"])
  ) {
    throw apiError(
      "capability_security_unavailable",
      503,
      "message attachment authority returned an invalid response",
    );
  }
  if (
    payload.channelId !== input.channelId || payload.messageId !== input.messageId ||
    payload.attachment.id !== input.attachmentId
  ) {
    throw apiError(
      "capability_security_unavailable",
      503,
      "message attachment authority returned an invalid binding",
    );
  }
  if (
    input.expectedVisibilityScopeId !== undefined &&
    payload.visibilityScopeId !== input.expectedVisibilityScopeId
  ) {
    throw apiError(
      "not_authorized",
      403,
      "message attachment projection scope changed",
    );
  }
  try {
    const authority = parseRelayV2MessageAttachmentAuthority({
      id: payload.attachment.id,
      name: payload.attachment.name,
      mimeType: payload.attachment.mimeType,
      size: payload.attachment.size,
      version: payload.attachment.version,
      ...(Object.prototype.hasOwnProperty.call(payload.attachment, "durationMs")
        ? { durationMs: payload.attachment.durationMs } : {}),
      ...(Object.prototype.hasOwnProperty.call(payload.attachment, "width")
        ? { width: payload.attachment.width } : {}),
      ...(Object.prototype.hasOwnProperty.call(payload.attachment, "height")
        ? { height: payload.attachment.height } : {}),
      ...(Object.prototype.hasOwnProperty.call(payload.attachment, "transcodingStatus")
        ? { transcodingStatus: payload.attachment.transcodingStatus } : {}),
      objectKey: payload.object.objectKey,
      contentHash: payload.object.contentHash,
    });
    if (
      authority.object.checksum !== payload.object.checksum ||
      authority.object.encodedBytes !== payload.object.encodedBytes
    ) {
      throw new Error("Authority attachment authority object fields disagree");
    }
    return authority;
  } catch {
    throw apiError(
      "capability_security_unavailable",
      503,
      "message attachment authority returned invalid object metadata",
    );
  }
}

/**
 * Product UX companion to Authority channel-history read-through: stream one
 * message attachment after Authority rechecks channel ACL and selects the
 * content-addressed object. Does not require client projection readiness or
 * a Local Replica lease — those gates remain for the capability path.
 * Clients never supply object keys or hashes.
 */
export async function handleRelayV2MessageAttachmentProductMedia(input: {
  request: Request;
  userId: string;
  /**
   * The Channel an Agent Run's read is scoped to: the requested Channel when
   * the route proved the Run may act there, else its birth Channel (which, for
   * a thread, includes the parent-channel root message it references).
   */
  requiredChannelId?: string;
  attachmentAuthority: RelayR2MessageAttachmentAuthority;
  bucket: R2Bucket;
}): Promise<Response> {
  let body: unknown;
  try {
    body = await readBoundedJson(input.request, RELAY_PRODUCT_ATTACHMENT_MEDIA_MAX_REQUEST_BYTES);
  } catch {
    throw apiError("invalid_request", 400, "message attachment product media request is invalid");
  }
  if (!isRecord(body)) {
    throw apiError("invalid_request", 400, "message attachment product media request is invalid");
  }
  const channelId = boundedString(body.channelId, "channelId", 200);
  const messageId = boundedString(body.messageId, "messageId", 200);
  const attachmentId = boundedString(body.attachmentId, "attachmentId", 200);
  // A request outside the Run's scope is re-scoped to it, so Authority only
  // serves it when that message is readable through the scope itself — i.e.
  // when the scope is a thread and the message is its parent-channel root.
  // Every other cross-channel read still fails closed at the authority.
  const authorityChannelId =
    input.requiredChannelId && channelId !== input.requiredChannelId
      ? input.requiredChannelId
      : channelId;
  const authority = await readAuthoritativeMessageAttachment({
    attachmentAuthority: input.attachmentAuthority,
    userId: input.userId,
    channelId: authorityChannelId,
    messageId,
    attachmentId,
  });
  let object: R2ObjectBody | null;
  try {
    object = await input.bucket.get(authority.object.objectKey);
  } catch {
    throw apiError(
      "private_storage_unavailable",
      503,
      "message attachment failed immutable storage verification",
      true,
    );
  }
  if (!object) {
    throw apiError(
      "private_storage_unavailable",
      503,
      "message attachment failed immutable storage verification",
    );
  }
  const stored = metadataFromR2Object(object);
  if (
    !stored ||
    stored.size !== authority.object.encodedBytes ||
    stored.checksumSha256 !== authority.object.contentHash
  ) {
    throw apiError(
      "private_storage_unavailable",
      503,
      "message attachment failed immutable storage verification",
    );
  }
  const headers = new Headers({
    "content-type": authority.attachment.mimeType,
    "content-length": String(authority.object.encodedBytes),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-xmatrix-attachment-id": authority.attachment.id,
    "x-xmatrix-attachment-name": encodeURIComponent(authority.attachment.name),
    "x-xmatrix-attachment-version": String(authority.attachment.version),
    "x-xmatrix-attachment-size": String(authority.attachment.size),
    "x-xmatrix-content-hash": authority.object.contentHash,
  });
  return new Response(object.body, { status: 200, headers });
}

function metadataFromR2Object(object: R2Object): RelayPrivateR2ObjectMetadata | null {
  const customChecksum = object.customMetadata?.sha256;
  const nativeChecksum = object.checksums?.sha256
    ? lowercaseHex(object.checksums.sha256)
    : undefined;
  const checksumSha256 = nativeChecksum || customChecksum;
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 1 ||
    typeof checksumSha256 !== "string" ||
    !SHA256.test(checksumSha256) ||
    (nativeChecksum !== undefined &&
      customChecksum !== undefined &&
      nativeChecksum !== customChecksum) ||
    typeof object.etag !== "string" ||
    object.etag.length === 0
  ) {
    return null;
  }
  return { size: object.size, checksumSha256, etag: object.etag };
}
