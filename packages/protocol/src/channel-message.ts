/**
 * The one shape of a committed channel message.
 *
 * There is no second declaration. Live agent frames, live human frames, and
 * history reads all carry this object verbatim under `message`, so a message
 * cannot describe different things depending on how it reached the reader. How
 * a frame travels — delivery acks, interrupt hints, optimistic-echo
 * correlation — belongs on the frame around it, never in here.
 */
import type {
  ChannelAppMention,
  ChannelAttachment,
  ChannelMentionReadStatus,
  ChannelReaction,
  ChannelReplyContext,
  MessageSender,
} from "./authority.js";

/**
 * The bounded projection a parent-channel history page needs to render an
 * existing Thread without first loading that Thread through Channel Catalog.
 * Replies are the latest two non-root entries in chronological order; `replyCount` remains the
 * authoritative count of every non-root reply in the Thread.
 */
export interface ChannelMessageThreadSummary {
  channelId: string;
  updatedAt: string;
  replyCount: number;
  replies: ChannelMessage[];
}

export interface ChannelMessage {
  messageId: string;
  channelId: string;
  /** Monotonic per-channel sequence. Older persisted messages may not have one. */
  sequence?: number;
  /** Authority publication coordinates. Absent when an older transport cannot prove them. */
  entityVersion?: number;
  bodyHash?: string;
  from: MessageSender;
  body: string;
  sentAt: string;
  replyToMessageId?: string;
  replyTo?: ChannelReplyContext;
  attachments?: ChannelAttachment[];
  appMentions?: ChannelAppMention[];
  /** Rich metadata; live frames and history reads both use this one name. */
  metadata?: Record<string, unknown>;
  mentionReadStatuses?: ChannelMentionReadStatus[];
  /**
   * State a message accumulates after it is committed. A live frame simply has
   * none of it yet; that is a value difference, not a shape difference, so it
   * stays on the message instead of forking a second history-only declaration.
   */
  reactions?: ChannelReaction[];
  /** Present on parent history reads when this message already owns a Thread. */
  thread?: ChannelMessageThreadSummary;
  editedAt?: string;
  editedBy?: MessageSender;
  recalledAt?: string;
  /** A committed permanent-deletion tombstone; no payload or task-source evidence. */
  deletedAt?: string;
  recalledBy?: MessageSender;
  /**
   * The later message from the same sender that the Hub judged makes this one
   * obsolete, so readers fold it to a line (docs/design/conversation-activity.md
   * §3.3). Derived from the Hub's own annotation; never supplied by a sender.
   */
  supersededBy?: string;
}
