import { lowercaseHex, utf8ByteLength } from "@xmatrix/protocol";
import { handleRelayV2MessageAttachmentProductMedia, type RelayR2MessageAttachmentAuthority } from "../relay-r2-private-api";
import { postgresMessageAttachmentAuthorityRequest } from "../postgres-message-attachment-authority";
import { ProviderRequestError } from "./http";
import type { ConnectorCommandInput } from "./provider";

/*
 * The files a Gmail send or reply carries: those attached to the command message itself. The caller names no
 * storage key, URL or other message; each file is read through the same Channel attachment authority as any
 * download, as the Human the command runs for, so a file they could not open cannot be mailed. The approval card
 * freezes each file's name, type, size, content hash and version, and the send rereads and compares them, so a
 * file changed or removed after approval is not sent.
 */

/* Gmail refuses more than 25 MB of attachments; base64 makes the message about a third larger, under its 35 MB upload limit. */
export const MAX_MAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_MAIL_ATTACHMENTS = 20;
const REF = /^[A-Za-z0-9_.:-]{1,200}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;

export interface MailAttachmentSource { messageId: string; attachmentId: string }
export interface MailAttachment extends MailAttachmentSource {
  name: string; mimeType: string; size: number; hash: string; version: number;
}
export interface MailAttachments {
  /** The files on the command message, in the order they were attached. */
  readonly sources: readonly MailAttachmentSource[];
  /** Name, type, size, hash and version of one file, without keeping its bytes. */
  inspect(source: MailAttachmentSource): Promise<MailAttachment>;
  /** The bytes of an approved file, only while it is unchanged. */
  read(approved: MailAttachment): Promise<Uint8Array>;
}

export function validMailAttachment(value: unknown): value is MailAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return typeof file.messageId === "string" && REF.test(file.messageId) &&
    typeof file.attachmentId === "string" && REF.test(file.attachmentId) &&
    typeof file.name === "string" && file.name.length > 0 && utf8ByteLength(file.name) <= 255 && !/\p{Cc}/u.test(file.name) &&
    typeof file.mimeType === "string" && MIME.test(file.mimeType) &&
    Number.isSafeInteger(file.size) && Number(file.size) > 0 && Number(file.size) <= MAX_MAIL_ATTACHMENT_BYTES &&
    typeof file.hash === "string" && HASH.test(file.hash) && Number.isSafeInteger(file.version) && Number(file.version) >= 1;
}

function sameFile(left: MailAttachment, right: MailAttachment): boolean {
  return left.messageId === right.messageId && left.attachmentId === right.attachmentId && left.name === right.name &&
    left.mimeType === right.mimeType && left.size === right.size && left.hash === right.hash && left.version === right.version;
}

/* Hashed in place: a 25 MB file is not copied first. */
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return lowercaseHex(await crypto.subtle.digest("SHA-256", bytes));
}

export function createMailAttachments(input: {
  channelId: string; actorUserId: string; sources: readonly MailAttachmentSource[];
  attachmentAuthority: RelayR2MessageAttachmentAuthority; bucket: R2Bucket | undefined;
}): MailAttachments {
  async function open(source: MailAttachmentSource): Promise<{ response: Response; file: MailAttachment }> {
    const bucket = input.bucket;
    if (!bucket) throw new ProviderRequestError(503, "the Hub cannot read Channel attachments for Gmail");
    if (!REF.test(source.messageId) || !REF.test(source.attachmentId)) {
      throw new ProviderRequestError(400, "an attachment of this command could not be identified");
    }
    let response: Response;
    try {
      response = await handleRelayV2MessageAttachmentProductMedia({
        request: new Request("https://hub.internal/api/relay-v2/message-attachments/product-media", { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId: input.channelId, messageId: source.messageId, attachmentId: source.attachmentId }) }),
        userId: input.actorUserId, requiredChannelId: input.channelId,
        attachmentAuthority: input.attachmentAuthority, bucket,
      });
    } catch {
      throw new ProviderRequestError(409, "an attachment of this command is no longer available to you; attach it again");
    }
    let name: string;
    try { name = decodeURIComponent(response.headers.get("x-xmatrix-attachment-name") ?? ""); } catch { name = ""; }
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const file = { ...source, name, mimeType: MIME.test(mimeType) ? mimeType : "application/octet-stream",
      size: Number(response.headers.get("x-xmatrix-attachment-size")), hash: response.headers.get("x-xmatrix-content-hash") ?? "",
      version: Number(response.headers.get("x-xmatrix-attachment-version")) };
    if (!validMailAttachment(file)) {
      await response.body?.cancel();
      throw new ProviderRequestError(422, `an attachment must be a nonempty file of at most ${MAX_MAIL_ATTACHMENT_BYTES / 1024 / 1024} MiB ` +
        "with a name of at most 255 bytes");
    }
    return { response, file };
  }
  return {
    sources: input.sources,
    async inspect(source) {
      const { response, file } = await open(source);
      await response.body?.cancel();
      return file;
    },
    async read(approved) {
      const { response, file } = await open(approved);
      if (!sameFile(file, approved)) {
        await response.body?.cancel();
        throw new ProviderRequestError(409, `attachment ${approved.name} changed after it was approved; ask again`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== approved.size || await sha256(bytes) !== approved.hash) {
        throw new ProviderRequestError(409, `attachment ${approved.name} changed after it was approved; ask again`);
      }
      return bytes;
    },
  };
}

/**
 * The attachment reader of a Gmail send or reply: the command's own files when it first runs, and, for a run an
 * admin approved later (which carries no files of its own), the reader of the files the approval froze. It exists
 * whenever the action can carry files, so a file is never dropped silently; without storage, reading one fails.
 */
export function commandMailAttachments(actionId: string,
  input: Pick<ConnectorCommandInput, "env" | "channelId" | "messageId" | "actorUserId" | "attachments">): MailAttachments | undefined {
  return actionId === "send" || actionId === "reply" ? commandFiles(input) : undefined;
}

/** The files attached to a command message, read as the Human the command runs for. */
export function commandFiles(input: Pick<ConnectorCommandInput, "env" | "channelId" | "messageId" | "actorUserId" | "attachments">): MailAttachments {
  return createMailAttachments({ channelId: input.channelId, actorUserId: input.actorUserId, bucket: input.env.RELAY_PAYLOAD_BUCKET,
    sources: (input.attachments ?? []).map(attachment => ({ messageId: input.messageId, attachmentId: attachment.id })),
    attachmentAuthority: request => postgresMessageAttachmentAuthorityRequest(input.env, request) });
}
