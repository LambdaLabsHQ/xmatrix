import { hmacHex, timingSafeEqual, utf8ByteLength } from "@xmatrix/protocol";
import { handleRelayV2MessageAttachmentProductMedia, type RelayR2MessageAttachmentAuthority } from "../relay-r2-private-api";
import { base64UrlDecodeBytes, base64UrlEncodeValue } from "../relay-v2-primitives";
import { ProviderRequestError } from "./http";
import type { XAccountView, XActionCapability } from "./x-accounts";

const MAX_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const MAX_RECEIPT_MS = 60 * 60 * 1000;
const ID = /^[0-9]{1,19}$/u;
const REF = /^[A-Za-z0-9_.:-]{1,200}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const RECEIPT = /^xm1\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/u;
const DOMAIN = "xmatrix:x-media:v1\n";

export interface XMediaSourceReference { messageId: string; attachmentId: string }
interface Source extends XMediaSourceReference { name: string; size: number; hash: string; version: number }
export interface XMediaStatus {
  mediaId: string;
  state: "pending" | "in_progress" | "succeeded" | "failed";
  checkAfterSeconds?: number;
}
export interface XMediaCapability {
  prepareUpload(account: XAccountView, source: XMediaSourceReference): Promise<Record<string, string>>;
  upload(account: XAccountView, prepared: Record<string, string>): Promise<XMediaStatus & { receipt: string }>;
  status(account: XAccountView, receipt: string): Promise<XMediaStatus>;
  ready(account: XAccountView, receipt: string): Promise<string>;
}
interface ReceiptClaims {
  version: 1; spaceId: string; channelId: string; actorUserId: string;
  accountId: string; accountGeneration: string; mediaId: string;
  issuedAt: number; expiresAt: number; source: Source;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validSource(value: unknown): value is Source {
  return record(value) && typeof value.messageId === "string" && REF.test(value.messageId) &&
    typeof value.attachmentId === "string" && REF.test(value.attachmentId) &&
    typeof value.name === "string" && value.name.length > 0 && utf8ByteLength(value.name) <= 255 && !/\p{Cc}/u.test(value.name) &&
    Number.isSafeInteger(value.size) && Number(value.size) > 0 && Number(value.size) <= MAX_BYTES &&
    typeof value.hash === "string" && HASH.test(value.hash) && Number.isSafeInteger(value.version) && Number(value.version) >= 1;
}
function sourceFields(source: Source): Record<string, string> {
  return { messageId: source.messageId, attachmentId: source.attachmentId, sourceName: source.name,
    sourceSize: String(source.size), sourceHash: source.hash, sourceVersion: String(source.version) };
}
function preparedSource(input: Record<string, string>): Source {
  const value = { messageId: input.messageId, attachmentId: input.attachmentId, name: input.sourceName,
    size: Number(input.sourceSize), hash: input.sourceHash, version: Number(input.sourceVersion) };
  if (!validSource(value)) throw new ProviderRequestError(409, "The approved video source is incomplete; request a new approval");
  return value;
}
function sameSource(left: Source, right: Source): boolean {
  return left.messageId === right.messageId && left.attachmentId === right.attachmentId && left.name === right.name &&
    left.size === right.size && left.hash === right.hash && left.version === right.version;
}
function providerData(payload: Record<string, unknown>): Record<string, unknown> {
  if ((payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length > 0)) || !record(payload.data)) {
    throw new ProviderRequestError(502, "X did not return valid media metadata");
  }
  return payload.data;
}
function mediaId(data: Record<string, unknown>, expected?: string): string {
  if (typeof data.id !== "string" || !ID.test(data.id) || (expected !== undefined && data.id !== expected)) {
    throw new ProviderRequestError(502, "X returned a different or invalid media ID");
  }
  return data.id;
}
function expiration(data: Record<string, unknown>, startedAt: number): number {
  if (!Number.isSafeInteger(data.expires_after_secs) || Number(data.expires_after_secs) < 1 || Number(data.expires_after_secs) > 7 * 86400) {
    throw new ProviderRequestError(502, "X did not return a valid media expiration");
  }
  return startedAt + Number(data.expires_after_secs) * 1000;
}
function processing(data: Record<string, unknown>, id: string): XMediaStatus {
  mediaId(data, id);
  if (data.processing_info === undefined) return { mediaId: id, state: "succeeded" };
  const info = data.processing_info;
  if (!record(info) || !["pending", "in_progress", "succeeded", "failed"].includes(String(info.state)) ||
      (info.check_after_secs !== undefined && (!Number.isSafeInteger(info.check_after_secs) ||
        Number(info.check_after_secs) < 0 || Number(info.check_after_secs) > 86400))) {
    throw new ProviderRequestError(502, "X did not return a valid video processing state");
  }
  return { mediaId: id, state: info.state as XMediaStatus["state"],
    ...(info.check_after_secs !== undefined ? { checkAfterSeconds: Number(info.check_after_secs) } : {}) };
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

/** Server-bound media operations: callers name immutable Channel attachments, never storage keys or URLs. */
export function createXMediaCapability(input: {
  spaceId: string; channelId: string; actorUserId: string; x: XActionCapability;
  attachmentAuthority: RelayR2MessageAttachmentAuthority; bucket: R2Bucket; receiptSecret: string | undefined;
  authorizeWrite: () => Promise<void>;
}): XMediaCapability {
  function secret(): string {
    if (!input.receiptSecret || utf8ByteLength(input.receiptSecret) < 32) {
      throw new ProviderRequestError(503, "Video receipt security is unavailable");
    }
    return input.receiptSecret;
  }
  async function currentAccount(account: XAccountView): Promise<void> {
    const matches = (await input.x.accounts()).filter(item => item.id === account.id && item.generation === account.generation);
    if (matches.length !== 1) throw new ProviderRequestError(409, "The approved X account changed; request a new approval");
  }
  async function sourceRead(reference: XMediaSourceReference): Promise<{ response: Response; source: Source }> {
    if (!REF.test(reference.messageId) || !REF.test(reference.attachmentId)) {
      throw new ProviderRequestError(400, "Name one message ID and attachment ID in this Channel");
    }
    const response = await handleRelayV2MessageAttachmentProductMedia({
      request: new Request("https://hub.internal/api/relay-v2/message-attachments/product-media", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ channelId: input.channelId, messageId: reference.messageId, attachmentId: reference.attachmentId }) }),
      userId: input.actorUserId, requiredChannelId: input.channelId,
      attachmentAuthority: input.attachmentAuthority, bucket: input.bucket,
    });
    let name: string;
    try { name = decodeURIComponent(response.headers.get("x-xmatrix-attachment-name") ?? ""); } catch { name = ""; }
    const source = { ...reference, name, size: Number(response.headers.get("x-xmatrix-attachment-size")),
      hash: response.headers.get("x-xmatrix-content-hash") ?? "", version: Number(response.headers.get("x-xmatrix-attachment-version")) };
    if (response.headers.get("content-type") !== "video/mp4" || !validSource(source) ||
        Number(response.headers.get("content-length")) !== source.size) {
      await response.body?.cancel();
      throw new ProviderRequestError(400, "Select a nonempty MP4 Channel attachment no larger than 64 MiB, with a filename at most 255 bytes");
    }
    return { response, source };
  }
  async function inspect(reference: XMediaSourceReference): Promise<Source> {
    const read = await sourceRead(reference);
    await read.response.body?.cancel();
    return read.source;
  }
  async function validateSource(source: Source): Promise<void> {
    if (!sameSource(source, await inspect(source))) {
      throw new ProviderRequestError(409, "The approved video attachment changed; request a new approval");
    }
  }
  async function signed(claims: ReceiptClaims): Promise<string> {
    const payload = base64UrlEncodeValue(JSON.stringify(claims));
    return `xm1.${payload}.${await hmacHex("SHA-256", secret(), DOMAIN + payload)}`;
  }
  async function verified(account: XAccountView, receipt: string): Promise<ReceiptClaims> {
    const match = typeof receipt === "string" && receipt.length <= 4096 ? receipt.match(RECEIPT) : null;
    if (!match || !timingSafeEqual(match[2]!, await hmacHex("SHA-256", secret(), DOMAIN + match[1]!))) {
      throw new ProviderRequestError(400, "Use an unmodified video receipt returned by this Channel's upload_video action");
    }
    let claims: unknown;
    try { claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecodeBytes(match[1]!))); } catch { claims = undefined; }
    if (!record(claims) || claims.version !== 1 || claims.spaceId !== input.spaceId || claims.channelId !== input.channelId ||
        claims.actorUserId !== input.actorUserId || claims.accountId !== account.id || claims.accountGeneration !== account.generation ||
        typeof claims.mediaId !== "string" || !ID.test(claims.mediaId) || !validSource(claims.source) ||
        !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt) ||
        Number(claims.issuedAt) > Date.now() + 30_000 || Number(claims.expiresAt) > Number(claims.issuedAt) + MAX_RECEIPT_MS ||
        Number(claims.expiresAt) <= Date.now()) {
      throw new ProviderRequestError(409, "The video receipt expired or belongs to a different Channel or X account; upload again");
    }
    await currentAccount(account);
    await validateSource(claims.source);
    return claims as unknown as ReceiptClaims;
  }
  async function status(account: XAccountView, receipt: string): Promise<XMediaStatus> {
    const claims = await verified(account, receipt);
    const data = providerData(await input.x.request(account, "GET", `/2/media/upload?command=STATUS&media_id=${claims.mediaId}`));
    const result = processing(data, claims.mediaId);
    if (Date.now() >= claims.expiresAt) throw new ProviderRequestError(409, "The video receipt expired; upload again");
    return result;
  }
  return {
    async prepareUpload(account, reference) {
      secret();
      await currentAccount(account);
      return sourceFields(await inspect(reference));
    },
    async upload(account, prepared) {
      secret();
      const approved = preparedSource(prepared);
      await currentAccount(account);
      const { response, source } = await sourceRead(approved);
      const reader = response.body?.getReader();
      if (!reader || !sameSource(source, approved)) {
        await reader?.cancel();
        throw new ProviderRequestError(409, "The approved video attachment changed; request a new approval");
      }
      const startedAt = Date.now();
      try {
        await input.authorizeWrite();
        const initialized = providerData(await input.x.request(account, "POST", "/2/media/upload/initialize", {
          media_type: "video/mp4", media_category: "tweet_video", total_bytes: source.size,
        }));
        const id = mediaId(initialized);
        let expiresAt = Math.min(startedAt + MAX_RECEIPT_MS, expiration(initialized, startedAt));
        let received = 0, segment = 0, filled = 0;
        const buffer = new Uint8Array(Math.min(CHUNK_BYTES, source.size));
        async function append() {
          if (segment >= 64 || Date.now() >= expiresAt) throw new ProviderRequestError(409, "The bounded video upload expired; upload again");
          await validateSource(approved);
          await input.authorizeWrite();
          const appended = await input.x.request(account, "POST", `/2/media/upload/${id}/append`, {
            media: base64(buffer.subarray(0, filled)), segment_index: segment,
          });
          if (appended.errors !== undefined && (!Array.isArray(appended.errors) || appended.errors.length)) {
            throw new ProviderRequestError(502, "X rejected a video segment");
          }
          segment += 1;
          filled = 0;
        }
        while (true) {
          const timeout = AbortSignal.timeout(10_000);
          const read = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
            const aborted = () => reject(new ProviderRequestError(504, "Reading the Channel video timed out"));
            timeout.addEventListener("abort", aborted, { once: true });
            void reader.read().then(resolve, reject).finally(() => timeout.removeEventListener("abort", aborted));
          });
          if (read.done) break;
          received += read.value.byteLength;
          if (received > source.size) throw new ProviderRequestError(502, "The Channel video size failed immutable storage verification");
          for (let offset = 0; offset < read.value.byteLength;) {
            const count = Math.min(buffer.byteLength - filled, read.value.byteLength - offset);
            buffer.set(read.value.subarray(offset, offset + count), filled);
            filled += count;
            offset += count;
            if (filled === buffer.byteLength) await append();
          }
        }
        if (received !== source.size) throw new ProviderRequestError(502, "The Channel video size failed immutable storage verification");
        if (filled) await append();
        await validateSource(approved);
        await input.authorizeWrite();
        const finalizedAt = Date.now();
        const data = providerData(await input.x.request(account, "POST", `/2/media/upload/${id}/finalize`));
        const result = processing(data, id);
        expiresAt = Math.min(expiresAt, expiration(data, finalizedAt));
        if (result.state === "failed") throw new ProviderRequestError(422, "X could not process this video; select another MP4 attachment");
        if (Date.now() >= expiresAt) throw new ProviderRequestError(409, "The video upload expired; upload again");
        return { ...result, receipt: await signed({ version: 1, spaceId: input.spaceId, channelId: input.channelId,
          actorUserId: input.actorUserId, accountId: account.id, accountGeneration: account.generation, mediaId: id,
          source: approved, issuedAt: startedAt, expiresAt }) };
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
    status,
    async ready(account, receipt) {
      const result = await status(account, receipt);
      if (result.state !== "succeeded") throw new ProviderRequestError(409,
        result.state === "failed" ? "X video processing failed; upload another video" :
          `X is still processing this video; check media_status${result.checkAfterSeconds ? ` after ${result.checkAfterSeconds} seconds` : ""}`);
      return result.mediaId;
    },
  };
}
