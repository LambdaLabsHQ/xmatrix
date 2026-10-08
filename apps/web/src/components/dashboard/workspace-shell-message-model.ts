import type { AgentTraceTargetLike } from "./agent-trace-target";
import type { ThreadReplyPreview } from "./thread-reply-preview";
import type { MessageLinkOrigin } from "./message-link-origin";
/**
 * Pure message/timeline model types and equality helpers.
 * No imports of workspace UI view modules (sidebar/composer/timeline/chrome).
 */
import type { LlmUsage, UsageLimitSummary } from "./workspace-shell-domain-types";
import type {
  MessageAttachmentBinding,
  PreparedMessageAttachmentUpload,
} from "@/lib/relay-v2/message-attachment-upload-client";
import type {
  AgentGoalStatus,
  AgentInvocationSelections,
  DraftSummonIntent,
  AgentRuntimeState,
  ChannelAttachment,
  ChannelMessage,
  ChannelReaction,
  ObservabilityEvent,
  SerializedAgentInstance,
  SerializedChannel,
} from "@xmatrix/protocol";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";

export type ComposerSendSnapshot = {
  body: string;
  invocationSelections?: AgentInvocationSelections;
  /** Jev's reading of each summon while the author typed this exact body. */
  summonIntents?: DraftSummonIntent[];
  attachments: ChannelAttachment[];
};

/** Channel attachment with optional in-flight Relay V2 upload binding. */
export type ComposerChannelAttachment = ChannelAttachment & {
  relayV2Upload?: PreparedMessageAttachmentUpload;
};

export type ChannelAgentAvatarItem = {
  key: string;
  member: string;
  instance: SerializedAgentInstance;
  connectedAt?: string;
  instanceIndex: number;
};

export type AgentWorkItem = {
  key: string;
  agentId: string;
  instance: SerializedAgentInstance;
  sortIndex: number;
  label: string;
  agentLabel: string;
  status: string;
  avatarUrl?: string;
  avatarKind?: "agent" | "system";
  activity?: string;
  intent?: string;
  files?: string[];
  usage?: LlmUsage;
  /**
   * Decided once by `agentInstanceUsageLimit`, not re-derived per surface: the
   * avatar renders this verdict rather than computing its own from `usage`.
   */
  usageLimit?: UsageLimitSummary;
  lastSeenAt?: string;
  latestEvent?: ObservabilityEvent;
  target: AgentTraceTarget;
  canStop?: boolean;
};

export type SystemNoticeTone = "fact" | "warning" | "error";

/**
 * Hub start/run notices are still `system_fact` provenance. The body is what
 * tells a human whether the fact is an ordinary narration, a queued wait, or a
 * hard failure — the timeline badge must follow that, or a silent queue looks
 * like a successful system fact.
 */
export function systemNoticeTone(body: string | undefined): SystemNoticeTone {
  const text = body?.trim() || "";
  if (/^xMatrix could not start/i.test(text) || /^Couldn't start @/i.test(text)) {
    return /queued|live control session|no live daemon/i.test(text)
      ? "warning"
      : "error";
  }
  if (/management overlay unavailable/i.test(text) || /usage limit/i.test(text)) {
    return "error";
  }
  return "fact";
}

export function messageProvenance(
  metadata: Record<string, unknown> | undefined
): TimelineItem["provenance"] {
  const value = metadata?.xmatrixProvenance;
  return value === "system_fact" ||
    value === "management_judgment" ||
    value === "approved_action_result"
    ? value
    : undefined;
}

/**
 * Rich metadata for one message. Live socket frames and channel history reads
 * both deliver it as `metadata`; they disagreed once, which silently dropped
 * provenance badges, request-broker cards, and system-notice identity on reload.
 */
export function messageRichMetadata(
  message: ChannelMessage
): Record<string, unknown> | undefined {
  return message.metadata;
}

/**
 * Hub system notices (stop results, machine requests, run failures) are written
 * under the owning user's principal so the relay can authorize the append, but
 * they are deterministic xMatrix facts, not something that user said. The hub
 * marks them with `xmatrixSystemNotice` and stamps the reserved xMatrix label on
 * the sender snapshot; without this check the timeline would treat them as human
 * messages and paint them with the owner's presence avatar.
 */
export function isXMatrixSystemNoticeMessage(message: ChannelMessage): boolean {
  if (messageRichMetadata(message)?.xmatrixSystemNotice !== true) return false;
  const label = message.from.label.trim().toLowerCase();
  return label === "xmatrix" || label.startsWith("xmatrix ");
}

export function timelineItemId(
  clientMessageId: string | undefined,
  messageId: string | undefined
): string {
  if (clientMessageId) return `client:${clientMessageId}`;
  if (messageId) return `message:${messageId}`;
  return `message:unknown`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function agentInstanceDisplayName(instance: SerializedAgentInstance): string {
  return instance.label || shortId(instance.id);
}

export function agentInstanceBranchLabel(instance: SerializedAgentInstance): string {
  return instance.gitBranch ? `branch ${instance.gitBranch}` : "branch not reported";
}

export function messageAttachmentBindings(
  attachments: readonly ChannelAttachment[],
): MessageAttachmentBinding[] {
  return attachments.map((attachment) => {
    const upload = (attachment as ComposerChannelAttachment).relayV2Upload;
    if (!upload) {
      throw new Error("This draft contains an outdated attachment. Remove it and attach the file again.");
    }
    const presentationResidual = {
      ...(attachment.durationMs === undefined ? {} : { durationMs: attachment.durationMs }),
      ...(attachment.width === undefined ? {} : { width: attachment.width }),
      ...(attachment.height === undefined ? {} : { height: attachment.height }),
      ...(attachment.transcodingStatus === undefined
        ? {}
        : { transcodingStatus: attachment.transcodingStatus }),
    };
    return {
      ...upload,
      ...(Object.keys(presentationResidual).length > 0 ? { presentationResidual } : {}),
    } satisfies MessageAttachmentBinding;
  });
}

export type AgentTraceTarget = AgentTraceTargetLike & {
  connectedAt?: string;
  name: string;
  status?: string;
  activity?: string;
  gitBranch?: string;
  goal?: AgentGoalStatus;
  avatarUrl?: string;
  runtimeState?: AgentRuntimeState;
  usage?: LlmUsage;
};

export type ThreadReplyParticipant = {
  id: string;
  author: string;
  avatarUrl?: string;
};

export type TimelineItem = {
  id: string;
  messageId?: string;
  channelId?: string;
  sequence?: number;
  author: string;
  body: string;
  replyToMessageId?: string;
  replyTo?: {
    messageId: string;
    author: string;
    body: string;
    /** Quoted message's own sequence, so a jump can seek instead of paging. */
    sequence?: number;
  };
  attachments?: ChannelAttachment[];
  metadata?: Record<string, unknown>;
  mentionReadStatuses?: ChannelMessage["mentionReadStatuses"];
  reactions?: ChannelReaction[];
  threadChannelId?: string;
  /** The child channel that owns replies to this message, when it exists. */
  threadChannel?: SerializedChannel;
  threadReplyCount?: number;
  threadUpdatedAt?: string;
  threadReplyParticipants?: ThreadReplyParticipant[];
  threadReplies?: ThreadReplyPreview[];
  editedAt?: string;
  recalledAt?: string;
  sentAt: string;
  avatarUrl?: string;
  own?: boolean;
  isEvent?: boolean;
  eventType?: ObservabilityEvent["type"];
  senderKind?: "agent" | "app" | "user" | "system";
  senderId?: string;
  senderOwnerLabel?: string;
  senderMachineLabel?: string;
  senderMachineId?: string;
  senderMachineOwnerUserId?: string;
  senderInstanceId?: string;
  senderMention?: string;
  senderStatus?: string;
  senderActivity?: string;
  senderInstanceStale?: boolean;
  /** Set when the message arrived over a cross-Channel link. */
  linkOrigin?: MessageLinkOrigin;
  senderGoal?: AgentGoalStatus;
  senderGitBranch?: string;
  senderStatusChips?: MessageStatusChip[];
  provenance?: "system_fact" | "management_judgment" | "approved_action_result";
  reservedSystemAgent?: boolean;
  /** The later message from the same sender the Hub judged makes this one obsolete. */
  supersededBy?: string;
  /**
   * A folded row: the activity entries and superseded reports of one run of the
   * same sender, oldest first (conversation-activity-rows.ts). Never a message.
   */
  folded?: TimelineItem[];
  /** Same sender as the row above, moments later, with the same tags: no header. */
  continuation?: boolean;
  /** Client-only outbound status while the POST is in flight or failed. */
  sendStatus?: "pending" | "unconfirmed" | "failed";
  sendError?: string;
  clientMessageId?: string;
};

/** Personal presentation of a parent's direct child Channels. */

export type ChannelNavItemProps = {
  channel: SerializedChannel;
  /** This Channel's events only (`channelEventViews`), so other Channels' events do not re-render the row. */
  events: readonly ObservabilityEvent[];
  active: boolean;
  unreadCount?: number;
  hasUnreadMention?: boolean;
  isPinnedRoot: boolean;
  /* The row passes its own Channel, so one stable handler serves every row. */
  onSelect: (channel: SerializedChannel) => void;
  onTogglePinned: (channel: SerializedChannel) => void;
  onOpenContextMenu: (
    channel: SerializedChannel,
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
  ) => void;
};

function agentGoalsEqual(
  previous?: AgentGoalStatus | null,
  next?: AgentGoalStatus | null
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return (
    previous.active === next.active &&
    previous.objective === next.objective &&
    previous.status === next.status &&
    previous.updatedAt === next.updatedAt
  );
}

type MessageStatusChip = {
  id: string;
  label: string;
  value?: string;
  percent?: number;
  resetAt?: string;
};

function statusChipsEqual(
  previous?: MessageStatusChip[],
  next?: MessageStatusChip[]
): boolean {
  if (previous === next) return true;
  if (!previous || !next || previous.length !== next.length) return false;
  return previous.every(
    (chip, index) =>
      chip.id === next[index]?.id &&
      chip.label === next[index]?.label &&
      chip.value === next[index]?.value &&
      chip.percent === next[index]?.percent &&
      chip.resetAt === next[index]?.resetAt
  );
}

function threadReplyParticipantsEqual(
  previous?: ThreadReplyParticipant[],
  next?: ThreadReplyParticipant[]
): boolean {
  if (previous === next) return true;
  if (!previous || !next || previous.length !== next.length) return false;
  return previous.every((item, index) => {
    const other = next[index];
    return (
      item.id === other?.id &&
      item.author === other?.author &&
      item.avatarUrl === other?.avatarUrl
    );
  });
}

/**
 * Reply previews only carry a sequence when the quoted message actually has a
 * usable one. Spreading this keeps `sequence: undefined` out of the preview so
 * the shallow preview comparison stays stable across rebuilds.
 */
export function replyPreviewSequence(sequence: number | undefined): { sequence?: number } {
  return typeof sequence === "number" && Number.isFinite(sequence) && sequence > 0
    ? { sequence }
    : {};
}

export function replyPreviewsEqual(
  previous: TimelineItem["replyTo"],
  next: TimelineItem["replyTo"]
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return (
    previous.messageId === next.messageId &&
    previous.author === next.author &&
    previous.body === next.body &&
    previous.sequence === next.sequence
  );
}

export function timelineMessagesEqual(previous: TimelineItem, next: TimelineItem): boolean {
  return (
    previous.id === next.id &&
    previous.messageId === next.messageId &&
    previous.channelId === next.channelId &&
    previous.sequence === next.sequence &&
    previous.author === next.author &&
    previous.body === next.body &&
    previous.replyToMessageId === next.replyToMessageId &&
    previous.attachments === next.attachments &&
    previous.metadata === next.metadata &&
    previous.mentionReadStatuses === next.mentionReadStatuses &&
    previous.reactions === next.reactions &&
    previous.threadChannelId === next.threadChannelId &&
    previous.threadChannel === next.threadChannel &&
    previous.threadReplyCount === next.threadReplyCount &&
    previous.threadUpdatedAt === next.threadUpdatedAt &&
    threadReplyParticipantsEqual(previous.threadReplies, next.threadReplies) &&
    (previous.threadReplies ?? []).every((reply, index) => reply.body === next.threadReplies?.[index]?.body) &&
    threadReplyParticipantsEqual(previous.threadReplyParticipants, next.threadReplyParticipants) &&
    previous.editedAt === next.editedAt &&
    previous.recalledAt === next.recalledAt &&
    previous.sentAt === next.sentAt &&
    previous.avatarUrl === next.avatarUrl &&
    previous.own === next.own &&
    previous.senderKind === next.senderKind &&
    previous.senderId === next.senderId &&
    previous.senderOwnerLabel === next.senderOwnerLabel &&
    previous.senderMachineLabel === next.senderMachineLabel &&
    previous.senderMachineId === next.senderMachineId &&
    previous.senderMachineOwnerUserId === next.senderMachineOwnerUserId &&
    previous.senderInstanceId === next.senderInstanceId &&
    previous.senderMention === next.senderMention &&
    previous.senderStatus === next.senderStatus &&
    previous.senderActivity === next.senderActivity &&
    previous.senderInstanceStale === next.senderInstanceStale &&
    previous.linkOrigin?.channelId === next.linkOrigin?.channelId &&
    previous.linkOrigin?.messageId === next.linkOrigin?.messageId &&
    previous.linkOrigin?.channelName === next.linkOrigin?.channelName &&
    agentGoalsEqual(previous.senderGoal, next.senderGoal) &&
    previous.senderGitBranch === next.senderGitBranch &&
    statusChipsEqual(previous.senderStatusChips, next.senderStatusChips) &&
    previous.reservedSystemAgent === next.reservedSystemAgent &&
    previous.sendStatus === next.sendStatus &&
    previous.sendError === next.sendError &&
    previous.clientMessageId === next.clientMessageId &&
    replyPreviewsEqual(previous.replyTo, next.replyTo) &&
    previous.isEvent === next.isEvent &&
    previous.eventType === next.eventType &&
    previous.supersededBy === next.supersededBy &&
    previous.continuation === next.continuation &&
    previous.provenance === next.provenance &&
    foldedItemsEqual(previous.folded, next.folded)
  );
}

/**
 * The rebuilt timeline with the previous build's items wherever they are
 * equal, and the previous array itself when every item is. The timeline is
 * rebuilt whenever a Channel or Agent presence changes, which in a busy Space
 * is many times a second; sharing keeps everything keyed on it (row memos, the
 * launch query's per-message key) from recomputing for messages that did not
 * change.
 */
export function shareTimelineItems(
  previous: readonly TimelineItem[],
  next: TimelineItem[],
): TimelineItem[] {
  if (!previous.length) return next;
  const previousById = new Map(previous.map((item) => [item.id, item]));
  let unchanged = previous.length === next.length;
  const shared = next.map((item, index) => {
    const before = previousById.get(item.id);
    const kept = before && timelineMessagesEqual(before, item) ? before : item;
    if (kept !== previous[index]) unchanged = false;
    return kept;
  });
  return unchanged ? (previous as TimelineItem[]) : shared;
}

function foldedItemsEqual(previous?: TimelineItem[], next?: TimelineItem[]): boolean {
  if (previous === next) return true;
  if (!previous || !next || previous.length !== next.length) return false;
  return previous.every((item, index) => timelineMessagesEqual(item, next[index]!));
}
