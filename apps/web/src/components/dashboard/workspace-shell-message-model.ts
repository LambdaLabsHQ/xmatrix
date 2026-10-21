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
  QuestionnaireState,
  SerializedAgentInstance,
  ChannelSnapshot,
} from "@xmatrix/protocol";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { UserFacingProblem } from "../../lib/user-facing-error";
import type { CommandNotice } from "./command-notices";

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
  /** Browser-local source retained while this draft can switch upload quality. */
  sourceMedia?: { file: File; original: boolean };
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
      throw new UserFacingProblem("This draft contains an outdated attachment. Remove it and attach the file again.");
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
  threadChannel?: ChannelSnapshot;
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
  /** A questionnaire card's state as the Hub settled it: answered or withdrawn. */
  questionnaireState?: QuestionnaireState;
  /** Hub receipts for the command this message wrote, drawn on that command (command-notices.ts). */
  commandNotices?: CommandNotice[];
  /**
   * A folded row: the activity entries and superseded reports of one run of the
   * same sender, oldest first (conversation-activity-rows.ts). Never a message.
   */
  folded?: TimelineItem[];
  /** Same sender as the row above, moments later, with the same tags: no header. */
  continuation?: boolean;
  /**
   * Same sender moments later, but these header tags changed since `previous`:
   * the header shows only those, old → new (conversation-activity-rows.ts).
   */
  retagged?: { keys: string[]; previous: TimelineItem };
  /** Client-only outbound status while the POST is in flight or failed. */
  sendStatus?: "pending" | "unconfirmed" | "failed";
  sendError?: string;
  clientMessageId?: string;
};

/** Personal presentation of a parent's direct child Channels. */

export type ChannelNavItemProps = {
  channel: ChannelSnapshot;
  /** This Channel's events only (`channelEventViews`), so other Channels' events do not re-render the row. */
  events: readonly ObservabilityEvent[];
  active: boolean;
  unreadCount?: number;
  /* The reader's cursor for this Channel, and whether cursors are loaded. A
     message reaches the row's own Channel before the list hears of it; with
     these the row counts it then, so the badge moves with the preview. */
  readCount?: number;
  readCountsBaselineReady?: boolean;
  hasUnreadMention?: boolean;
  isPinnedRoot: boolean;
  /* The row passes its own Channel, so one stable handler serves every row. */
  onSelect: (channel: ChannelSnapshot) => void;
  onTogglePinned: (channel: ChannelSnapshot) => void;
  /** Present while the conversation waits on the reader: they are done with it. */
  onMarkDone?: (channel: ChannelSnapshot) => void;
  onOpenContextMenu: (
    channel: ChannelSnapshot,
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
  ) => void;
};

type MessageStatusChip = {
  id: string;
  label: string;
  value?: string;
  percent?: number;
  resetAt?: string;
};

/** Reply previews only carry a sequence when the quoted message actually has a usable one. */
export function replyPreviewSequence(sequence: number | undefined): { sequence?: number } {
  return typeof sequence === "number" && Number.isFinite(sequence) && sequence > 0
    ? { sequence }
    : {};
}

