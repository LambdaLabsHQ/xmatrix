import { crossChannelReplyRelay, type ChannelMessage, type SerializedChannel } from "@xmatrix/protocol";
import { channelAppPath, channelTitle } from "./channel-links";

/**
 * Where a cross-Channel message came from (docs/design/evolving-system-zh.md §5).
 *
 * `channelName` and `href` are present only when the origin is in this reader's
 * Channel catalog, which the Hub has already filtered by the reader's access.
 * A reader without access sees that the message came from elsewhere, never
 * which Channel.
 */
export type MessageLinkOrigin = {
  kind: "link" | "reply";
  channelId: string;
  messageId?: string;
  channelName?: string;
  href?: string;
  /** For a relayed reply: whether a person or an Agent answered. */
  replierKind?: "user" | "agent";
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function messageLinkOrigin(
  message: ChannelMessage,
  channels: SerializedChannel[],
): MessageLinkOrigin | undefined {
  const relayed = crossChannelReplyRelay(message.metadata);
  const origin: Omit<MessageLinkOrigin, "channelName" | "href"> | undefined =
    message.from.kind === "agent" && text(message.from.originChannelId) &&
        message.from.originChannelId !== message.channelId
      ? {
          kind: "link",
          channelId: message.from.originChannelId!,
          ...(text(message.from.originMessageId) ? { messageId: message.from.originMessageId } : {}),
        }
      : relayed && relayed.sourceChannelId !== message.channelId
        ? {
            kind: "reply",
            channelId: relayed.sourceChannelId,
            ...(relayed.sourceMessageId ? { messageId: relayed.sourceMessageId } : {}),
            ...(relayed.replierKind ? { replierKind: relayed.replierKind } : {}),
          }
        : undefined;
  if (!origin) return undefined;
  const channel = channels.find((candidate) => candidate.id === origin.channelId);
  if (!channel) return origin;
  const path = channelAppPath(channel, []);
  return {
    ...origin,
    channelName: channelTitle(channel),
    href: origin.messageId ? `${path}#message:${encodeURIComponent(origin.messageId)}` : path,
  };
}

export function messageLinkOriginLabel(origin: MessageLinkOrigin): string {
  const where = origin.channelName ? `#${origin.channelName}` : "a private Channel";
  return origin.kind === "reply" ? `reply from ${where}` : `from ${where}`;
}

export function messageLinkOriginTitle(origin: MessageLinkOrigin): string {
  if (!origin.channelName) {
    return origin.kind === "reply"
      ? "Answered in a Channel you cannot open."
      : "This Agent works in a Channel you cannot open.";
  }
  return origin.kind === "reply"
    ? `Answered in #${origin.channelName}. Open the reply there.`
    : origin.messageId
      ? `This Agent works in #${origin.channelName}. Open the message it was handling there.`
      : `This Agent works in #${origin.channelName}.`;
}
