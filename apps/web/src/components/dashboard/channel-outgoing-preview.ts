import type { ChannelMessage, ChannelSnapshot } from "@xmatrix/protocol";
import { currentHumanDisplayName } from "./human-profile-summary";
import { channelLastMessagePreviewFromEntry } from "./workspace-shell-formatters";
import type { OutgoingMessage } from "./workspace-shell-helpers";

/**
 * The Channel as its writer sees it while a message of theirs to it is on the way: that message is its last one,
 * as its pending row is the timeline's (appendOutgoingTimelineItems), so whatever shows the Channel's last message,
 * such as a page's card for it, shows the message the moment it is sent rather than when the Hub has it.
 */
export function channelWithOutgoing(
  channel: ChannelSnapshot,
  outgoing: readonly OutgoingMessage[],
  currentUser?: { id: string; email: string; name?: string } | null,
): ChannelSnapshot {
  const newest = outgoing.reduce<OutgoingMessage | null>((found, message) => message.channelId === channel.id
    && message.status !== "failed" && (!found || Date.parse(message.sentAt) > Date.parse(found.sentAt)) ? message : found, null);
  if (!newest) return channel;
  if (channel.lastMessage && Date.parse(channel.lastMessage.sentAt) >= Date.parse(newest.sentAt)) return channel;
  const entry: ChannelMessage = {
    messageId: `pending:${newest.clientMessageId}`, channelId: channel.id, body: newest.body, sentAt: newest.sentAt,
    ...(newest.attachments.length > 0 ? { attachments: newest.attachments } : {}),
    from: {
      kind: "user", label: currentUser ? currentHumanDisplayName(currentUser) : "You",
      userId: currentUser?.id ?? "", email: currentUser?.email ?? "",
      // Drawn with the reader's face by their id (faceOfSender), as their sent messages are.
      ...(currentUser ? { identityId: `user:${currentUser.id}` } : {}),
    },
  };
  const lastMessage = channelLastMessagePreviewFromEntry(entry);
  return lastMessage ? { ...channel, lastMessage } : channel;
}
