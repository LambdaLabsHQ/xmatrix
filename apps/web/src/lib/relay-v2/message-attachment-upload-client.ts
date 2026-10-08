import { sha256 } from "@noble/hashes/sha2.js";
import {
  RELAY_V2_BLOB_REF_PATH,
  RELAY_V2_BLOB_UPLOAD_CHECKSUM_HEADER,
  RELAY_V2_BLOB_UPLOAD_INTENT_PATH,
  RELAY_V2_BLOB_UPLOAD_PREFIX,
} from "@xmatrix/protocol/relay-v2/message-attachment";
import { lowercaseHex } from "@xmatrix/protocol";
import { XMatrixApiError, xmatrixRawResponse } from "../query/api-client";
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
const UPLOAD_INTENT_TTL_MS = 60 * 60 * 1_000;

/**
 * The two JSON hops bracketing an upload each queue on Relay authority. Without a
 * deadline a stalled hop leaves the composer on "uploading" forever rather than
 * reporting a failure the caller can retry, so bound them.
 */
export const UPLOAD_CONTROL_DEADLINE_MS = 15_000;

/**
 * The body transfer is bounded by *stall*, not by total duration: a large file
 * on a slow link is healthy and must not be cancelled for taking its time, but
 * a transfer that stops advancing is the hang we are fixing. The watchdog is
 * rearmed only when `loaded` strictly advances — progress events repeating an
 * unchanged `loaded` are themselves a stall, so honouring them would keep the
 * transfer alive forever.
 */
export const UPLOAD_STALL_DEADLINE_MS = 30_000;

export interface PreparedMessageAttachmentUpload {
  attachmentId: string;
  intentId: string;
  visibilityScopeId: string;
  objectKey: string;
  contentHash: string;
  encodedBytes: number;
  mimeType: string;
  name: string;
}

export interface MessageAttachmentBinding
  extends PreparedMessageAttachmentUpload {
  presentationResidual?: Readonly<Record<string, boolean | null | number | string>>;
}

function webProxyPath(hubPath: string): string {
  if (!hubPath.startsWith("/api/")) {
    throw new TypeError("Hub API path is invalid");
  }
  return `/api/xmatrix/${hubPath.slice("/api/".length)}`;
}

function randomId(): string {
  return crypto.randomUUID();
}

/** A refused hop, classified like every other xMatrix failure (docs/architecture/client-resilience.md). */
function errorFromPayload(payload: unknown, fallback: string, status: number): XMatrixApiError {
  const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  return new XMatrixApiError({
    message: typeof body.error === "string" ? body.error : fallback,
    status,
    code: typeof body.code === "string" ? body.code : undefined,
    retryable: typeof body.retryable === "boolean" ? body.retryable : status === 502 || status === 503 || status === 504,
  });
}

/** The transfer got no answer, or stopped advancing: the network, and transient. */
function transferLost(message: string, code: string): XMatrixApiError {
  return new XMatrixApiError({ message, status: 0, code, retryable: true });
}

function uploadCancelled(): DOMException {
  return new DOMException("Upload cancelled", "AbortError");
}

/**
 * Reject once `deadlineMs` elapses. Distinguished from a caller cancellation so
 * the UI can say "timed out" rather than "cancelled".
 */
function deadlineSignal(deadlineMs: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Request exceeded its deadline", "TimeoutError")),
    deadlineMs,
  );
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function deadlineError(error: unknown, what: string): Error {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new DOMException(`${what} timed out`, "TimeoutError");
  }
  return error instanceof Error ? error : new Error(`${what} failed`);
}

async function jsonResponse(
  response: Response,
  fallback: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Tolerating an unparseable body is deliberate: an error response may carry
  // none, and the fallback message is more useful than a parse error. But that
  // tolerance must not swallow a deadline abort — doing so silently defeats the
  // deadline, because the read then "succeeds" with an empty payload.
  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    payload = {};
  }
  if (!response.ok) throw errorFromPayload(payload, fallback, response.status);
  return payload;
}

export async function sha256Blob(
  blob: Blob,
  onProgress?: (progress: number) => void,
): Promise<string> {
  const digest = sha256.create();
  for (let offset = 0; offset < blob.size; offset += HASH_CHUNK_BYTES) {
    const bytes = new Uint8Array(
      await blob.slice(offset, Math.min(blob.size, offset + HASH_CHUNK_BYTES)).arrayBuffer(),
    );
    digest.update(bytes);
    onProgress?.(Math.round((Math.min(blob.size, offset + bytes.byteLength) / blob.size) * 100));
  }
  return lowercaseHex(digest.digest());
}

export async function prepareMessageAttachmentUpload(input: {
  file: File;
  token: string;
  visibilityScopeId: string;
  mimeType: string;
  onProgress?: (progress: number) => void;
  /**
   * Handed the request once it can actually be aborted. Return false to say the
   * upload was already cancelled and must not be sent — `abort()` on a request
   * that has not been sent yet is a no-op, so a late cancel could not stop it.
   */
  onRequest?: (request: XMLHttpRequest) => boolean | void;
  /** Overridden by tests; defaults to `UPLOAD_CONTROL_DEADLINE_MS`. */
  controlDeadlineMs?: number;
  /** Overridden by tests; defaults to `UPLOAD_STALL_DEADLINE_MS`. */
  stallDeadlineMs?: number;
}): Promise<PreparedMessageAttachmentUpload> {
  const contentHash = await sha256Blob(input.file, (progress) => {
    input.onProgress?.(Math.max(1, Math.min(8, Math.round(progress * 0.08))));
  });
  const intentId = randomId();
  const expectedUploadPath =
    `${RELAY_V2_BLOB_UPLOAD_PREFIX}/${encodeURIComponent(intentId)}` +
    `/scope/${encodeURIComponent(input.visibilityScopeId)}`;
  let uploadPath: string;
  const intentDeadline = deadlineSignal(input.controlDeadlineMs ?? UPLOAD_CONTROL_DEADLINE_MS);
  try {
    // The deadline has to stay armed across reading the body, not just until
    // headers arrive: a response whose JSON never finishes streaming is the
    // same permanent hang as one that never answers at all.
    const intentResponse = await xmatrixRawResponse(webProxyPath(RELAY_V2_BLOB_UPLOAD_INTENT_PATH), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: randomId(),
        intentId,
        visibilityScopeId: input.visibilityScopeId,
        contentHash,
        encodedSize: input.file.size,
        expiresAt: new Date(Date.now() + UPLOAD_INTENT_TTL_MS).toISOString(),
      }),
      cache: "no-store",
      signal: intentDeadline.signal,
    });
    const admitted = await jsonResponse(
      intentResponse,
      "Failed to create attachment upload",
      intentDeadline.signal,
    );
    const upload = admitted.upload;
    uploadPath = upload && typeof upload === "object" &&
      typeof (upload as { finalPath?: unknown }).finalPath === "string"
      ? (upload as { finalPath: string }).finalPath
      : "";
    // The Hub selects the owning scoped authority. Accept only the exact path
    // implied by this request, so a malformed response cannot redirect the
    // authenticated upload to another Hub route or visibility scope.
    if (uploadPath !== expectedUploadPath) {
      throw new Error("Attachment upload authority returned an invalid path");
    }
  } catch (error) {
    throw deadlineError(error, "Creating the attachment upload");
  } finally {
    intentDeadline.done();
  }

  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", webProxyPath(uploadPath));
    request.setRequestHeader("Authorization", `Bearer ${input.token}`);
    request.setRequestHeader("content-type", input.mimeType);
    request.setRequestHeader(RELAY_V2_BLOB_UPLOAD_CHECKSUM_HEADER, contentHash);
    // Rearmed only by real byte advancement, so a transfer that stops moving is
    // treated as hung even while it keeps emitting progress events. `stalled`
    // separates that from a caller `abort()`, which also fires `onabort`.
    const stallMs = input.stallDeadlineMs ?? UPLOAD_STALL_DEADLINE_MS;
    let stalled = false;
    // Only real byte advancement counts. A stream that keeps emitting progress
    // events with an unchanged `loaded` is stalled, and rearming on those would
    // let it stay "uploading" forever — the very hang being bounded.
    let lastLoaded = -1;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const clearStall = () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = undefined;
    };
    const armStall = () => {
      clearStall();
      stallTimer = setTimeout(() => {
        stalled = true;
        request.abort();
      }, stallMs);
    };
    request.upload.onprogress = (event) => {
      // `loaded` is judged on its own; a missing `total` only costs the percentage.
      if (typeof event.loaded === "number" && event.loaded > lastLoaded) {
        lastLoaded = event.loaded;
        armStall();
      }
      if (!event.lengthComputable || event.total <= 0) return;
      input.onProgress?.(
        Math.max(8, Math.min(99, 8 + Math.round((event.loaded / event.total) * 91))),
      );
    };
    request.onload = () => {
      clearStall();
      let payload: unknown = {};
      try {
        payload = request.responseText ? JSON.parse(request.responseText) : {};
      } catch {
        reject(new Error("Attachment upload response was invalid"));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(errorFromPayload(payload, "Failed to upload attachment", request.status));
        return;
      }
      resolve();
    };
    request.onerror = () => {
      clearStall();
      reject(transferLost("Failed to upload attachment", "network_error"));
    };
    request.onabort = () => {
      clearStall();
      reject(stalled ? transferLost("Attachment upload stalled", "upload_stalled") : uploadCancelled());
    };
    // Registered only now: before `open` and the abort handler there is nothing
    // an abort could act on, and the send below would have gone out anyway.
    if (input.onRequest?.(request) === false) {
      clearStall();
      reject(uploadCancelled());
      return;
    }
    // Armed before `send` as well: a connection that never emits a single
    // progress event is exactly the hang this bounds. A synchronous throw from
    // `send` must still disarm it, or the watchdog outlives the request.
    armStall();
    try {
      request.send(input.file);
    } catch (error) {
      clearStall();
      reject(error instanceof Error ? error : new Error("Failed to upload attachment"));
    }
  });

  input.onProgress?.(100);
  return {
    attachmentId: randomId(),
    intentId,
    visibilityScopeId: input.visibilityScopeId,
    objectKey: `objects/${contentHash}`,
    contentHash,
    encodedBytes: input.file.size,
    mimeType: input.mimeType,
    name: input.file.name || "attachment",
  };
}

export async function commitMessageAttachmentRefs(input: {
  token: string;
  messageId: string;
  /**
   * Who can see the files: the message's Channel scope. It is set here, not at
   * upload — an upload only makes the object exist in its Space.
   */
  visibilityScopeId: string;
  attachments: readonly PreparedMessageAttachmentUpload[];
  /** Overridden by tests; defaults to `UPLOAD_CONTROL_DEADLINE_MS`. */
  controlDeadlineMs?: number;
}): Promise<void> {
  await Promise.all(input.attachments.map(async (attachment) => {
    const deadline = deadlineSignal(input.controlDeadlineMs ?? UPLOAD_CONTROL_DEADLINE_MS);
    try {
      // Armed across the body read too — see the intent hop above.
      const response = await xmatrixRawResponse(webProxyPath(RELAY_V2_BLOB_REF_PATH), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: randomId(),
          intentId: attachment.intentId,
          refId: attachment.attachmentId,
          ownerKind: "message_attachment",
          ownerId: input.messageId,
          visibilityScopeId: input.visibilityScopeId,
        }),
        cache: "no-store",
        signal: deadline.signal,
      });
      await jsonResponse(response, "Failed to commit attachment", deadline.signal);
    } catch (error) {
      throw deadlineError(error, "Committing the attachment");
    } finally {
      deadline.done();
    }
  }));
}
