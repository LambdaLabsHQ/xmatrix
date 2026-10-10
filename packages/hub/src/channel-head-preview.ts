import type { ChannelHeadMessage } from "@xmatrix/db";
import type { ChannelReplyContext, MessageSender } from "@xmatrix/protocol";
import { compactMessageBodyPreview } from "./message-body-preview";
import { productMessageSenderPresentation } from "./message-sender-presentation";
import { decodeRelayV2MessagePayloadBundle } from "./relay-v2-message-record";
import { base64UrlDecodeBytes } from "./relay-v2-primitives";

/**
 * A conversation's stored newest message as chat lists and page margins show
 * it: its author's name and a one-line preview of its body.
 */
export function channelHeadPreview(head: ChannelHeadMessage): ChannelReplyContext {
  const userAuthor = head.authorKind === "user";
  let from = {
    identityId: userAuthor ? `user:${head.authorId}` : head.authorId,
    kind: head.authorKind, label: head.authorId,
    userId: userAuthor ? head.authorId : "", email: "",
  } as unknown as MessageSender;
  // A stored preview is what the payload decodes to; only older messages decode it here.
  let bodyPreview = head.preview?.bodyPreview;
  let senderSnapshot = head.preview?.senderSnapshot;
  if (!head.preview) {
    let body = head.legacyBody ?? "";
    try {
      const bundle = head.payloadBundleBase64
        ? decodeRelayV2MessagePayloadBundle(base64UrlDecodeBytes(head.payloadBundleBase64)) : null;
      if (bundle) {
        body = bundle.body;
        senderSnapshot = bundle.senderSnapshot;
      }
    } catch {
      // An undecodable payload still shows that someone wrote, and when.
    }
    bodyPreview = compactMessageBodyPreview(body);
  }
  if (senderSnapshot && (head.authorKind === "user" || head.authorKind === "agent" || head.authorKind === "app" ||
      head.authorKind === "system")) {
    from = productMessageSenderPresentation(senderSnapshot, head.authorKind, head.authorId) as unknown as MessageSender;
  }
  return {
    messageId: head.messageId,
    sequence: head.sequence,
    from,
    bodyPreview: head.recalledAt ? "Message recalled" : bodyPreview ?? "",
    sentAt: head.sentAt,
    ...(head.recalledAt ? { recalledAt: head.recalledAt } : {}),
  };
}

/**
 * Replace the stored head a catalog Channel carries with the preview clients
 * read (`SerializedChannel.lastMessage`).
 */
export function withChannelHeadPreview(channel: Record<string, unknown>): Record<string, unknown> {
  const { headMessage, waitingMessage, ...rest } = channel;
  return {
    ...rest,
    ...(headMessage && typeof headMessage === "object"
      ? { lastMessage: channelHeadPreview(headMessage as ChannelHeadMessage) } : {}),
    // The message that waits on the reader, in the same shape as the row's preview.
    ...(waitingMessage && typeof waitingMessage === "object"
      ? { attentionMessage: channelHeadPreview(waitingMessage as ChannelHeadMessage) } : {}),
  };
}
