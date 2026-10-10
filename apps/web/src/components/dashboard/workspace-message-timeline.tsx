"use client";
import { messageMachineIdentity, registrationMachineBusy, registrationMachineName } from "./machine-name-presentation";
import { ZoomableAttachmentImage } from "./zoomable-attachment-image";
import { attachmentMediaType } from "./attachment-media-type";
import { MediaPlayer } from "./media-player";
import { AgentIdentityLabels } from "./agent-identity-labels";
import { BranchBadge, tagClass } from "./status-tag";
import { messageLinkOriginLabel, messageLinkOriginTitle, type MessageLinkOrigin } from "./message-link-origin";

import { sha256 } from "@noble/hashes/sha2.js";

import { nonOperationalMentionRanges, lowercaseHex } from "@xmatrix/protocol";
import { userErrorMessage } from "@/lib/user-facing-error";

export {
  replyPreviewsEqual,
  timelineMessagesEqual,
} from "./workspace-shell-message-model";


import { MESSAGE_SURFACE_METRICS_EVENT, messageSurfaceOf } from "./message-surface-metrics";

import {
  activateMessageAttachmentMediaStore,
  commitMessageAttachmentMedia,
  createMessageAttachmentMediaStore,
  deactivateMessageAttachmentMediaStore,
  releaseMessageAttachmentMediaStore,
} from "./message-attachment-media-store";

import {
  agentInstanceBranchLabel,
  type AgentTraceTarget,
} from "./workspace-shell-message-model";

import { agentInstanceDisplayStatus } from "./workspace-shell-presence";

import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { statusInkClass } from "@/components/ui/status-tone";

import {
  RichMessageContent,
  messageMarkdownComponents,
} from "./workspace-shell-rich-message";

import {
  COUNT_CHIP_MATERIAL_CLASS,
  EVENT_ICONS,
  QUICK_REACTION_EMOJIS,
  TIMELINE_OPENING_ROW_MIN_PX,
  TIMELINE_OPENING_TAIL_ROWS,
  TIMELINE_VIRTUAL_MIN_OVERSCAN_ITEMS,
  TIMELINE_VIRTUAL_VIEWPORT_PRELOAD_PX,
} from "./workspace-shell-constants";

import {
  createMessageMarkdownComponents,
  isLongMessageBody,
} from "./workspace-shell-formatters";

import {
  areMessageRowPropsEqual, type MessageRowChannel, type MessageRowComparableProps,
  attachmentDownloadHref,
  attachmentDownloadName,
  attachmentFetchHref,
  attachmentSource,
  canMentionMessageSender,
  canRebornMessageSender,
  clearMessageLongPress,
  copyImageAttachmentToClipboard,
  copyTextToClipboard,
  dataUrlToBlob,
  fixedContainingBlockRect, centeredToolbarPosition, morphPanelPosition, observeToolbarLayout,
  isMessageActionBypassTarget,
  isTimelineNearBottom,
  presentationAttachmentKind,
  productMessageAttachmentMediaClient,
  relayV2AttachmentMediaIdentity,
  resolveTimelineAnchor,
  timelineRowIsOnScreen,
  timelineRowIsSettled,
  useStableCallback,
} from "./workspace-shell-helpers";

import {
  channelAttachmentKindForMimeType,
  isThreadChannel,
} from "./workspace-shell-helpers-extra";

import { threadChipState } from "./thread-chip-state";
import { parsePresentedRoutingDecision, RoutingDecisionBoard } from "./routing-decision-board";

import {
  GoalStatusBadge,
  goalStatusBadgeLabel,
  MachineRunFailureNotice,
  StatusChipBadge,
  avatarInitials,
  buildAgentWorkItems,
  formatFileSize,
  formatTime,
  isMachineRunFailureNotice,
  presenceStatusLabel,
  provenanceBadgeClass,
  provenanceLabel,
  provenanceTitle,
  shouldShowProvenanceBadge,
} from "./workspace-shell-recovered";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";

import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";


import ReactMarkdown from "react-markdown";

import { Virtuoso, type Components as VirtuosoComponents, type ListItem, type VirtuosoHandle } from "react-virtuoso";
import { flushSync } from "react-dom";
import {
  TIMELINE_OPENING_ROW_ATTRIBUTE,
  TimelineOpeningTail,
  TimelineRowSlot,
  type TimelineOpeningMeasure,
} from "./timeline-opening-tail";
import { useTimelineReadingAnchor } from "./timeline-reading-anchor";
import { isJustSentRow, playTimelineSendRise } from "./timeline-send-rise";
import { FoldedActivityRow } from "./conversation-activity-row";
import {
  buildConversationRows,
  sinceDigest,
  sinceDigestLine,
  type SinceDigest,
} from "./conversation-activity-rows";
import { useChannelSupersessions } from "./use-channel-supersessions";
import { AgentWorkIntent, AgentWorkIntentCard, agentWaitingPhrase, useIntentSince, useNow } from "./agent-work-intent";
import { AgentRuntimeNotice, agentRuntimeIssuePhrase, agentRuntimeNoticePhrase } from "./agent-runtime-notice";

import { markdownRemarkPlugins } from "@/lib/markdown-plugins";



import { MESSAGE_BODY_ATTRIBUTE, selectedMessagePassage, type MessagePassageSelection } from "./selection-discussion";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Hash,
  Loader2,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  Pencil,
  RefreshCw,
  Reply,
  ArrowRightLeft,
  ArrowRight,
  SmilePlus,
  Trash2,
  X,
} from "lucide-react";

import { Textarea } from "@/components/ui/textarea";



import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { ContentSkeleton, LoadingImage, MediaSkeleton } from "@/components/dashboard/content-skeleton";



import {
  channelMentionCandidates,
  type MentionLocalContext,
} from "@/components/dashboard/mention-complete";

import {
  MentionReadChannelScopeProvider,
  MentionReadMessageScopeProvider,
  type MentionReadChannelScope,
  type MentionReadMessageScope,
} from "@/components/dashboard/mention-read-chip";
import { PageReferenceScopeProvider } from "@/components/dashboard/page-reference-chip";

import type { SerializedAgentInvocationRejection, SerializedAgentStop, AgentInvocationQueryPage, InteractionDecisionWindow,
  InteractionLaunchOption } from "@xmatrix/protocol";
import { firstMessageDecisionWindow, harnessLaunchOption, hasOperationalAgentInvocation, isAutoHandoffSuccessor, isHandoffSuccessorName, parseAutoLaunchMentions } from "@xmatrix/protocol";
import { UnpublishedTurnState } from "./unpublished-turn-status";
import { FirstMessageLaunchChoice } from "./first-message-launch-choice";
import { launchChoiceOffered, launchChoicePollInterval, launchChoiceView } from "./first-message-launch-choice-state";
import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { InvocationAccessError, invocationSourceMessages, loadInvocationPages } from "./mention-invocation-query";
import { invocationPollInterval } from "./mention-invocation-state";
import { buildMentionReadIndex, machineOfflineMentionSubjects, withInvocationMentionTargets } from "@/components/dashboard/mention-read-state";



import {
  formatMessageDateTime,
  formatMessageClockTime,
  formatMessageTimestamp,
} from "@/components/dashboard/channel-history";








import {
  scheduleTextareaSelection,
} from "@/components/dashboard/composer-caret";





import {
  channelTitle,
} from "@/components/dashboard/channel-links";

import { normalizeMessageBodyForDisplay } from "@/components/dashboard/message-text";

import { MobileInlineActions } from "./mobile-inline-actions";
import { useAndroidBackHandler } from "./use-android-back";






















import { cn } from "@/lib/utils";
import { CrossSpaceReadCard, crossSpaceReadMetadata } from "@/components/dashboard/cross-space-read-card";
import { SecretRequestCardView, secretRequestMetadata } from "@/components/dashboard/secret-request-card";

import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";


import type {
  ChannelAttachment,
  ChannelReaction,
  ObservabilityEvent,
  SerializedAgentLaunch,
  SerializedAgentContinuation,
  SerializedAgentInstance,
  SerializedChannel,
  SerializedSpace,
} from "@xmatrix/protocol";

// Semantic module extracted from workspace-app-shell (AST-safe)



export type { TimelineItem, ThreadReplyParticipant } from "./workspace-shell-message-model";
import type { TimelineItem } from "./workspace-shell-message-model";
import {
  AnsweredQuestionnairesProvider,
  QuestionnaireMessage,
  questionnaireMetadata,
} from "./questionnaire-card";



/**
 * Landing a message jump is index addressed, never DOM addressed. The timeline
 * is virtualized: a row outside the rendered window has no element at all, so
 * `document.getElementById` reports "not here" for a message that is loaded and
 * only a scroll away. The list owns its index space (`firstItemIndex` shifts
 * the index handed to `itemContent`), so it publishes the landing rather than
 * leaking that offset to callers.
 */
export type TimelineJumpOutcome =
  /** The row is on screen now. */
  | "landed"
  /** The row exists in the data but the virtualizer has not placed it yet. */
  | "settling"
  /** The message is not in the loaded window at all. */
  | "unavailable";

export type TimelineJumpHandle = {
  /** Issues the landing and reports what was actually observed, not what was asked for. */
  scrollToMessage: (messageId: string) => TimelineJumpOutcome;
};



function useChannelAgentLaunches(channel: SerializedChannel | null, token: string | null,
  timeline: readonly TimelineItem[], visibleMessageIds?: readonly string[], viewerIdentity?: string | null) {
  const launchSourceMessages = useMemo(() => invocationSourceMessages(timeline, visibleMessageIds),
    [timeline, visibleMessageIds]);
  const sourceMessageIds = useMemo(() => launchSourceMessages
    .map((message) => message.messageId || message.id), [launchSourceMessages]);
  const sourceRevisionKey = useMemo(() => launchSourceMessages.map(message => [
    lowercaseHex(sha256(new TextEncoder().encode(message.body))),
    message.editedAt, message.recalledAt,
  ]), [launchSourceMessages]);
  const newestSourceAt = launchSourceMessages.reduce((latest, message) =>
    Math.max(latest, Date.parse(message.sentAt) || 0), 0);
  return useQuery<AgentInvocationQueryPage>({
    queryKey: ["agent-launches", channel?.id, viewerIdentity, sourceMessageIds,
      sourceRevisionKey],
    enabled: Boolean(token && viewerIdentity && channel?.id && sourceMessageIds.length),
    retry: false,
    placeholderData: (previous, previousQuery) => {
      if (!previous || !previousQuery || previousQuery.queryKey[1] !== channel?.id ||
          previousQuery.queryKey[2] !== viewerIdentity || previousQuery.state.error instanceof InvocationAccessError) return undefined;
      const priorIds = previousQuery.queryKey[3] as readonly string[] | undefined;
      const priorRevisions = previousQuery.queryKey[4] as readonly unknown[] | undefined;
      const priorVersions = new Map(priorIds?.map((id, index) => [id, JSON.stringify(priorRevisions?.[index])]));
      const selected = new Set(sourceMessageIds.filter((id, index) => priorVersions.get(id) === JSON.stringify(sourceRevisionKey[index])));
      if (!selected.size) return undefined;
      return { launches: previous.launches.filter((launch) => selected.has(launch.sourceMessageId)),
        rejections: previous.rejections?.filter((rejection) => selected.has(rejection.sourceMessageId)),
        continuations: previous.continuations?.filter((record) => selected.has(record.sourceMessageId)),
        executions: previous.executions?.filter(record => selected.has(record.sourceMessageId)),
        stops: previous.stops?.filter(stop => selected.has(stop.sourceMessageId)), nextCursor: null };
    },
    queryFn: ({ signal }) => loadInvocationPages({ channelId: channel!.id, sourceMessageIds, signal,
      fetchPage: async (request, pageSignal) => {
        const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.channel_agent_launches(channel!.id), {
          method: "POST", signal: pageSignal, cache: "no-store",
          headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        if ([401, 403, 404].includes(response.status)) throw new InvocationAccessError(response.status);
        if (!response.ok) throw await errorFromResponse(response);
        return response.json();
      },
    }),
    refetchInterval: (query) => {
      const base = invocationPollInterval(query.state.data?.launches ?? [],
        newestSourceAt, Date.now(), query.state.status === "error", query.state.data?.continuations ?? [],
        query.state.data?.executions ?? [], query.state.data?.stops ?? []);
      // A first message's launch choice lasts seconds: follow it closely.
      const now = Date.now();
      const choice = launchChoicePollInterval([
        ...(query.state.data?.launchChoices ?? []).map(record => launchChoiceView(firstMessageDecisionWindow(record, []), {}, now)),
        ...launchSourceMessages.filter(message => offersLaunchChoice(message, channel))
          .map(message => launchChoiceView(undefined, { sentAt: message.sentAt }, now)),
      ]);
      return choice === undefined ? base : base === false ? choice : Math.min(base, choice);
    },
  });
}

/** The author's own first message of a new, unnamed conversation that
 * summons nobody: the Hub offers it a short launch choice. */
function offersLaunchChoice(message: TimelineItem, channel: SerializedChannel | null): boolean {
  return Boolean(message.own && message.senderKind === "user" && message.sequence === 1 &&
    channel?.metadata?.autoName === true && !message.recalledAt && !message.editedAt &&
    !hasOperationalAgentInvocation(message.body) && parseAutoLaunchMentions(message.body).length === 0 &&
    launchChoiceOffered(message.sentAt, Date.now()));
}

interface TimelineVirtuosoContext {
  header: ReactNode;
  footer: ReactNode;
}

const TIMELINE_VIRTUOSO_COMPONENTS: VirtuosoComponents<TimelineItem, TimelineVirtuosoContext> = {
  Header: ({ context }) => context.header,
  Footer: ({ context }) => context.footer,
};

export const MessageTimeline = memo(function MessageTimeline({
  channel,
  space,
  token,
  localContext,
  isJoined,
  loading,
  timeline,
  hasWorkDock,
  hasChannels,
  hasOlderMessages,
  olderLoading,
  error,
  timelineScrollRef,
  timelineJumpRef,
  messagesEndRef,
  onScrollPositionChange,
  onScrollGesture,
  onNearTop,
  onOpenAgentTrace,
  onOpenHumanProfile,
  currentUserIdentityId,
  onReact,
  onEdit,
  onRecall,
  onReply,
  onOpenThread,
  onDiscussPassage,
  onMentionSender,
  onRebornSender,
  reborningSenderKey,
  onQuestionnaireAnswer,
  onOpenInternalAppLink,
  onOpenPage,
  onJumpToMessage,
  onMessageExposed,
  highlightMessageId,
  threadRootMessage,
  threadRootChannel,
}: {
  channel: SerializedChannel | null;
  space: SerializedSpace | null;
  token: string | null;
  localContext?: MentionLocalContext | null;
  isJoined: boolean;
  loading: boolean;
  timeline: TimelineItem[];
  hasWorkDock: boolean;
  hasChannels: boolean;
  hasOlderMessages: boolean;
  olderLoading: boolean;
  error: string | null;
  timelineScrollRef: React.RefObject<HTMLDivElement | null>;
  timelineJumpRef: React.RefObject<TimelineJumpHandle | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onScrollPositionChange: (pinned: boolean, scrollTop: number) => void;
  onScrollGesture: () => void;
  onNearTop: () => void;
  onOpenAgentTrace: (target: AgentTraceTarget) => void;
  /** Opens the Profile view for a human sender. Slack: the avatar is a link. */
  onOpenHumanProfile: (userId: string) => void;
  currentUserIdentityId: string;
  /** Starts a conversation from a passage selected in a message's text. */
  onDiscussPassage?: (message: TimelineItem, quote: string) => void;
  reborningSenderKey: string | null;
  /** Opens a `page:<id>` chip from a message, at its section when it names one (pages-and-conversations.md §4.3). */
  onOpenPage: (pageId: string, blockId?: string | null) => void;
  onMessageExposed: (channelId: string, sequence: number) => void;
  highlightMessageId?: string;
  threadRootMessage?: TimelineItem;
  threadRootChannel?: SerializedChannel;
} & Pick<MessageRowComparableProps,
  "onReact" | "onEdit" | "onRecall" | "onReply" | "onOpenThread" | "onMentionSender" |
  "onRebornSender" | "onQuestionnaireAnswer" | "onOpenInternalAppLink" | "onJumpToMessage"
>) {
  const [visibleInvocationScope, setVisibleInvocationScope] = useState<{ channelId: string; ids: string[] } | null>(null);
  const visibleInvocationIds = visibleInvocationScope?.channelId === channel?.id ? visibleInvocationScope?.ids : undefined;
  const agentLaunchQuery = useChannelAgentLaunches(channel, token, timeline, visibleInvocationIds, currentUserIdentityId);
  const refetchAgentLaunches = agentLaunchQuery.refetch;
  const invocationQueryData = agentLaunchQuery.error instanceof InvocationAccessError ? undefined : agentLaunchQuery.data;
  const agentLaunchesByMessage = useMemo(() => {
    const grouped = new Map<string, SerializedAgentLaunch[]>();
    for (const launch of invocationQueryData?.launches ?? []) {
      const values = grouped.get(launch.sourceMessageId) ?? [];
      values.push(launch);
      grouped.set(launch.sourceMessageId, values);
    }
    return grouped;
  }, [invocationQueryData]);
  const invocationRejectionsByMessage = useMemo(() => {
    const grouped = new Map<string, SerializedAgentInvocationRejection[]>();
    for (const rejection of invocationQueryData?.rejections ?? []) {
      const values = grouped.get(rejection.sourceMessageId) ?? [];
      values.push(rejection);
      grouped.set(rejection.sourceMessageId, values);
    }
    return grouped;
  }, [invocationQueryData]);
  const stopsByMessage = useMemo(() => {
    const grouped = new Map<string, SerializedAgentStop[]>();
    for (const stop of invocationQueryData?.stops ?? []) {
      const values = grouped.get(stop.sourceMessageId) ?? [];
      values.push(stop);
      grouped.set(stop.sourceMessageId, values);
    }
    return grouped;
  }, [invocationQueryData]);
  const continuationsByMessage = useMemo(() => {
    const grouped = new Map<string, SerializedAgentContinuation[]>();
    for (const record of invocationQueryData?.continuations ?? []) {
      const values = grouped.get(record.sourceMessageId) ?? [];
      values.push(record);
      grouped.set(record.sourceMessageId, values);
    }
    return grouped;
  }, [invocationQueryData]);
  const launchChoicesByMessage = useMemo(() => new Map((invocationQueryData?.launchChoices ?? [])
    .map(choice => [choice.messageId, choice] as const)), [invocationQueryData]);
  const registrationCatalog = useAgentRegistrationCatalog(channel?.spaceId ?? "", token ?? "",
    Boolean(token && channel?.spaceId && (channel.metadata?.autoName === true || launchChoicesByMessage.size)));
  // What the reader may start, as launch options; the Hub's choice record becomes their decision window.
  const launchOptions = useMemo(() => (registrationCatalog.data?.capabilities ?? [])
    .filter(group => group.locations.some(location => location.state === "enabled" && location.routingReady))
    .map(group => harnessLaunchOption(group.harness)), [registrationCatalog.data]);
  const launchWindowsByMessage = useMemo(() => new Map([...launchChoicesByMessage]
    .map(([messageId, choice]) => [messageId, firstMessageDecisionWindow(choice, launchOptions)] as const)),
  [launchChoicesByMessage, launchOptions]);
  // What a row needs of its conversation. The catalog replaces the channel
  // object on every read receipt and presence change; a row keyed on that
  // object would render again each time, Markdown included.
  const channelId = channel?.id;
  const channelSpaceId = channel?.spaceId;
  const rowChannel = useMemo<MessageRowChannel | null>(
    () => (channelId && channelSpaceId ? { id: channelId, spaceId: channelSpaceId } : null),
    [channelId, channelSpaceId],
  );
  const chooseFirstLaunch = useCallback(async (messageId: string, body: string, harness: string | null | "shown") => {
    if (!token || !channelId) return;
    const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.channel_message_launch_choice(channelId, messageId), {
      method: "POST", cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ body, ...(harness === "shown" ? { shown: true } : harness ? { harness } : {}) }),
    });
    // Someone already decided: the refreshed record says what.
    if (!response.ok && response.status !== 409) throw await errorFromResponse(response);
    await refetchAgentLaunches();
  }, [channelId, refetchAgentLaunches, token]);
  const messageTargetEvidence = useMemo(() => {
    const grouped = new Map<string, { executions: NonNullable<AgentInvocationQueryPage["executions"]> }>();
    for (const execution of invocationQueryData?.executions ?? []) {
      const entry = grouped.get(execution.sourceMessageId) ?? { executions: [] };
      entry.executions.push(execution); grouped.set(execution.sourceMessageId, entry);
    }
    return grouped;
  }, [invocationQueryData]);
  const retryAgentLaunch = useCallback(async (launch: SerializedAgentLaunch) => {
    if (!token || !channelId) return;
    const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.agent_launch_retry(launch.launchId), {
      method: "POST", cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channelId }),
    });
    if (!response.ok) throw await errorFromResponse(response);
    await refetchAgentLaunches();
  }, [channelId, refetchAgentLaunches, token]);
  // The author answers Jev's intent question for one declined summon; the Hub
  // rechecks the body against the stored message and the caller's authorship.
  const launchAnyway = useCallback(async (messageId: string, body: string, sourceMention: string) => {
    if (!token || !channelId) return;
    const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.channel_message_launch_anyway(channelId, messageId), {
      method: "POST", cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ body, sourceMention }),
    });
    if (!response.ok) throw await errorFromResponse(response);
    await refetchAgentLaunches();
  }, [channelId, refetchAgentLaunches, token]);
  // One media store per channel view. A new one is built — and the previous
  // one released — whenever the channel, the viewer, or the session changes. Ordinary message progress is excluded
  // from the dependency list so it does not evict already-authorized media.
  const mediaStore = useMemo(
    () => createMessageAttachmentMediaStore({
      channelId: channel?.id ?? null,
      viewerId: currentUserIdentityId,
      authenticated: token !== null,
    }),
    [
      channel?.id,
      currentUserIdentityId,
      token,
    ],
  );
  useLayoutEffect(() => {
    // `released` is irreversible, but React development Strict Mode probes a
    // layout effect with cleanup + setup while reusing this useMemo result.
    // Re-activate that same store synchronously; a genuinely replaced store
    // stays inactive through the microtask and is then released exactly once.
    // This assumes cleanup and re-setup do not span a macrotask. If this tree
    // later uses Activity/Offscreen-style pause and resume semantics, release
    // must follow store identity instead of the transient `active` flag.
    activateMessageAttachmentMediaStore(mediaStore);
    return () => {
      deactivateMessageAttachmentMediaStore(mediaStore);
      queueMicrotask(() => {
        if (!mediaStore.active) releaseMessageAttachmentMediaStore(mediaStore);
      });
    };
  }, [mediaStore]);

  // Stable, so it runs when a row mounts and not on every render: the row a
  // send just added is marked `sent` on the render that mounts it.
  const handleTimelineRowMount = useCallback((row: HTMLDivElement | null) => {
    const scrollRoot = timelineScrollRef.current;
    if (row && scrollRoot && row.dataset.timelineRiseRow === "sent") {
      playTimelineSendRise(scrollRoot, row);
    }
  }, [timelineScrollRef]);

  const stableOnReact = useStableCallback(onReact);
  const stableOnEdit = useStableCallback(onEdit);
  const stableOnRecall = useStableCallback(onRecall);
  const stableOnReply = useStableCallback(onReply);
  const stableOnOpenThread = useStableCallback(onOpenThread);
  const stableOnMentionSender = useStableCallback(onMentionSender);
  const stableOnRebornSender = useStableCallback(onRebornSender);
  const stableOnQuestionnaireAnswer = useStableCallback(onQuestionnaireAnswer);
  const stableOnOpenAgentTrace = useStableCallback(onOpenAgentTrace);
  const stableOnOpenHumanProfile = useStableCallback(onOpenHumanProfile);
  const stableOnOpenInternalAppLink = useStableCallback(onOpenInternalAppLink);
  const stableOnMessageExposed = useStableCallback(onMessageExposed);
  const stableOnJumpToMessage = useStableCallback(onJumpToMessage);
  const stableOnScrollPositionChange = useStableCallback(onScrollPositionChange);
  const stableOnScrollGesture = useStableCallback(onScrollGesture);
  const stableOnNearTop = useStableCallback(onNearTop);
  const timelineVirtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [timelineScrollRoot, setTimelineScrollRootElement] = useState<HTMLDivElement | null>(null);
  const timelineUserGestureRef = useRef(false);
  const [timelineFirstItemIndex, setTimelineFirstItemIndex] = useState(1_000_000);
  const previousTimelineRef = useRef<{ channelId?: string; itemIds: string[] }>({ itemIds: [] });
  const hasTimelineContent = timeline.length > 0 || Boolean(threadRootMessage);
  // Talk stays whole; activity and superseded reports fold into one row per
  // run of the same Instance (docs/design/conversation-activity.md §4.1).
  const supersessions = useChannelSupersessions(channel?.id, token, timeline);
  const rows = useMemo(() => buildConversationRows(timeline, supersessions), [timeline, supersessions]);
  const [expandedFolds, setExpandedFolds] = useState<{ channelId?: string; ids: ReadonlySet<string> }>(
    () => ({ ids: new Set() }),
  );
  const openFolds = expandedFolds.channelId === channel?.id ? expandedFolds.ids : EMPTY_FOLDS;
  const toggleFold = useStableCallback((rowId: string) => {
    setExpandedFolds((current) => {
      const ids = new Set(current.channelId === channel?.id ? current.ids : EMPTY_FOLDS);
      if (ids.has(rowId)) ids.delete(rowId);
      else ids.add(rowId);
      return { channelId: channel?.id, ids };
    });
  });
  // Where the reader had read to when they opened the conversation: the
  // divider above it says what happened since (§3.5), until they leave.
  const [sincePosition, setSincePosition] = useState<{ channelId?: string; sequence?: number }>({});
  useEffect(() => {
    if (!channel?.id) return;
    if (sincePosition.channelId === channel.id && sincePosition.sequence !== undefined) return;
    setSincePosition({ channelId: channel.id, sequence: channel.readSequence });
  }, [channel?.id, channel?.readSequence, sincePosition.channelId, sincePosition.sequence]);
  const since = useMemo(() => sincePosition.channelId === channel?.id
    ? sinceDigest(rows, sincePosition.sequence, currentUserIdentityId) : undefined,
  [channel?.id, currentUserIdentityId, rows, sincePosition.channelId, sincePosition.sequence]);
  const sinceRowId = since ? rows[since.index]?.id : undefined;
  const isThread = Boolean(channel && isThreadChannel(channel));
  const readingAnchor = useTimelineReadingAnchor(timelineScrollRoot);
  // A conversation opens on a plain tail of its rows while the virtual list
  // lands behind it (timeline-opening-tail.tsx). The list is keyed by channel,
  // so each channel it mounts for opens this way once.
  const timelineListKey = channel?.id || "channel";
  const [landedListKey, setLandedListKey] = useState<string | null>(null);
  const [openingMeasure, setOpeningMeasure] = useState<TimelineOpeningMeasure | null>(null);
  const opening = rows.length > 0 && landedListKey !== timelineListKey;
  // The list adopts the tail's rows in one commit and the emptied tail goes in
  // the next, so each row moves between two nodes that are both in the page.
  const [tailHandedOver, setTailHandedOver] = useState(false);
  const tailMounted = opening || tailHandedOver;
  const openingRows = tailMounted
    ? rows.slice(-(openingScreenRows.get(timelineListKey) ?? Math.max(
      TIMELINE_OPENING_TAIL_ROWS,
      Math.ceil((timelineScrollRoot?.clientHeight ?? 0) / TIMELINE_OPENING_ROW_MIN_PX),
    )))
    : rows;
  const openingComplete = openingRows.length === rows.length;
  // The tail's rows render once, each into a host the list adopts afterwards.
  const openingHostsRef = useRef<{ key: string; hosts: Map<string, HTMLDivElement> }>({ key: "", hosts: new Map() });
  if (openingHostsRef.current.key !== timelineListKey) {
    openingHostsRef.current = { key: timelineListKey, hosts: new Map() };
  }
  const openingHosts = openingHostsRef.current.hosts;
  if (opening && typeof document !== "undefined") {
    for (const row of openingRows) {
      if (!openingHosts.has(row.id)) openingHosts.set(row.id, document.createElement("div"));
    }
  }
  const handleOpeningMeasured = useCallback((measure: TimelineOpeningMeasure) => {
    rememberOpeningScreenRows(timelineListKey, measure.screenRows);
    setOpeningMeasure(measure);
  }, [timelineListKey]);
  const handleOpeningLanded = useCallback(() => {
    // Both commits before the next frame: the rows change hands in place.
    flushSync(() => {
      setLandedListKey(timelineListKey);
      setTailHandedOver(true);
    });
    flushSync(() => {
      setTailHandedOver(false);
      setOpeningMeasure(null);
    });
  }, [timelineListKey]);
  useLayoutEffect(() => {
    // The list unmounts with its content and opens again when it returns.
    if (hasTimelineContent) return;
    openingHostsRef.current.hosts.clear();
    if (landedListKey !== null) setLandedListKey(null);
  }, [hasTimelineContent, landedListKey]);

  const setTimelineScrollRoot = useCallback((node: HTMLDivElement | null) => {
    timelineScrollRef.current = node;
    setTimelineScrollRootElement(node);
  }, [timelineScrollRef]);

  useLayoutEffect(() => {
    timelineUserGestureRef.current = false;
    readingAnchor.release();
  }, [channel?.id, readingAnchor]);

  /** The message a jump has scrolled toward and not yet seen centred. */
  const jumpScrollTargetRef = useRef<string | null>(null);
  const scrollToMessage = useStableCallback((messageId: string): TimelineJumpOutcome => {
    const container = timelineScrollRef.current;
    const anchorHash = `#message:${messageId}`;
    const index = rows.findIndex((item) => item.messageId === messageId ||
      item.folded?.some((entry) => entry.messageId === messageId));
    if (index < 0) return "unavailable";
    // An entry inside a fold has no row of its own until the fold is open.
    const fold = rows[index]?.folded ? rows[index] : undefined;
    if (fold && !openFolds.has(fold.id)) toggleFold(fold.id);
    readingAnchor.release();
    // A jump leaves the bottom, so the list shows its own rows from here on.
    if (opening) {
      setLandedListKey(timelineListKey);
      setOpeningMeasure(null);
    }
    const list = timelineVirtuosoRef.current;
    if (!list) {
      // The list has not mounted yet, so the row - if it is on the page at all
      // - is a plain anchor. It still has to be seen to count as landed.
      const element = resolveTimelineAnchor(anchorHash, container);
      if (!element) return "unavailable";
      element.scrollIntoView({ block: "center" });
      return timelineRowIsOnScreen(element, container) ? "landed" : "settling";
    }
    const row = resolveTimelineAnchor(anchorHash, container);
    // A visible row is not moved, unless this jump scrolled it there (to
    // estimated heights): then it lands only once centred.
    if (timelineRowIsOnScreen(row, container) &&
      (jumpScrollTargetRef.current !== messageId || timelineRowIsSettled(row, container))) {
      jumpScrollTargetRef.current = null;
      return "landed";
    }
    // Virtuoso's imperative index space is the data index; `firstItemIndex`
    // only shifts the index reported to `itemContent`, so it is not applied
    // here.
    list.scrollToIndex({ index, align: "center" });
    jumpScrollTargetRef.current = messageId;
    // One call is not a landing. When this jump follows a merged history page,
    // the virtualizer has not ingested that page yet and its prepend anchoring
    // runs after us, so the scroll above is undone. Report what actually
    // happened and let the jump state machine re-issue.
    const placed = resolveTimelineAnchor(anchorHash, container);
    if (timelineRowIsOnScreen(placed, container) && timelineRowIsSettled(placed, container)) {
      jumpScrollTargetRef.current = null;
      return "landed";
    }
    return "settling";
  });

  useLayoutEffect(() => {
    timelineJumpRef.current = { scrollToMessage };
    return () => {
      timelineJumpRef.current = null;
    };
  }, [scrollToMessage, timelineJumpRef]);

  const handleTimelineScrollGesture = useStableCallback(() => {
    timelineUserGestureRef.current = true;
    stableOnScrollGesture();
    // A short window is already at the top, so Virtuoso has no state
    // transition to report after the reader starts a wheel/touch gesture.
    // Let that same real gesture start its first bounded keyset read.
    if (timelineScrollRoot && timelineScrollRoot.scrollTop <= 240) stableOnNearTop();
  });

  const previousTimeline = previousTimelineRef.current;
  const previousFirstItemIndex = previousTimeline.channelId === channel?.id && previousTimeline.itemIds.length > 0
    ? rows.findIndex((message) => message.id === previousTimeline.itemIds[0])
    : -1;
  const prependedItemCount = previousFirstItemIndex > 0 && previousTimeline.itemIds.every(
    (itemId, index) => rows[previousFirstItemIndex + index]?.id === itemId,
  )
    ? previousFirstItemIndex
    : 0;
  // Virtuoso retains the visible anchor when this index decreases by exactly
  // the number of rows prepended to the history window.
  const nextTimelineFirstItemIndex = previousTimeline.channelId !== channel?.id
    ? 1_000_000
    : prependedItemCount > 0
      ? timelineFirstItemIndex - prependedItemCount
      : timelineFirstItemIndex;
  // The DOM still shows the pre-prepend layout while this render runs; the
  // commit below pins the reader's message back to where it is now.
  if (prependedItemCount > 0) readingAnchor.snapshot(rows);

  useLayoutEffect(() => {
    previousTimelineRef.current = { channelId: channel?.id, itemIds: rows.map((message) => message.id) };
    readingAnchor.apply(rows);
    if (nextTimelineFirstItemIndex !== timelineFirstItemIndex) {
      setTimelineFirstItemIndex(nextTimelineFirstItemIndex);
    }
  }, [channel?.id, nextTimelineFirstItemIndex, readingAnchor, rows, timelineFirstItemIndex]);

  const handleTimelineAtTopStateChange = useStableCallback((atTop: boolean) => {
    if (!atTop || loading || olderLoading || !hasOlderMessages || timeline.length === 0) return;
    // Virtuoso can report the top state while it applies its initial landing
    // at the newest item. Do not turn that programmatic mount into a history
    // request: a real wheel/touch gesture owns pagination.
    if (!timelineUserGestureRef.current) return;
    stableOnNearTop();
  });

  const handleTimelineItemsRendered = useStableCallback((items: ListItem<TimelineItem>[]) => {
    if (channel?.id) {
      const currentIds = new Set(timeline.map((message) => message.messageId || message.id));
      const ids = items.flatMap(({ data }) => data && currentIds.has(data.messageId || data.id)
        ? [data.messageId || data.id] : []);
      setVisibleInvocationScope((previous) => previous?.channelId === channel.id &&
        previous.ids.length === ids.length && previous.ids.every((id, index) => id === ids[index])
        ? previous : { channelId: channel.id, ids });
    }
    const exposedHighWaterByChannel = new Map<string, number>();
    for (const { data: message } of items) {
      const channelId = message?.channelId ?? channel?.id;
      const sequence = message?.sequence;
      if (!channelId || typeof sequence !== "number" || !Number.isFinite(sequence) || sequence <= 0) {
        continue;
      }
      exposedHighWaterByChannel.set(
        channelId,
        Math.max(exposedHighWaterByChannel.get(channelId) || 0, sequence),
      );
    }
    for (const [channelId, sequence] of exposedHighWaterByChannel) {
      stableOnMessageExposed(channelId, sequence);
    }
  });

  // One index per Channel membership change, shared by every mention chip in
  // the timeline: resolving `@name` per message would rebuild the same member
  // table for every row.
  const mentionReadScope = useMemo<MentionReadChannelScope>(() => ({
    index: withInvocationMentionTargets(buildMentionReadIndex(
      channelMentionCandidates(channel, localContext, [], space)
    ), invocationQueryData?.launches ?? []),
    ...(channel?.memberReadSequences ? { memberReadSequences: channel.memberReadSequences } : {}),
    ...(currentUserIdentityId ? { currentUserIdentityId } : {}),
    machineOfflineSubjectIds: machineOfflineMentionSubjects(channel),
  }), [channel, currentUserIdentityId, localContext, space, invocationQueryData]);

  const pageReferenceScope = useMemo(() => {
    const spaceId = space?.id ?? channel?.spaceId;
    if (!spaceId || !token) return null;
    return { spaceId, token, onOpenPage };
  }, [space?.id, channel?.spaceId, token, onOpenPage]);

  const timelineFooterClassName = cn(
    "app-message-timeline-scroll-end pb-4",
    hasWorkDock && "app-message-timeline-scroll-end-work-dock",
  );
  const timelineHeader = (
              <div className="pt-4" data-timeline-rise-row="">
                {/* The top bar already carries the channel's name, visibility
                    and topic. Repeating them here as an icon, a title and a
                    #name stacked three names above the first message, so the
                    intro only holds what the top bar does not say. */}

          {error && (
            <div className="mx-5 mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {hasOlderMessages && (
            // The slot stays h-8 whether or not it is loading. Virtuoso treats
            // this header as part of the list, so a taller skeleton moves the
            // message the reader is looking at when an older page arrives.
            <div
              data-testid="older-history-loader"
              className="mb-3 flex h-8 items-center px-5"
              role={olderLoading ? "status" : undefined}
              aria-label={olderLoading ? "Loading older messages" : undefined}
            >
              {olderLoading && (
                <span className="app-content-skeleton-line" data-width="medium" aria-hidden="true" />
              )}
            </div>
          )}

          {threadRootMessage && threadRootChannel && (
            <div className="mb-2 border-b border-border/70 pb-3">
              <p className="px-5 pb-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                Thread started from
              </p>
              <MessageRow
                message={threadRootMessage}
                agentLaunches={NO_LAUNCHES}
                agentStops={NO_STOPS}
                invocationRejections={NO_REJECTIONS}
                launchStatusUnavailable={false}
                onRetryAgentLaunch={retryAgentLaunch}
                contextOnly
                initiallyExpanded
                currentUserIdentityId={currentUserIdentityId}
                channel={threadRootChannel}
                token={token}
                mediaStore={mediaStore}
                isJoined={isJoined}
                onReact={stableOnReact}
                onEdit={stableOnEdit}
                onRecall={stableOnRecall}
                onReply={stableOnReply}
                onOpenThread={stableOnOpenThread}
                onMentionSender={stableOnMentionSender}
                onRebornSender={stableOnRebornSender}
                reborningSender={false}
                onQuestionnaireAnswer={stableOnQuestionnaireAnswer}
                onOpenAgentTrace={stableOnOpenAgentTrace}
                onOpenHumanProfile={stableOnOpenHumanProfile}
                onOpenInternalAppLink={stableOnOpenInternalAppLink}
                onJumpToMessage={stableOnJumpToMessage}
              />
            </div>
          )}

              </div>
  );
  const renderTimelineRow = (_index: number, message: TimelineItem) => (
              <div
                key={message.id}
                id={messageAnchorId(message)}
                ref={handleTimelineRowMount}
                data-timeline-rise-row={isJustSentRow(message) ? "sent" : ""}
                data-exposure-channel={message.channelId ?? channel?.id}
                data-exposure-sequence={
                  typeof message.sequence === "number" && Number.isFinite(message.sequence) && message.sequence > 0
                    ? message.sequence
                    : undefined
                }
                className={cn(
                  // Not ring/rounded utilities: the app theme rewrites
                  // .rounded-md to a 999px pill, which turns tall messages
                  // into a giant ellipse.
                  // A folded row has no message id of its own; it is never the jump target.
                  message.messageId && message.messageId === highlightMessageId &&
                    "scroll-mt-20 message-jump-highlight"
                )}
              >
                {since && message.id === sinceRowId && <SinceDivider digest={since} />}
                {message.folded ? (
                  <FoldedActivityRow
                    row={message}
                    expanded={openFolds.has(message.id)}
                    onToggle={toggleFold}
                  />
                ) : (
                <MessageRow
                  message={message}
                  agentLaunches={agentLaunchesByMessage.get(message.messageId || message.id) ?? NO_LAUNCHES}
                  agentStops={stopsByMessage.get(message.messageId || message.id) ?? NO_STOPS}
                  stopReceiptsLoaded={agentLaunchQuery.data !== undefined || agentLaunchQuery.isError}
                  invocationRejections={invocationRejectionsByMessage.get(message.messageId || message.id) ?? NO_REJECTIONS}
                  continuationInvocations={continuationsByMessage.get(message.messageId || message.id) ?? NO_CONTINUATIONS}
                  messageTargetEvidence={messageTargetEvidence.get(message.messageId || message.id)}
                  launchStatusUnavailable={agentLaunchQuery.isError}
                  onRetryAgentLaunch={retryAgentLaunch}
                  onLaunchAnyway={launchAnyway}
                  launchWindow={launchWindowsByMessage.get(message.messageId || message.id)}
                  launchChoiceOffered={offersLaunchChoice(message, channel)}
                  launchOptions={launchOptions}
                  onLaunchChoice={chooseFirstLaunch}
                  initiallyExpanded={isThread && _index < (threadRootMessage ? 1 : 2)}
                  currentUserIdentityId={currentUserIdentityId}
                  channel={rowChannel}
                  token={token}
                    mediaStore={mediaStore}
                  isJoined={isJoined}
                  onReact={stableOnReact}
                  onEdit={stableOnEdit}
                  onRecall={stableOnRecall}
                  onReply={stableOnReply}
                  onOpenThread={stableOnOpenThread}
                  onMentionSender={stableOnMentionSender}
                  onRebornSender={stableOnRebornSender}
                  reborningSender={
                    Boolean(reborningSenderKey) &&
                    (message.senderInstanceId === reborningSenderKey ||
                      message.senderMention === reborningSenderKey ||
                      message.messageId === reborningSenderKey ||
                      message.author === reborningSenderKey)
                  }
                  onQuestionnaireAnswer={stableOnQuestionnaireAnswer}
                  onOpenAgentTrace={stableOnOpenAgentTrace}
                  onOpenHumanProfile={stableOnOpenHumanProfile}
                  onOpenInternalAppLink={stableOnOpenInternalAppLink}
                  onJumpToMessage={stableOnJumpToMessage}
                />
                )}
              </div>
  );
  const measuredRowHeights = openingMeasure ? Array.from(openingMeasure.rowHeights.values()) : [];
  // Rows above the tail have no measured height yet; they land on the average.
  const openingFallbackRowHeight = measuredRowHeights.length > 0
    ? measuredRowHeights.reduce((sum, height) => sum + height, 0) / measuredRowHeights.length
    : 64;

  return (
    <PageReferenceScopeProvider scope={pageReferenceScope}>
    <AnsweredQuestionnairesProvider timeline={timeline}>
    <MentionReadChannelScopeProvider scope={mentionReadScope}>
    <div
      ref={setTimelineScrollRoot}
      /* A real gesture always beats an automatic scroll: reading back through
         history right after opening a channel must not be undone by the
         landing that is still settling. */
      onTouchStart={handleTimelineScrollGesture}
      onWheel={handleTimelineScrollGesture}
      onScroll={(event) => {
        const scrollTop = event.currentTarget.scrollTop;
        stableOnScrollPositionChange(
          isTimelineNearBottom(event.currentTarget),
          scrollTop
        );
      }}
      className={cn(
        "app-message-timeline min-h-0 flex-1 overflow-y-auto bg-card",
        hasWorkDock && "app-message-timeline-work-dock-offset"
      )}
    >
      {/* A refresh must not hide already-rendered rows.
          Skeleton only when there is nothing to show yet. */}
      {loading && !hasTimelineContent && (
        <MessageTimelineSkeleton messageCount={channel?.messageCount} />
      )}

      {!loading && !hasChannels && (
        <EmptyConversation
          title="No channels"
          body="Mention an agent to create an instance."
        />
      )}

      {!loading && hasChannels && !channel && (
        <EmptyConversation
          title="No conversation open"
          body="Pick one from the list, or start a new one."
        />
      )}

      {!loading && hasChannels && channel && !hasTimelineContent && (
        <EmptyConversation
          title={`#${channelTitle(channel)}`}
          body={
            error
              ? error
              : "No messages yet."
          }
        />
      )}

      {tailMounted && timelineScrollRoot && (
        <TimelineOpeningTail
          // Its own key: the list beside it is keyed by the channel alone.
          key={`opening:${timelineListKey}`}
          scrollRoot={timelineScrollRoot}
          complete={openingComplete}
          header={timelineHeader}
          footerClassName={timelineFooterClassName}
          onMeasured={handleOpeningMeasured}
          onLanded={handleOpeningLanded}
        >
          {openingRows.map((message) => {
            const host = openingHosts.get(message.id);
            return host && (
              <TimelineRowSlot key={message.id} host={host} {...{ [TIMELINE_OPENING_ROW_ATTRIBUTE]: message.id }} />
            );
          })}
        </TimelineOpeningTail>
      )}
      {openingHosts.size > 0 && rows.map((message, index) => {
        const host = openingHosts.get(message.id);
        return host ? createPortal(renderTimelineRow(nextTimelineFirstItemIndex + index, message), host, message.id) : null;
      })}

      {hasTimelineContent && timelineScrollRoot && (
        <Virtuoso
          key={timelineListKey}
          ref={timelineVirtuosoRef}
          customScrollParent={timelineScrollRoot}
          // Measure in this layout pass so delayed virtualizer compensation
          // cannot be mistaken for a new reader scroll by the prepend anchor.
          skipAnimationFrameInResizeObserver
          data={rows}
          firstItemIndex={nextTimelineFirstItemIndex}
          initialTopMostItemIndex={{ index: "LAST", align: "end" }}
          // Render a bounded buffer beyond the viewport. Without it, a quick
          // upward scroll can outrun dynamic row measurement and briefly show
          // the timeline surface before the next messages mount.
          increaseViewportBy={TIMELINE_VIRTUAL_VIEWPORT_PRELOAD_PX}
          minOverscanItemCount={TIMELINE_VIRTUAL_MIN_OVERSCAN_ITEMS}
          // `startReached` is tied to the absolute list index and misses this
          // inverse timeline because its first item index intentionally stays
          // positive for prepend anchoring. The virtualizer's top-state API is
          // scroll-position based, so it reliably requests the next keyset
          // page before a reader reaches the visible boundary.
          atTopThreshold={240}
          atTopStateChange={handleTimelineAtTopStateChange}
          computeItemKey={(_index, message) => message.id}
          itemsRendered={handleTimelineItemsRendered}
          components={TIMELINE_VIRTUOSO_COMPONENTS}
          // Header and Footer are stable components that render this
          // context. An inline component is a new type on every render, so
          // React remounted the whole header - intro, loader, thread root -
          // each time the timeline rendered.
          context={{
            // While the tail is up the list holds its place and draws nothing:
            // the tail shows the header when it shows every row.
            header: opening
              ? openingComplete
                ? <div style={{ height: openingMeasure?.headerHeight ?? 0 }} />
                : <div className="invisible">{timelineHeader}</div>
              : timelineHeader,
            // This footer belongs to Virtuoso's measured content. Its class
            // receives the same composer and dock clearance that the
            // non-virtualized timeline's content wrapper used to receive.
            footer: (
              <div ref={messagesEndRef} className={timelineFooterClassName} />
            ),
          }}
          // A blank of the row's measured height until the list has landed;
          // then the rows the tail drew move in, and the rest render here.
          itemContent={(index, message) => {
            if (opening) {
              return <div style={{ height: openingMeasure?.rowHeights.get(message.id) ?? openingFallbackRowHeight }} />;
            }
            const host = openingHosts.get(message.id);
            return host ? <TimelineRowSlot host={host} /> : renderTimelineRow(index, message);
          }}
        />
      )}
      {onDiscussPassage && (
        <MessagePassageDiscuss rootRef={timelineScrollRef} onDiscuss={(messageId, quote) => {
          const message = timeline.find((item) => item.messageId === messageId);
          if (message) onDiscussPassage(message, quote);
        }} />
      )}
    </div>
    </MentionReadChannelScopeProvider>
    </AnsweredQuestionnairesProvider>
    </PageReferenceScopeProvider>
  );
});

/**
 * "Discuss" beside a passage selected in one message's text, as a page offers
 * it on a selected passage: a new conversation that opens holding the quote.
 */
function MessagePassageDiscuss({ rootRef, onDiscuss }: {
  rootRef: React.RefObject<HTMLDivElement | null>;
  onDiscuss: (messageId: string, quote: string) => void;
}) {
  const [passage, setPassage] = useState<MessagePassageSelection | null>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = rootRef.current;
        setPassage(root ? selectedMessagePassage(document.getSelection(), root) : null);
      });
    };
    document.addEventListener("selectionchange", update);
    // The button follows its passage while the timeline scrolls.
    window.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", update);
    };
  }, [rootRef]);
  if (!passage || typeof document === "undefined") return null;
  // Above the passage, unless that is off the top or a phone's own selection menu sits there.
  const below = passage.rect.top < 56 || window.matchMedia("(pointer: coarse)").matches;
  return createPortal(
    <div className={cn("fixed z-50", !below && "-translate-y-full")}
      style={{ left: Math.max(8, Math.min(passage.rect.left, window.innerWidth - 128)),
        top: below ? passage.rect.bottom + 6 : passage.rect.top - 6 }}>
      <div role="toolbar" aria-label="Selection" data-testid="message-selection-menu"
        className="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground">
        <button type="button" onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onDiscuss(passage.messageId, passage.quote);
            document.getSelection()?.removeAllRanges();
          }}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-accent [&_svg]:size-4">
          <MessageSquarePlus /> Discuss
        </button>
      </div>
    </div>,
    document.body,
  );
}



export function timelineBelongsToChannel(timeline: TimelineItem[], channelId: string): boolean {
  return timeline.every((message) => message.channelId === undefined || message.channelId === channelId);
}



export function messageAnchorId(message: TimelineItem): string | undefined {
  return message.messageId ? `message:${message.messageId}` : undefined;
}



/* How many rows filled each conversation's screen when it last opened. It
   opens on that many again, plus the ones a taller screen or shorter messages
   may need, so reopening one renders no more than it shows. */
const OPENING_SCREEN_ROWS_LIMIT = 200;
const OPENING_SCREEN_ROWS_SPARE = 2;
const openingScreenRows = new Map<string, number>();
function rememberOpeningScreenRows(listKey: string, screenRows: number): void {
  openingScreenRows.delete(listKey);
  if (openingScreenRows.size >= OPENING_SCREEN_ROWS_LIMIT) {
    openingScreenRows.delete(openingScreenRows.keys().next().value!);
  }
  openingScreenRows.set(listKey, screenRows + OPENING_SCREEN_ROWS_SPARE);
}

const EMPTY_FOLDS: ReadonlySet<string> = new Set();
/* Rows are memoized on identity: a fresh `[]` per render would re-render every
   visible message, Markdown included, on each realtime event in the Space. */
const NO_LAUNCHES: readonly SerializedAgentLaunch[] = [];
const NO_REJECTIONS: readonly SerializedAgentInvocationRejection[] = [];
const NO_CONTINUATIONS: readonly SerializedAgentContinuation[] = [];
const NO_STOPS: readonly SerializedAgentStop[] = [];

/** Where the reader had read to, and what happened since (conversation-activity.md §3.5). */
function SinceDivider({ digest }: { digest: SinceDigest }) {
  return (
    <div className="app-since-divider flex items-center gap-3 px-5 py-2" role="separator"
      aria-label={sinceDigestLine(digest)}>
      <span className="h-px min-w-4 flex-1 bg-primary/40" aria-hidden="true" />
      <span className="max-w-[80%] truncate text-[11px] font-bold text-primary">{sinceDigestLine(digest)}</span>
      <span className="h-px min-w-4 flex-1 bg-primary/40" aria-hidden="true" />
    </div>
  );
}

export function EmptyConversation({ title, body }: { title: string; body: string }) {
  return (
    <div className="app-empty-conversation flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="app-empty-conversation-mark flex size-14 items-center justify-center rounded-xl bg-muted">
        <Hash className="size-7 text-muted-foreground" />
      </div>
      <h2 className="app-empty-conversation-title mt-4 text-xl font-black">{title}</h2>
      <p className="app-empty-conversation-body mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
    </div>
  );
}



export function MessageTimelineSkeleton({ messageCount }: { messageCount?: number }) {
  const knownMessageCount = Number.isSafeInteger(messageCount) && (messageCount || 0) > 0
    ? messageCount
    : undefined;
  const formattedMessageCount = knownMessageCount?.toLocaleString();
  return (
    <div
      className="app-message-timeline-skeleton flex min-h-full flex-col justify-end gap-5 px-5 pb-28 pt-8"
      role="status"
      aria-label={formattedMessageCount
        ? `Loading history for ${formattedMessageCount} messages`
        : "Loading messages"}
    >
      <MessageSkeletonRows />
    </div>
  );
}

function MessageSkeletonLine({ kind }: { kind: "name" | "long" | "medium" | "short" }) {
  const shape = {
    name: "app-message-skeleton-line-name block h-2 w-20",
    long: "app-message-skeleton-line-long block h-2.5 w-4/5",
    medium: "app-message-skeleton-line-medium block h-2.5 w-3/5",
    short: "app-message-skeleton-line-short block h-2.5 w-2/5",
  }[kind];
  return (
    <span className={`app-message-skeleton-line ${shape} animate-pulse rounded-full bg-muted`} />
  );
}

function MessageSkeletonRow({
  lines,
  compact = false,
}: {
  lines: ReadonlyArray<"name" | "long" | "medium" | "short">;
  compact?: boolean;
}) {
  return (
    <div className={cn(
      "app-message-skeleton-row flex items-start gap-3",
      compact && "app-message-skeleton-row-compact pl-11",
    )}>
      {compact ? null : (
        <span className="app-message-skeleton-avatar size-8 shrink-0 animate-pulse rounded-full bg-muted" />
      )}
      <span className="app-message-skeleton-copy flex min-w-0 flex-1 flex-col gap-2 pt-1">
        {lines.map((kind, index) => (
          <MessageSkeletonLine key={`${kind}-${index}`} kind={kind} />
        ))}
      </span>
    </div>
  );
}

function MessageSkeletonRows() {
  return (
    <div className="flex w-full max-w-3xl flex-col gap-5" aria-hidden="true">
      <MessageSkeletonRow lines={["name", "long", "short"]} />
      <MessageSkeletonRow compact lines={["name", "medium"]} />
      <MessageSkeletonRow lines={["name", "long", "medium"]} />
    </div>
  );
}



export function MessageTimestamp({ value, clock = false, className }: { value: string; clock?: boolean; className?: string }) {
  const fullDateTime = formatMessageDateTime(value);
  return (
    <time
      dateTime={value}
      title={fullDateTime}
      className={cn("app-message-timestamp shrink-0 tabular-nums", className)}
    >
      {clock ? formatMessageClockTime(value) : formatMessageTimestamp(value)}
    </time>
  );
}



function NamedAgentIdentityLabels({ message, spaceId, token }: {
  message: TimelineItem; spaceId?: string; token: string | null;
}) {
  const catalog = useAgentRegistrationCatalog(spaceId ?? "", token ?? "", Boolean(spaceId && token));
  const registrations = catalog.data?.registrations ?? [];
  const machine = messageMachineIdentity(registrations, message);
  return <AgentIdentityLabels owner={message.senderOwnerLabel} wrap
    machine={registrationMachineName(registrations, machine?.machineId, machine?.ownerUserId) || "Unnamed machine"}
    machineBusy={registrationMachineBusy(registrations, machine?.machineId, machine?.ownerUserId)}
    machineTarget={machine} />;
}

/* One tag that changed within a sender's turn: what it was, faint, then what
   it is now. */
function RetagPair({ from, to }: { from?: ReactNode; to?: ReactNode }) {
  return (
    <span className="app-message-retag inline-flex min-w-0 items-center gap-1">
      {from ? <span className="app-message-retag-from inline-flex min-w-0">{from}</span> : null}
      {from && to ? <ArrowRight aria-label="now" className="size-3 shrink-0 text-muted-foreground" /> : null}
      {to}
    </span>
  );
}

/* A header back within one sender's turn because tags changed carries only
   those tags, each as old → new; the rest are what the header above says
   (user 2026-10-09: 搞个箭头那种比较好，其他的签没必要显示). */
function RetaggedHeaderTags({ message, previous, keys }: {
  message: TimelineItem; previous: TimelineItem; keys: readonly string[];
}) {
  const goal = (item: TimelineItem) =>
    goalStatusBadgeLabel(item.senderGoal, "historical") ? <GoalStatusBadge goal={item.senderGoal} /> : null;
  const branch = (item: TimelineItem) => item.senderGitBranch ? <BranchBadge branch={item.senderGitBranch} /> : null;
  const stale = (item: TimelineItem) => item.senderInstanceStale ? (
    <span className={tagClass("app-sender-instance-stale-badge")}
      title="This message came from an agent instance that is no longer live in this channel.">
      instance offline
    </span>
  ) : null;
  const before = previous.senderStatusChips ?? [];
  const after = message.senderStatusChips ?? [];
  const chipIds = [...new Set([...after, ...before].map((chip) => chip.id.toLowerCase()))]
    .filter((id) => keys.includes(id));
  const chipOf = (chips: typeof after, id: string) => {
    const chip = chips.find((candidate) => candidate.id.toLowerCase() === id);
    return chip ? <StatusChipBadge chip={chip} /> : null;
  };
  return (
    <>
      {keys.includes("stale") && <RetagPair from={stale(previous)} to={stale(message)} />}
      {keys.includes("goal") && <RetagPair from={goal(previous)} to={goal(message)} />}
      {keys.includes("branch") && <RetagPair from={branch(previous)} to={branch(message)} />}
      {chipIds.map((id) => <RetagPair key={id} from={chipOf(before, id)} to={chipOf(after, id)} />)}
    </>
  );
}

function NamedMachineRunFailureNotice({ body, metadata, spaceId, token }: {
  body: string; metadata?: Record<string, unknown>; spaceId?: string; token: string | null;
}) {
  const catalog = useAgentRegistrationCatalog(spaceId ?? "", token ?? "", Boolean(spaceId && token));
  const machineId = typeof metadata?.machineId === "string" ? metadata.machineId : undefined;
  const ownerUserId = typeof metadata?.machineOwnerUserId === "string" ? metadata.machineOwnerUserId : undefined;
  return <MachineRunFailureNotice body={body}
    machineName={registrationMachineName(catalog.data?.registrations ?? [], machineId, ownerUserId)} />;
}

export const MessageRow = memo(function MessageRow({
  message,
  agentLaunches,
  agentStops = NO_STOPS,
  stopReceiptsLoaded = false,
  invocationRejections,
  continuationInvocations,
  messageTargetEvidence,
  launchStatusUnavailable,
  onRetryAgentLaunch,
  onLaunchAnyway,
  launchWindow,
  launchChoiceOffered = false,
  launchOptions = NO_LAUNCH_OPTIONS,
  onLaunchChoice,
  contextOnly = false,
  initiallyExpanded = false,
  currentUserIdentityId,
  channel,
  token,
  mediaStore,
  isJoined,
  onReact,
  onEdit,
  onRecall,
  onReply,
  onOpenThread,
  onMentionSender,
  onRebornSender,
  reborningSender,
  onQuestionnaireAnswer,
  onOpenAgentTrace,
  onOpenHumanProfile,
  onOpenInternalAppLink,
  onJumpToMessage,
}: {
  message: TimelineItem;
  agentLaunches: readonly SerializedAgentLaunch[];
  agentStops?: readonly SerializedAgentStop[];
  /** The invocation query has answered, so an empty stop list is a real absence. */
  stopReceiptsLoaded?: boolean;
  invocationRejections?: readonly SerializedAgentInvocationRejection[];
  continuationInvocations?: readonly SerializedAgentContinuation[];
  messageTargetEvidence?: { executions: NonNullable<AgentInvocationQueryPage["executions"]> };
  launchStatusUnavailable?: boolean;
  onRetryAgentLaunch: (launch: SerializedAgentLaunch) => Promise<void>;
  onLaunchAnyway?: (messageId: string, body: string, sourceMention: string) => Promise<void>;
  /** A new conversation's first message: which Agent starts, chosen for a few seconds. */
  launchWindow?: InteractionDecisionWindow;
  /** The author's own fresh first message, offered before the Hub's record arrives. */
  launchChoiceOffered?: boolean;
  launchOptions?: readonly InteractionLaunchOption[];
  /** `shown`: the author now sees the choice, so its window starts there. */
  onLaunchChoice?: (messageId: string, body: string, harness: string | null | "shown") => Promise<void>;
  /** A thread root rendered from its parent Channel; media remains source-owned. */
  contextOnly?: boolean;
  /** Keep the opening context of a thread readable before folding later long messages. */
  initiallyExpanded?: boolean;
  /** Opens the Profile view for a human sender. Slack: the avatar is a link. */
  onOpenHumanProfile: (userId: string) => void;
} & MessageRowComparableProps) {
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [copied, setCopied] = useState(false);
  const [copiedAttachmentId, setCopiedAttachmentId] = useState<string | null>(null);
  const [failedAttachmentCopyId, setFailedAttachmentCopyId] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [inlineReactionsOpen, setInlineReactionsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingBody, setEditingBody] = useState(message.body);
  const [openAttachment, setOpenAttachment] = useState<ChannelAttachment | null>(null);
  const imageAttachments = useMemo(
    () => (message.attachments ?? []).filter(
      (attachment) => presentationAttachmentKind(attachment) === "image"
    ),
    [message.attachments]
  );
  // Store contents are the source of truth. This revision only asks React to
  // repaint after a shared load settles, so an authority change cannot render
  // the previous store for one commit while an effect catches up.
  const [, setAttachmentMediaRevision] = useState(0);
  useAndroidBackHandler(Boolean(openAttachment || actionsOpen || reactionPickerOpen), () => {
    if (openAttachment) setOpenAttachment(null);
    else if (actionsOpen) setActionsOpen(false);
    else setReactionPickerOpen(false);
    return true;
  });
  const attachmentMediaMountedRef = useRef(true);
  const [rebornControlVisible, setRebornControlVisible] = useState(false);
  // Reborn asks in place like the Instance controls: arm, then send.
  const [rebornSenderArmed, setRebornSenderArmed] = useState(false);
  const [rebornToolbarPosition, setRebornToolbarPosition] = useState<CSSProperties>({ left: 0, top: 0 });
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const editingTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageAvatarRef = useRef<HTMLDivElement | null>(null);
  const rebornToolbarRef = useRef<HTMLDivElement | null>(null);
  const avatarLongPressTimerRef = useRef<number | null>(null);
  const avatarLongPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const avatarLongPressTriggeredRef = useRef(false);
  const rebornHoverTimerRef = useRef<number | null>(null);
  const rebornHoveringRef = useRef(false);
  const canRebornSender = canRebornMessageSender(message);
  const humanSenderUserId = message.senderKind === "user" && message.senderId
    ? message.senderId.replace(/^user:/, "")
    : null;
  const displayBody = normalizeMessageBodyForDisplay(message.body, message.senderKind);
  const nonOperationalRanges = useMemo(() => /[@＠]/u.test(displayBody) ? nonOperationalMentionRanges(displayBody) : [], [displayBody]);
  const markdownComponents = useMemo(
    () => createMessageMarkdownComponents(onOpenInternalAppLink),
    [onOpenInternalAppLink]
  );
  // Mention chips compare the mentioned member's cursor against this one
  // message. Server-sent statuses stay authoritative where the Hub sent them.
  const mentionReadMessageScope = useMemo<MentionReadMessageScope>(() => ({
    launches: contextOnly || message.editedAt ? [] : agentLaunches,
    // A thread root is a quote of the command. An edit no longer matches the fenced body.
    ...(contextOnly || message.editedAt ? {} : { stops: agentStops, stopReceiptsLoaded }),
    rejections: contextOnly ? [] : invocationRejections,
    continuations: contextOnly || message.editedAt ? [] : continuationInvocations,
    executions: contextOnly || message.editedAt ? [] : messageTargetEvidence?.executions,
    sourceBody: displayBody,
    nonOperationalRanges,
    launchStatusUnavailable,
    onRetryLaunch: onRetryAgentLaunch,
    ...(!contextOnly && message.own && message.messageId && onLaunchAnyway
      ? { onLaunchAnyway: (sourceMention: string) => onLaunchAnyway(message.messageId!, message.body, sourceMention) } : {}),
    ...(!contextOnly && !message.editedAt ? { sentAt: message.sentAt } : {}),
    ...(message.sequence ? { sequence: message.sequence } : {}),
    ...(message.mentionReadStatuses?.length ? { statuses: message.mentionReadStatuses } : {}),
  }), [message.mentionReadStatuses, message.sequence, agentLaunches, agentStops, stopReceiptsLoaded, invocationRejections, continuationInvocations, messageTargetEvidence, launchStatusUnavailable, onRetryAgentLaunch, onLaunchAnyway, contextOnly, displayBody, nonOperationalRanges, message.editedAt, message.own, message.messageId, message.body, message.sentAt]);
  const questionnaire = questionnaireMetadata(message.metadata);
  const crossSpaceRead = crossSpaceReadMetadata(message.metadata);
  const secretRequest = crossSpaceRead ? null : secretRequestMetadata(message.metadata);
  const routingDecision = parsePresentedRoutingDecision(message.metadata?.routingDecision);
  const collapsible = !routingDecision && isLongMessageBody(displayBody);
  /* A thread is its own Channel, so it can be archived while its parent stays
     active. The replies chip is that thread's only representation out here, so
     it carries the state: archived means readable but frozen, and someone
     deciding whether to open it should see that before they click. */
  const threadChip = threadChipState(message);
  const recalled = Boolean(message.recalledAt);
  const isOutboundPending = contextOnly || message.sendStatus === "pending" ||
    message.sendStatus === "unconfirmed" || message.sendStatus === "failed";
  const canEditMessage = message.own && !recalled && !isOutboundPending && Boolean(message.messageId);
  const MessageHead: ElementType = message.continuation ? FloatingMessageActions : "div";
  const canSaveEdit = Boolean(editingBody.trim()) && editingBody.trim() !== message.body;

  const refreshAttachmentMedia = useCallback(() => {
    if (attachmentMediaMountedRef.current && mediaStore.active && !mediaStore.released) {
      setAttachmentMediaRevision((revision) => revision + 1);
    }
  }, [mediaStore]);

  const resolveAttachmentMedia = useCallback(async (
    attachment: ChannelAttachment,
  ): Promise<ChannelAttachment> => {
    if (!message.messageId && attachmentSource(attachment)) return attachment;
    const identity = relayV2AttachmentMediaIdentity(attachment);
    if (!identity) return attachment;
    if (!mediaStore.active || mediaStore.released) {
      throw new Error("Attachment view was closed");
    }
    const resolved = mediaStore.resolved.get(identity);
    if (resolved) return resolved;
    const pending = mediaStore.loads.get(identity);
    let load: Promise<ChannelAttachment>;
    if (pending) {
      load = pending;
    } else {
      const channelId = message.channelId ?? channel?.id;
      if (!token || !channelId || !message.messageId) {
        // Fail closed when identity-backed media cannot be hydrated. Record the
        // failure so the row leaves "Loading attachment" forever.
        const reason = "Local attachment media is unavailable";
        mediaStore.failures.set(identity, reason);
        refreshAttachmentMedia();
        throw new Error(reason);
      }
      const loadRef = {
        channelId,
        messageId: message.messageId,
        attachmentId: attachment.id,
      };
      load = (async () => {
        const result = await productMessageAttachmentMediaClient.loadMessageAttachment(token, loadRef);
        if (!mediaStore.active || mediaStore.released) {
          throw new Error("Attachment view was closed");
        }
        // The store outlives a virtualized row, but not its authority. A
        // deactivated store cannot retain the result of an in-flight request.
        const objectUrl = URL.createObjectURL(result.body);
        const next: ChannelAttachment = {
          ...attachment,
          ...result.attachment,
          kind: channelAttachmentKindForMimeType(result.attachment.mimeType, result.attachment.name),
          dataUrl: undefined,
          url: objectUrl,
          // Keep the body for clipboard copy: CSP blocks blob: object-URL requests.
          localMediaBlob: result.body,
        } as ChannelAttachment;
        if (!commitMessageAttachmentMedia(mediaStore, identity, next, objectUrl)) {
          throw new Error("Attachment view was closed");
        }
        mediaStore.failures.delete(identity);
        return next;
      })().catch((error) => {
        if (!mediaStore.active || mediaStore.released) throw error;
        mediaStore.failures.set(identity, "attachment media load failed");
        throw error;
      }).finally(() => {
        mediaStore.loads.delete(identity);
      });
      mediaStore.loads.set(identity, load);
    }
    try {
      const next = await load;
      refreshAttachmentMedia();
      return next;
    } catch (error) {
      refreshAttachmentMedia();
      throw error;
    }
  }, [channel?.id, mediaStore, message.channelId, message.messageId, refreshAttachmentMedia, token]);

  useEffect(() => {
    attachmentMediaMountedRef.current = true;
    return () => {
      // Only this row goes away. Its media belongs to the store, which the
      // timeline releases when the channel or the viewer changes.
      attachmentMediaMountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    // A lightbox holds a resolved attachment separately from the row. Close it
    // with the store so a revocation cannot leave its old object URL on screen.
    setOpenAttachment(null);
  }, [mediaStore]);

  useEffect(() => {
    for (const attachment of message.attachments ?? []) {
      // Authority online history returns content-addressed metadata without a
      // presentation `kind`. Derive it from mimeType so every attachment
      // still hydrates instead of spinning on "Loading attachment" forever.
      presentationAttachmentKind(attachment);
      if (
        relayV2AttachmentMediaIdentity(attachment) &&
        !attachmentSource(attachment)
      ) {
        void resolveAttachmentMedia(attachment).catch(() => undefined);
      }
    }
  }, [message.attachments, resolveAttachmentMedia]);

  useEffect(() => {
    return () => {
      clearMessageLongPress(avatarLongPressTimerRef, avatarLongPressStartRef);
    };
  }, []);

  useEffect(() => {
    if (!actionsOpen) {
      setInlineReactionsOpen(false);
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node && actionsRef.current?.contains(target))) {
        setActionsOpen(false);
      }
    };

    // On click, not pointerdown: closing collapses this row's action row, and
    // a tap on the next message would land on whatever slid up under it.
    document.addEventListener("click", closeOnOutsideClick);
    return () => document.removeEventListener("click", closeOnOutsideClick);
  }, [actionsOpen]);

  const stableNavigateOpenImage = useStableCallback(navigateOpenImage);
  const stableCopyAttachment = useStableCallback(copyAttachment);

  useEffect(() => {
    if (!openAttachment) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenAttachment(null);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        void stableNavigateOpenImage(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      // Lightbox has no text selection target; bind Ctrl/Cmd+C to image copy.
      if (
        openAttachment.kind === "image" &&
        (event.key === "c" || event.key === "C") &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest("input, textarea, select, [contenteditable='true']")
        ) {
          return;
        }
        event.preventDefault();
        void stableCopyAttachment(openAttachment);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [openAttachment, stableNavigateOpenImage, stableCopyAttachment]);

  useEffect(() => {
    if (!editing) return;
    setEditingBody(message.body);
    scheduleTextareaSelection(
      () => editingTextareaRef.current,
      message.body,
      { start: message.body.length, end: message.body.length }
    );
  }, [editing, message.body]);

  async function copyMessage() {
    await copyTextToClipboard(messageCopyText(message));
    setCopied(true);
    setActionsOpen(false);
    window.setTimeout(() => setCopied(false), 1200);
  }

  async function copyAttachment(attachment: ChannelAttachment) {
    try {
      // Pass a resolver instead of awaiting media first: clipboard.write must
      // start under the click's user activation; Chromium rejects delayed writes.
      await copyImageAttachmentToClipboard(attachment, () => resolveAttachmentMedia(attachment));
      setCopiedAttachmentId(attachment.id);
      setFailedAttachmentCopyId(null);
      window.setTimeout(() => setCopiedAttachmentId((id) => (id === attachment.id ? null : id)), 1200);
    } catch (error) {
      // eslint-disable-next-line no-console -- field-visible clipboard failures
      console.error("Copy attachment failed", error);
      setCopiedAttachmentId(null);
      setFailedAttachmentCopyId(attachment.id);
      window.setTimeout(() => setFailedAttachmentCopyId((id) => (id === attachment.id ? null : id)), 1800);
    }
  }

  async function openMessageAttachment(attachment: ChannelAttachment) {
    setOpenAttachment({ ...attachment, kind: presentationAttachmentKind(attachment) });
    try {
      const ready = await resolveAttachmentMedia(attachment);
      setOpenAttachment((current) => current?.id === attachment.id && mediaStore.active && !mediaStore.released
        ? { ...ready, kind: presentationAttachmentKind(ready) }
        : current);
    } catch {
      setOpenAttachment((current) => current?.id === attachment.id ? null : current);
    }
  }

  async function navigateOpenImage(direction: -1 | 1) {
    if (!openAttachment || openAttachment.kind !== "image" || imageAttachments.length < 2) return;
    const currentIndex = imageAttachments.findIndex((attachment) => attachment.id === openAttachment.id);
    const nextIndex = (Math.max(0, currentIndex) + direction + imageAttachments.length) % imageAttachments.length;
    await openMessageAttachment(imageAttachments[nextIndex]);
  }

  async function downloadMessageAttachment(attachment: ChannelAttachment) {
    try {
      const ready = await resolveAttachmentMedia(attachment);
      const href = attachmentDownloadHref(ready);
      if (!href) return;
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = attachmentDownloadName(ready);
      anchor.click();
    } catch {
      // The row-level unavailable state remains visible and no legacy URL fallback is attempted.
    }
  }

  function requestEdit() {
    setActionsOpen(false);
    setEditingBody(message.body);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setEditingBody(message.body);
  }

  function saveEdit() {
    const trimmed = editingBody.trim();
    if (!trimmed || trimmed === message.body) return;
    onEdit(message, trimmed);
    setEditing(false);
  }

  function requestRecall() {
    setActionsOpen(false);
    if (!window.confirm("Recall this message?")) return;
    onRecall(message);
  }

  function requestReply() {
    setActionsOpen(false);
    onReply(message);
  }

  function openThread() {
    setActionsOpen(false);
    onOpenThread(message);
  }

  /* A phone has no hover, so a tap on the message opens its actions as a row
     under it, and a second tap closes them. Taps that already mean something
     (links, buttons, mention chips, attachments) keep their meaning, and a
     finished text selection is left alone so long-press still selects text. */
  function handleRowClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (recalled || isOutboundPending || editing || window.innerWidth >= 768) return;
    if (isMessageActionBypassTarget(event.target)) return;
    if (event.target instanceof Element && event.target.closest("[data-mobile-inline-actions='true'], summary, label, img, video")) return;
    if (window.getSelection()?.isCollapsed === false) return;
    setActionsOpen((open) => !open);
  }

  function handleAvatarPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!canMentionMessageSender(message) || event.pointerType === "mouse" || window.innerWidth >= 768) {
      return;
    }
    event.stopPropagation();
    clearMessageLongPress(avatarLongPressTimerRef, avatarLongPressStartRef);
    avatarLongPressTriggeredRef.current = false;
    avatarLongPressStartRef.current = { x: event.clientX, y: event.clientY };
    avatarLongPressTimerRef.current = window.setTimeout(() => {
      avatarLongPressTimerRef.current = null;
      avatarLongPressTriggeredRef.current = true;
      onMentionSender(message);
      navigator.vibrate?.(10);
    }, 450);
  }

  function handleAvatarPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = avatarLongPressStartRef.current;
    if (!start) return;
    if (Math.abs(event.clientX - start.x) > 10 || Math.abs(event.clientY - start.y) > 10) {
      clearMessageLongPress(avatarLongPressTimerRef, avatarLongPressStartRef);
    }
  }

  function handleAvatarPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (avatarLongPressStartRef.current || avatarLongPressTimerRef.current) {
      event.stopPropagation();
    }
    clearMessageLongPress(avatarLongPressTimerRef, avatarLongPressStartRef);
  }

  function clearRebornHoverTimer() {
    if (rebornHoverTimerRef.current === null) return;
    window.clearTimeout(rebornHoverTimerRef.current);
    rebornHoverTimerRef.current = null;
  }

  const positionRebornToolbar = useCallback(() => {
    const avatar = messageAvatarRef.current;
    if (!avatar) return;
    const nextPosition = centeredToolbarPosition(avatar,
      rebornToolbarRef.current?.getBoundingClientRect().width || 96);
    setRebornToolbarPosition((current) => {
      if (current.left === nextPosition.left && current.top === nextPosition.top) {
        return current;
      }
      return nextPosition;
    });
  }, []);

  function startRebornHoverReveal() {
    if (!canRebornSender) return;
    rebornHoveringRef.current = true;
    clearRebornHoverTimer();
    rebornHoverTimerRef.current = window.setTimeout(() => {
      rebornHoverTimerRef.current = null;
      if (rebornHoveringRef.current) {
        setRebornControlVisible(true);
      }
    }, 300);
  }

  function hideRebornControl() {
    rebornHoveringRef.current = false;
    clearRebornHoverTimer();
    setRebornSenderArmed(false);
    if (!reborningSender) {
      setRebornControlVisible(false);
    }
  }

  useEffect(() => {
    return () => {
      clearRebornHoverTimer();
    };
  }, []);

  useEffect(() => {
    if (reborningSender) {
      setRebornControlVisible(true);
      return;
    }
    if (!rebornHoveringRef.current) {
      setRebornControlVisible(false);
    }
  }, [reborningSender]);

  useLayoutEffect(() => {
    if (!canRebornSender || !(rebornControlVisible || reborningSender)) return;
    const avatar = messageAvatarRef.current;
    const toolbar = rebornToolbarRef.current;
    const layoutRoot = avatar?.closest(".app-message-surface");
    if (!avatar || !toolbar || !layoutRoot) {
      positionRebornToolbar();
      return;
    }

    return observeToolbarLayout(avatar, toolbar, layoutRoot, positionRebornToolbar, false);
  }, [canRebornSender, rebornControlVisible, reborningSender, positionRebornToolbar]);

  if (message.isEvent) {
    const Icon = message.eventType ? EVENT_ICONS[message.eventType] || Hash : Hash;

    return (
      <div className="app-message-row group flex items-center gap-2 px-5 py-1.5 text-xs text-muted-foreground hover:bg-muted/30">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="size-3.5" />
        </div>
        <span className="message-event-text min-w-0 flex-1 truncate">
          {message.author !== "xMatrix" ? `${message.author} - ${displayBody}` : displayBody}
        </span>
        <MessageCopyButton copied={copied} onCopy={() => void copyMessage()} />
        <MessageTimestamp value={message.sentAt} />
      </div>
    );
  }

  return (
    <div
      ref={actionsRef}
      onClick={handleRowClick}
      data-actions-open={actionsOpen || undefined}
      className={cn(
        "app-message-row group relative flex items-start gap-(--app-message-avatar-gap) px-5",
        // Every message sits on the same paper: whose it is reads from the
        // header, not from a tinted row. An open action row is a state, not
        // an author, so it keeps its tone.
        // Only a header row opens with extra room, which sets one sender's
        // run apart from the last; every row closes alike, so the lines of a
        // run sit at one even pitch.
        message.continuation ? "py-0.5" : "pt-3 pb-0.5",
        actionsOpen && "bg-muted"
      )}
    >
      {message.continuation ? (
        // Same sender, moments later, same tags: the header above still says who.
        // The hidden time is one body line tall and never wraps: wrapped, it
        // stood two lines high and spread one-line messages apart (user 2026-10-06).
        <div className="app-message-continuation-gutter mt-0.5 flex h-5 w-(--app-message-avatar-size) shrink-0 items-center justify-end self-start">
          <MessageTimestamp value={message.sentAt} clock
            className="invisible whitespace-nowrap text-[10px] text-muted-foreground group-hover:visible" />
        </div>
      ) : (
      <div
        ref={messageAvatarRef}
        className={cn(
          "app-message-author-avatar relative mt-0.5 self-start",
          canRebornSender && (rebornControlVisible || reborningSender) && "app-message-author-reborn-open"
        )}
        onPointerDown={handleAvatarPointerDown}
        onPointerMove={handleAvatarPointerMove}
        onPointerUp={handleAvatarPointerEnd}
        onPointerCancel={(event) => {
          handleAvatarPointerEnd(event);
          hideRebornControl();
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse" || event.pointerType === "pen") {
            startRebornHoverReveal();
            positionRebornToolbar();
          }
        }}
        onPointerLeave={(event) => {
          handleAvatarPointerEnd(event);
          hideRebornControl();
        }}
        onClickCapture={(event) => {
          if (!avatarLongPressTriggeredRef.current) return;
          avatarLongPressTriggeredRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onContextMenu={(event) => {
          if (canMentionMessageSender(message) && window.innerWidth < 768) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <IdentityAvatar
          kind={
            message.reservedSystemAgent
              ? "system"
              : message.senderKind === "agent"
              ? "agent"
              : message.senderKind === "app"
                ? "app"
                : message.senderKind === "system"
                  ? "system"
                  : "human"
          }
          label={message.author}
          status={message.senderStatus}
          imageUrl={message.avatarUrl}
          initials={avatarInitials(message.author)}
          size="md"
          showKindBadge={false}
          glass={false}
          className="message-author-avatar size-9 min-h-9 min-w-9 max-h-9 max-w-9 p-0"
          onClick={
            message.senderKind === "agent" && !message.reservedSystemAgent
              ? () => onOpenAgentTrace({
                  id: message.senderId,
                  instanceId: message.senderInstanceId,
                  instanceIds: message.senderInstanceId ? [message.senderInstanceId] : undefined,
                  exactInstanceIds: message.senderInstanceId ? [message.senderInstanceId] : undefined,
                  instanceScoped: Boolean(message.senderInstanceId),
                  channelId: channel?.id,
                  name: message.author,
                  status: message.senderStatus,
                  activity: message.senderActivity,
                  goal: message.senderGoal,
                })
              : humanSenderUserId
                ? () => onOpenHumanProfile(humanSenderUserId)
                : undefined
          }
        />
        {canRebornSender ? (
          <div className="app-agent-work-actions app-message-author-reborn-actions" style={rebornToolbarPosition}>
            <div
              ref={rebornToolbarRef}
              className="app-agent-work-action-menu"
              role="toolbar"
              aria-label={`Reborn controls for ${message.author}`}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onTouchStart={(event) => event.stopPropagation()}
              onFocus={positionRebornToolbar}
            >
              <button
                type="button"
                aria-label={rebornSenderArmed ? `Confirm reborn ${message.author}` : `Reborn ${message.author}`}
                disabled={reborningSender || !isJoined}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!rebornSenderArmed) {
                    setRebornSenderArmed(true);
                    return;
                  }
                  setRebornSenderArmed(false);
                  onRebornSender(message);
                }}
                className="app-agent-work-action"
                data-action="reborn"
                data-armed={rebornSenderArmed || undefined}
              >
                {reborningSender ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                )}
                <span>{rebornSenderArmed ? "Confirm" : "Reborn"}</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
      )}
      <div className="min-w-0 flex-1">
        <MessageHead className={cn(
          "app-message-head flex min-w-0 items-start gap-2",
          message.continuation && "hidden items-center gap-0.5 p-0.5 md:flex",
        )} {...(message.continuation ? { pinned: reactionPickerOpen } : {})}>
          {/* Sender, then the time, then every tag. The time is a property of the
              message itself, so it stays next to the author instead of being
              pushed around by however many tags the sender happens to carry.
              Tags that do not fit wrap whole onto the next line: every tag says
              something about the sender, so none is hidden or cut at the edge
              (user 2026-09-27, a phone showed half a Goal pill). */}
          {!message.continuation && (
          <div className="app-message-meta flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="app-message-author-name shrink-0 whitespace-nowrap text-[15px] font-black">{message.author}</span>
          <MessageTimestamp value={message.sentAt} className="shrink-0 text-xs text-muted-foreground" />
          {message.sendStatus === "pending" && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Sending
            </span>
          )}
          {message.sendStatus === "unconfirmed" && (
            // Neither a spinner nor an error: the send passed its deadline and
            // the result is genuinely unknown. No spinner, because nothing is
            // still in flight; no error, because it may well have been written.
            // The label stays static — a bounded probe runs and then stops, so
            // promising ongoing "checking" would outlive the work being done.
            <span className={statusInkClass("attention", "inline-flex shrink-0 items-center gap-1 text-[11px] font-medium")}>
              Result unconfirmed
            </span>
          )}
          {message.sendStatus === "failed" && (
            <span className="shrink-0 text-[11px] font-medium text-destructive">
              {message.sendError || "Failed to send"}
            </span>
          )}
          <span className="contents">
          {message.senderKind === "agent" && !message.reservedSystemAgent &&
            (!message.retagged || message.retagged.keys.some((key) => key === "owner" || key === "machine")) && (
            <NamedAgentIdentityLabels message={message} spaceId={channel?.spaceId} token={token} />
          )}
          {message.linkOrigin && (
            <LinkOriginTag origin={message.linkOrigin} onOpenInternalAppLink={onOpenInternalAppLink} />
          )}
          {message.senderKind === "app" && !message.reservedSystemAgent && (
            <span className={tagClass("app-sender-kind-badge")}>
              App
            </span>
          )}
          {shouldShowProvenanceBadge(message.provenance) && (
            <span
              className={provenanceBadgeClass(message.provenance, message.body)}
              title={provenanceTitle(message.provenance, message.body)}
            >
              {provenanceLabel(message.provenance, message.body)}
            </span>
          )}
          {message.retagged ? (
            <RetaggedHeaderTags message={message} previous={message.retagged.previous} keys={message.retagged.keys} />
          ) : (<>
          {message.senderInstanceStale && (
            <span
              className={tagClass("app-sender-instance-stale-badge")}
              title="This message came from an agent instance that is no longer live in this channel."
            >
              instance offline
            </span>
          )}
          {message.senderKind === "agent" && (
            <GoalStatusBadge goal={message.senderGoal} />
          )}
          {message.senderKind === "agent" && message.senderGitBranch && (
            <BranchBadge branch={message.senderGitBranch} />
          )}
          {message.senderKind === "agent" &&
            message.senderStatusChips?.map((chip) => (
              <StatusChipBadge key={chip.id} chip={chip} />
            ))}
          </>)}
          </span>
          </div>
          )}
          {!recalled && !isOutboundPending && (
            <MessageCopyButton copied={copied} onCopy={() => void copyMessage()} className="hidden md:flex" />
          )}
          {!recalled && !isOutboundPending && (
            <button
              type="button"
              title="Reply"
              aria-label="Reply"
              onClick={() => onReply(message)}
              className="hidden size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 md:flex"
            >
              <Reply className="size-3.5" />
            </button>
          )}
          {!recalled && !isOutboundPending && (
            // With the other hover actions, not as a row under the body: a row
            // that is invisible until hover still spaced every message apart,
            // and a phone never hovers (it reacts from the row a tap opens).
            <div className="relative hidden shrink-0 md:block">
              <button
                type="button"
                title="Add reaction"
                aria-label="Add reaction"
                aria-expanded={reactionPickerOpen}
                onClick={() => setReactionPickerOpen((open) => !open)}
                className={cn(
                  "flex size-7 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
                  reactionPickerOpen ? "opacity-100" : "opacity-0"
                )}
              >
                <SmilePlus className="size-3.5" />
              </button>
              {reactionPickerOpen && (
                // The popover is glass, and glass is always position: relative,
                // so a plain frame floats it below the button.
                <div className="absolute right-0 top-full z-20 mt-1">
                  <QuickReactionPicker
                    className="rounded-full border border-border bg-popover p-1 shadow-lg"
                    onReact={(emoji) => {
                      setReactionPickerOpen(false);
                      onReact(message, emoji);
                    }}
                  />
                </div>
              )}
            </div>
          )}
          {canEditMessage && !editing && (
            <>
              <button
                type="button"
                title="Edit message"
                aria-label="Edit message"
                onClick={requestEdit}
                className="hidden size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 md:flex"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                title="Recall message"
                aria-label="Recall message"
                onClick={requestRecall}
                className="hidden size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition hover:bg-muted hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 md:flex"
              >
                <Trash2 className="size-3.5" />
              </button>
            </>
          )}
        </MessageHead>
        {recalled ? (
          <p className="py-1 text-sm italic text-muted-foreground">This message was recalled.</p>
        ) : editing ? (
          <form
            className="mt-1 max-w-3xl"
            onSubmit={(event) => {
              event.preventDefault();
              saveEdit();
            }}
          >
            <Textarea
              ref={editingTextareaRef}
              value={editingBody}
              onChange={(event) => setEditingBody(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEdit();
                }
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  saveEdit();
                }
              }}
              className="min-h-24 resize-y text-sm"
              aria-label="Edit message body"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="submit"
                disabled={!canSaveEdit}
                className="inline-flex h-8 items-center gap-1.5 rounded bg-primary px-2.5 text-xs font-bold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Check className="size-3.5" />
                Save
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                className="inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-bold text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="relative">
            {message.replyTo && (
              <ReplyPreview reply={message.replyTo} onJump={onJumpToMessage} />
            )}
            {crossSpaceRead ? (
              <CrossSpaceReadCard
                request={crossSpaceRead}
                token={token}
                userId={currentUserIdentityId.replace(/^user:/, "")}
              />
            ) : secretRequest ? (
              <SecretRequestCardView
                request={secretRequest}
                token={token}
                userId={currentUserIdentityId.replace(/^user:/, "")}
              />
            ) : questionnaire ? (
              <QuestionnaireMessage
                questionnaire={questionnaire}
                message={message}
                onAnswer={onQuestionnaireAnswer}
              />
            ) : routingDecision ? (
              <RoutingDecisionBoard decision={routingDecision} />
            ) : isMachineRunFailureNotice(message) ? (
              <NamedMachineRunFailureNotice body={displayBody} metadata={message.metadata} spaceId={channel?.spaceId} token={token} />
            ) : (
              <MentionReadMessageScopeProvider scope={mentionReadMessageScope}>
                {/* Its text is where a passage can be selected to discuss (selection-discussion.ts). */}
                <div {...(message.messageId && !recalled ? { [MESSAGE_BODY_ATTRIBUTE]: message.messageId } : {})}>
                  <RichMessageContent body={displayBody} collapsed={collapsible && !expanded} components={markdownComponents} />
                </div>
              </MentionReadMessageScopeProvider>
            )}
            {!recalled && message.senderKind === "user" && <UnpublishedTurnState
              executions={mentionReadMessageScope.executions || []} unavailable={launchStatusUnavailable} />}
            {!recalled && collapsible && !expanded && (
              // Disclosure is a different layer from the message actions: the
              // body fades out under `.rich-message-collapsed::after` and its
              // label rides on that gradient instead of wearing a glass chip.
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-start">
                <button
                  type="button"
                  onClick={() => setExpanded((current) => !current)}
                  className="message-collapse-button pointer-events-auto inline-flex h-11 items-center gap-1 px-4 text-xs font-bold text-muted-foreground transition hover:text-foreground md:h-8"
                  aria-expanded={false}
                >
                  <ChevronDown aria-hidden="true" className="pointer-events-none size-3.5 shrink-0" />
                  <span className="pointer-events-none">Show more</span>
                </button>
              </div>
            )}
          </div>
        )}
        {!recalled && message.editedAt && (
          <div className="mt-1 text-xs text-muted-foreground">edited {formatTime(message.editedAt)}</div>
        )}
        {!recalled && collapsible && expanded && (
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="message-collapse-button mt-1.5 inline-flex h-11 items-center gap-1 px-4 text-xs font-bold text-muted-foreground transition hover:text-foreground md:h-8"
            aria-expanded={true}
          >
            <ChevronDown aria-hidden="true" className="pointer-events-none size-3.5 shrink-0 rotate-180" />
            <span className="pointer-events-none">Show less</span>
          </button>
        )}
        {!recalled && message.attachments && message.attachments.length > 0 && (
          <div className="mt-2 grid w-full max-w-[min(42rem,100%)] min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
            {message.attachments.map((attachment) => {
              const mediaIdentity = relayV2AttachmentMediaIdentity(attachment);
              const baseAttachment = mediaIdentity
                ? mediaStore.resolved.get(mediaIdentity) ?? attachment
                : attachment;
              // Authority product history omits presentation kind. Normalize so
              // render and load never disagree.
              const displayAttachment: ChannelAttachment = {
                ...baseAttachment,
                kind: presentationAttachmentKind(baseAttachment),
              };
              const source = attachmentSource(displayAttachment);
              // Without a verified media identity there is no loader path for
              // Relay V2 binary bodies — fail closed instead of spinning forever.
              const mediaLoadFailed = mediaIdentity
                ? mediaStore.failures.has(mediaIdentity)
                : !source;
              const attachmentCopied = copiedAttachmentId === attachment.id;
              const attachmentCopyFailed = failedAttachmentCopyId === attachment.id;
              return (
                <div
                  key={attachment.id}
                  className={cn(
                    "group/attachment relative min-w-0",
                    (displayAttachment.kind === "video" || displayAttachment.kind === "markdown" || displayAttachment.kind === "file") &&
                      "col-span-2 sm:col-span-3"
                  )}
                >
                  {attachmentMediaType(displayAttachment.mimeType, displayAttachment.name) === "audio" ? (
                    <div className="rounded-md border border-border bg-muted/45 p-3">
                      <div className="mb-2 truncate text-sm font-medium">{displayAttachment.name}</div>
                      {source ? (
                        <MediaPlayer kind="audio" src={source} name={displayAttachment.name} />
                      ) : mediaLoadFailed ? (
                        <AttachmentMediaUnavailable />
                      ) : (
                        <MediaSkeleton label="Loading audio" />
                      )}
                      <button type="button" className="mt-2 text-xs text-primary underline" onClick={() => void downloadMessageAttachment(displayAttachment)}>
                        Download {displayAttachment.name}
                      </button>
                    </div>
                  ) : displayAttachment.kind === "video" ? (
                    <div className="message-video-attachment relative aspect-video max-h-[28rem] w-full overflow-hidden border border-border bg-black">
                      {source ? (
                        <MediaPlayer
                          kind="video"
                          name={displayAttachment.name}
                          src={source}
                          poster={displayAttachment.thumbnailUrl}
                          className="absolute inset-0 h-full w-full bg-black object-contain"
                        />
                      ) : mediaLoadFailed ? (
                        <AttachmentMediaUnavailable />
                      ) : (
                        <MediaSkeleton label="Loading video" className="absolute inset-0 min-h-0" />
                      )}
                      <button
                        type="button"
                        title={`Open ${displayAttachment.name}`}
                        aria-label={`Open ${displayAttachment.name}`}
                        onClick={() => void openMessageAttachment(displayAttachment)}
                        className="absolute left-2 top-2 z-10 flex size-9 items-center justify-center rounded-full bg-black/65 text-white shadow-lg transition hover:bg-black/80"
                      >
                        <Maximize2 className="size-4.5" />
                      </button>
                      {source && (
                        <button
                          type="button"
                          title={`Download ${displayAttachment.name}`}
                          aria-label={`Download ${displayAttachment.name}`}
                          onClick={() => void downloadMessageAttachment(displayAttachment)}
                          className="absolute right-2 top-2 z-10 flex size-9 items-center justify-center rounded-full bg-black/65 text-white shadow-lg transition hover:bg-black/80"
                        >
                          <Download className="size-4.5" />
                        </button>
                      )}
                    </div>
                  ) : displayAttachment.kind === "markdown" || displayAttachment.kind === "file" ? (
                    <button
                      type="button"
                      title={`${displayAttachment.kind === "markdown" ? "Open" : "Download"} ${displayAttachment.name}`}
                      aria-label={`${displayAttachment.kind === "markdown" ? "Open" : "Download"} ${displayAttachment.name}`}
                      onClick={() => void (displayAttachment.kind === "markdown" ? openMessageAttachment : downloadMessageAttachment)(displayAttachment)}
                      className="flex w-full min-w-0 items-center gap-3 rounded-md border border-border bg-muted/45 px-3 py-3 text-left transition hover:bg-muted"
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center rounded bg-background text-muted-foreground">
                        {displayAttachment.kind === "markdown" ? <FileText className="size-5" /> : <Paperclip className="size-5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-foreground">{displayAttachment.name}</span>
                        <span className="block text-xs text-muted-foreground">{displayAttachment.kind === "markdown" ? "Markdown" : displayAttachment.mimeType || "File"} - {formatFileSize(displayAttachment.size)}</span>
                      </span>
                      {displayAttachment.kind === "markdown"
                        ? <Maximize2 className="size-4 shrink-0 text-muted-foreground" />
                        : <Download className="size-4 shrink-0 text-muted-foreground" />}
                    </button>
                  ) : (
                    <button
                      type="button"
                      title={`Open ${displayAttachment.name}`}
                      aria-label={`Open ${displayAttachment.name}`}
                      onClick={() => void openMessageAttachment(displayAttachment)}
                      className="message-image-attachment block max-w-[18rem] overflow-hidden rounded-[0.75rem] border border-border bg-transparent text-left"
                    >
                      {source ? (
                        <LoadingImage
                          src={source}
                          alt={displayAttachment.name}
                          className="block aspect-square w-full object-cover"
                        />
                      ) : mediaLoadFailed ? (
                        <AttachmentMediaUnavailable />
                      ) : (
                        <MediaSkeleton label="Loading image" className="app-media-skeleton-image" />
                      )}
                    </button>
                  )}
                  {source && displayAttachment.kind === "image" && (
                    <div className="absolute right-1.5 top-1.5 z-10 flex gap-1 opacity-100 transition md:opacity-0 md:group-hover/attachment:opacity-100">
                      {displayAttachment.kind === "image" && (
                        <button
                          type="button"
                          title={
                            attachmentCopyLabel(attachment.name, attachmentCopyFailed, attachmentCopied)
                          }
                          aria-label={
                            attachmentCopyLabel(attachment.name, attachmentCopyFailed, attachmentCopied)
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            void copyAttachment(displayAttachment);
                          }}
                          className={cn(
                            "flex size-8 items-center justify-center rounded-full bg-black/60 text-white shadow-lg transition hover:bg-black/75 focus-visible:opacity-100",
                            attachmentCopyFailed && "bg-destructive/85 hover:bg-destructive"
                          )}
                        >
                          {attachmentCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
                        </button>
                      )}
                      <button
                        type="button"
                        title={`Download ${displayAttachment.name}`}
                        aria-label={`Download ${displayAttachment.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          void downloadMessageAttachment(displayAttachment);
                        }}
                        className="flex size-8 items-center justify-center rounded-full bg-black/60 text-white shadow-lg transition hover:bg-black/75 focus-visible:opacity-100"
                      >
                        <Download className="size-4" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {/* After the words and the pictures. A choice between them reads as a second message. */}
        {!recalled && !editing && !contextOnly && message.messageId && onLaunchChoice && (launchWindow || launchChoiceOffered) && (
          <FirstMessageLaunchChoice messageId={message.messageId} window={launchWindow} offeredAt={launchChoiceOffered ? message.sentAt : undefined}
            own={Boolean(message.own)} options={launchOptions}
            onChoose={harness => onLaunchChoice(message.messageId!, message.body, harness)}
            onShown={() => onLaunchChoice(message.messageId!, message.body, "shown")} />
        )}
        {!contextOnly && !recalled && threadChip.present && !!message.threadReplies?.length && (
          <div className="app-thread-reply-preview mt-2 max-w-xl space-y-2 border-l-2 border-border pl-3">
            {message.threadReplies.map((reply) => (
              <div key={reply.id} className="flex w-full items-start gap-2 p-1 text-left text-xs">
                <IdentityAvatar kind="human" label={reply.author} imageUrl={reply.avatarUrl}
                  initials={avatarInitials(reply.author)} size="xs" shape="circle" showKindBadge={false} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{reply.author}</span>
                  <span className="line-clamp-2 whitespace-pre-wrap break-words text-muted-foreground">{reply.body}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        {!contextOnly && !recalled && threadChip.present && (
          <button
            type="button"
            onClick={() => onOpenThread(message)}
            className={cn(
              "app-thread-summary mt-2 inline-flex h-8 max-w-full items-center gap-2 px-2.5 text-xs font-bold text-primary",
              COUNT_CHIP_MATERIAL_CLASS,
            )}
          >
            {message.threadReplyParticipants?.length ? (
              <span aria-hidden="true" className="app-thread-participant-stack flex shrink-0 -space-x-1.5">
                {message.threadReplyParticipants.map((participant) => (
                  <IdentityAvatar
                    key={participant.id}
                    kind="human"
                    label={participant.author}
                    imageUrl={participant.avatarUrl}
                    initials={avatarInitials(participant.author)}
                    size="xs"
                    shape="circle"
                    showKindBadge={false}
                    className="app-thread-participant-avatar rounded-full ring-2 ring-background"
                  />
                ))}
              </span>
            ) : (
              <MessageSquare aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{threadChip.label}</span>
          </button>
        )}
        {!recalled && !isOutboundPending && (
          <MessageReactions
            message={message}
            currentUserIdentityId={currentUserIdentityId}
            onReact={(emoji) => onReact(message, emoji)}
          />
        )}
        {!recalled && !isOutboundPending && actionsOpen && (
          <MobileInlineActions
            label="Message actions"
            className="md:hidden"
            actions={[
              { key: "reply", icon: Reply, label: "Reply", onSelect: requestReply },
              {
                key: "react",
                icon: SmilePlus,
                label: "React",
                pressed: inlineReactionsOpen,
                onSelect: () => setInlineReactionsOpen((open) => !open),
              },
              ...(message.threadChannelId
                ? [{ key: "thread", icon: MessageSquare, label: "Thread", onSelect: openThread }]
                : []),
              {
                key: "copy",
                icon: copied ? Check : Copy,
                label: copied ? "Copied" : "Copy",
                onSelect: () => void copyMessage(),
              },
              ...(canRebornSender
                ? [{
                    key: "reborn",
                    icon: RefreshCw,
                    label: reborningSender ? "Reborning…" : "Reborn",
                    confirm: true,
                    onSelect: () => {
                      setActionsOpen(false);
                      onRebornSender(message);
                    },
                  }]
                : []),
              ...(canEditMessage && !editing
                ? [
                    { key: "edit", icon: Pencil, label: "Edit", onSelect: requestEdit },
                    { key: "recall", icon: Trash2, label: "Recall", destructive: true, confirm: true, onSelect: () => {
                      setActionsOpen(false);
                      onRecall(message);
                    } },
                  ]
                : []),
            ]}
          >
            {inlineReactionsOpen && (
              <QuickReactionPicker
                className="app-mobile-inline-reactions"
                itemClassName="size-10 text-xl"
                onReact={(emoji) => {
                  setActionsOpen(false);
                  onReact(message, emoji);
                }}
              />
            )}
          </MobileInlineActions>
        )}
      </div>
      {openAttachment &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="app-attachment-lightbox fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 text-white backdrop-blur-md sm:p-5"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpenAttachment(null);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={openAttachment.name}
              className="app-attachment-lightbox-dialog relative flex h-full max-h-[94dvh] w-full max-w-[96vw] flex-col items-center justify-center"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setOpenAttachment(null);
              }}
            >
              <button
                type="button"
                title="Close attachment"
                aria-label="Close attachment"
                autoFocus
                onClick={() => setOpenAttachment(null)}
                className="app-attachment-lightbox-close absolute right-1 top-1 z-20 flex size-10 items-center justify-center bg-black/55 text-white shadow-lg transition hover:bg-black/75"
              >
                <X className="size-5" />
              </button>
              <a
                href={attachmentDownloadHref(openAttachment)}
                download={attachmentDownloadName(openAttachment)}
                title={`Download ${openAttachment.name}`}
                aria-label={`Download ${openAttachment.name}`}
                className="app-attachment-lightbox-download absolute left-1 top-1 z-20 flex size-10 items-center justify-center bg-black/55 text-white shadow-lg transition hover:bg-black/75"
              >
                <Download className="size-5" />
              </a>
              {openAttachment.kind === "image" && (
                <button
                  type="button"
                  title={
                    attachmentCopyLabel(openAttachment.name, failedAttachmentCopyId === openAttachment.id, copiedAttachmentId === openAttachment.id)
                  }
                  aria-label={
                    attachmentCopyLabel(openAttachment.name, failedAttachmentCopyId === openAttachment.id, copiedAttachmentId === openAttachment.id)
                  }
                  onClick={() => void copyAttachment(openAttachment)}
                  className={cn(
                    "app-attachment-lightbox-copy absolute left-12 top-1 z-20 flex size-10 items-center justify-center bg-black/55 text-white shadow-lg transition hover:bg-black/75",
                    failedAttachmentCopyId === openAttachment.id && "bg-destructive/85 hover:bg-destructive"
                  )}
                >
                  {copiedAttachmentId === openAttachment.id ? <Check className="size-5" /> : <Copy className="size-5" />}
                </button>
              )}
              {openAttachment.kind === "image" && imageAttachments.length > 1 && (
                <>
                  <button
                    type="button"
                    title="Previous image"
                    aria-label="Previous image"
                    onClick={() => void navigateOpenImage(-1)}
                    className="app-attachment-lightbox-previous absolute left-1 top-1/2 z-20 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition hover:bg-black/75"
                  >
                    <ChevronLeft className="size-6" />
                  </button>
                  <button
                    type="button"
                    title="Next image"
                    aria-label="Next image"
                    onClick={() => void navigateOpenImage(1)}
                    className="app-attachment-lightbox-next absolute right-1 top-1/2 z-20 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition hover:bg-black/75"
                  >
                    <ChevronRight className="size-6" />
                  </button>
                  <div className="absolute bottom-1 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-xs font-bold">
                    {imageAttachments.findIndex((attachment) => attachment.id === openAttachment.id) + 1} / {imageAttachments.length}
                  </div>
                </>
              )}
              {openAttachment.kind === "video" ? (
                <MediaPlayer
                  kind="video"
                  name={openAttachment.name}
                  src={attachmentSource(openAttachment)}
                  poster={openAttachment.thumbnailUrl}
                  className="max-h-[94dvh] max-w-[96vw] bg-black object-contain"
                  autoPlay
                />
              ) : openAttachment.kind === "markdown" ? (
                <MarkdownAttachmentViewer attachment={openAttachment} />
              ) : !attachmentSource(openAttachment) ? (
                <MediaSkeleton label="Loading attachment" className="app-media-skeleton-stage" />
              ) : (
                <ZoomableAttachmentImage
                  src={attachmentSource(openAttachment)}
                  alt={openAttachment.name}
                  resetKey={openAttachment.id}
                  onRequestClose={() => setOpenAttachment(null)}
                  onNavigate={(direction) => void navigateOpenImage(direction)}
                />
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}, (previous, next) => previous.agentLaunches === next.agentLaunches &&
    previous.agentStops === next.agentStops &&
    previous.stopReceiptsLoaded === next.stopReceiptsLoaded &&
    previous.invocationRejections === next.invocationRejections &&
    previous.continuationInvocations === next.continuationInvocations &&
    previous.messageTargetEvidence === next.messageTargetEvidence &&
    previous.launchStatusUnavailable === next.launchStatusUnavailable &&
  previous.onRetryAgentLaunch === next.onRetryAgentLaunch && previous.onLaunchAnyway === next.onLaunchAnyway &&
  previous.launchWindow === next.launchWindow && previous.launchChoiceOffered === next.launchChoiceOffered &&
  previous.launchOptions === next.launchOptions && previous.onLaunchChoice === next.onLaunchChoice &&
  areMessageRowPropsEqual(previous, next));

const NO_LAUNCH_OPTIONS: readonly InteractionLaunchOption[] = [];


/** A failed attachment. Loading is a skeleton in the media's own footprint. */
export function AttachmentMediaUnavailable({ className }: { className?: string } = {}) {
  return (
    <span
      className={cn(
        "app-attachment-placeholder flex h-full min-h-24 w-full flex-col items-center justify-center gap-1.5 text-xs text-muted-foreground",
        className
      )}
      data-state="failed"
      role="status"
    >
      <AlertTriangle className="size-4" aria-hidden="true" />
      Attachment unavailable
    </span>
  );
}



export function MarkdownAttachmentViewer({ attachment }: { attachment: ChannelAttachment }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadMarkdown() {
      try {
        const source = attachmentFetchHref(attachment);
        if (!source) throw new Error("Markdown attachment is unavailable");
        const text = source.startsWith("data:")
          ? await dataUrlToBlob(source).text()
          : await xmatrixRawResponse(source, { cache: "no-store" }).then(async (response) => {
              if (!response.ok) throw await errorFromResponse(response);
              return response.text();
            });
        if (!cancelled) {
          setContent(text);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setContent("");
          setError(userErrorMessage(err, "Couldn't load this file"));
        }
      }
    }

    setContent("");
    setError(null);
    void loadMarkdown();
    return () => {
      cancelled = true;
    };
  }, [attachment]);

  return (
    <div className="flex h-full max-h-[94dvh] w-full max-w-5xl flex-col overflow-hidden rounded-md border border-border bg-background text-foreground shadow-2xl">
      <div className="flex min-h-12 items-center gap-3 border-b border-border bg-muted/50 px-4">
        <FileText className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{attachment.name}</div>
          <div className="text-xs text-muted-foreground">{formatFileSize(attachment.size)}</div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : content ? (
          <div className="rich-message max-w-none text-[15px] leading-6">
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} components={messageMarkdownComponents}>
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          <ContentSkeleton label="Loading Markdown" lines={6} />
        )}
      </div>
    </div>
  );
}



export /* Without a header the actions float over the body, so they show on a glass
   pill of their own instead of on top of the text. The pill sits behind them
   in the same grid cell rather than around them: glass repositions its
   children, which would pull the reaction picker into the pill. */
function FloatingMessageActions({ className, children, pinned }: {
  className?: string;
  children: ReactNode;
  pinned?: boolean;
}) {
  return (
    <div className={cn(
      "app-message-floating-actions absolute right-5 top-0 z-10 grid opacity-0 transition group-hover:opacity-100 has-[:focus-visible]:opacity-100",
      pinned && "opacity-100",
    )}>
      <LiquidGlassPill aria-hidden="true" className="pointer-events-none rounded-full [grid-area:1/1]" />
      <div className={cn("relative z-[1] [grid-area:1/1]", className)}>{children}</div>
    </div>
  );
}

function MessageCopyButton({
  copied,
  onCopy,
  className,
}: {
  copied: boolean;
  onCopy: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={copied ? "Copied" : "Copy message"}
      aria-label={copied ? "Copied" : "Copy message"}
      onClick={onCopy}
      className={cn(
        "ml-auto flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
        className
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}



export function ReplyPreview({
  reply,
  onJump,
}: {
  reply: TimelineItem["replyTo"] & object;
  onJump: (messageId: string, sequence?: number) => void;
}) {
  return (
    <a
      href={`#message:${encodeURIComponent(reply.messageId)}`}
      onClick={(event) => {
        // A bare hash only asks the browser to find a DOM anchor, which a
        // virtualized timeline usually does not have. Hand the click to the
        // jump intent instead; the href stays for open-in-new-tab, where the
        // cold deep link runs the same intent after the channel loads.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onJump(reply.messageId, reply.sequence);
      }}
      className="mb-1.5 mt-1 flex max-w-[min(36rem,100%)] items-start gap-2 border-l-2 border-primary/60 bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
    >
      <Reply className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="block truncate font-bold text-foreground">{reply.author}</span>
        <span className="line-clamp-2 [overflow-wrap:anywhere]">
          {reply.body || "Attachment"}
        </span>
      </span>
    </a>
  );
}



export function messageCopyText(message: TimelineItem): string {
  const body = normalizeMessageBodyForDisplay(message.body, message.senderKind);
  if (message.isEvent && message.author !== "xMatrix") {
    return `${message.author} - ${body}`;
  }
  return body;
}



const REACTION_LONG_PRESS_MS = 450;

export function reactionReactorsSummary(
  reaction: ChannelReaction,
  currentUserIdentityId: string
): string {
  const names = reaction.reactors.map((reactor) =>
    reactor.identityId === currentUserIdentityId ? "You" : reactor.label
  );
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function ReactionChip({
  reaction,
  currentUserIdentityId,
  onReact,
}: {
  reaction: ChannelReaction;
  currentUserIdentityId: string;
  onReact: (emoji: string) => void;
}) {
  const [touchCardOpen, setTouchCardOpen] = useState(false);
  const longPressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const reacted = reaction.reactors.some((reactor) => reactor.identityId === currentUserIdentityId);
  const who = reactionReactorsSummary(reaction, currentUserIdentityId);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  useEffect(() => {
    if (!touchCardOpen) return;
    const close = () => setTouchCardOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [touchCardOpen]);

  return (
    <div className="app-reaction-shell relative" data-open={touchCardOpen || undefined}>
      <button
        type="button"
        aria-label={who ? `${who} reacted with ${reaction.emoji}` : `React with ${reaction.emoji}`}
        onPointerDown={(event) => {
          clearLongPress();
          suppressClickRef.current = false;
          if (event.pointerType === "mouse") return;
          longPressTimerRef.current = window.setTimeout(() => {
            longPressTimerRef.current = null;
            suppressClickRef.current = true;
            setTouchCardOpen(true);
          }, REACTION_LONG_PRESS_MS);
        }}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        onPointerLeave={clearLongPress}
        onContextMenu={(event) => {
          if (suppressClickRef.current || longPressTimerRef.current !== null) event.preventDefault();
        }}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          onReact(reaction.emoji);
        }}
        className={cn(
          "flex h-6 select-none items-center gap-1 rounded-full border border-border bg-muted/50 px-2 text-xs [-webkit-touch-callout:none] hover:bg-muted",
          reacted && "border-primary/40 bg-primary/10 text-foreground"
        )}
      >
        <span>{reaction.emoji}</span>
        <span className="tabular-nums">{reaction.reactors.length}</span>
      </button>
      {who && (
        <span role="tooltip" className="app-reaction-tooltip app-hint-tooltip">
          {reaction.emoji} <strong>{who}</strong> reacted
        </span>
      )}
    </div>
  );
}

export function MessageReactions({
  message,
  currentUserIdentityId,
  onReact,
}: {
  message: TimelineItem;
  currentUserIdentityId: string;
  onReact: (emoji: string) => void;
}) {
  const reactions = message.reactions || [];
  if (!reactions.length) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {reactions.map((reaction) => (
        <ReactionChip
          key={reaction.emoji}
          reaction={reaction}
          currentUserIdentityId={currentUserIdentityId}
          onReact={onReact}
        />
      ))}
    </div>
  );
}

function QuickReactionPicker({
  className,
  itemClassName = "size-7 text-sm",
  onReact,
}: {
  className?: string;
  itemClassName?: string;
  onReact: (emoji: string) => void;
}) {
  return (
    <div role="group" aria-label="Quick reactions" className={cn("flex gap-1", className)}>
      {QUICK_REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          aria-label={`React ${emoji}`}
          className={cn("flex items-center justify-center rounded-full hover:bg-muted", itemClassName)}
          onClick={() => onReact(emoji)}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}



export type { AgentWorkItem } from "./workspace-shell-message-model";
import type { AgentWorkItem } from "./workspace-shell-message-model";
import { errorFromResponse, xmatrixRawResponse } from "@/lib/query/api-client";



export function AgentWorkDetailsDock({
  approvals,
  channel,
  token,
  timeline,
  events,
  stoppingAgentInstanceId,
  reborningAgentInstanceId,
  handingOffAgentInstanceId,
  onStopAgentInstance,
  onRebornAgentInstance,
  onHandoffAgentInstance,
  onOpenAgentTrace,
}: {
  approvals?: ReactNode;
  channel: SerializedChannel | null;
  token: string | null;
  timeline: TimelineItem[];
  events: ObservabilityEvent[];
  stoppingAgentInstanceId: string | null;
  reborningAgentInstanceId: string | null;
  handingOffAgentInstanceId: string | null;
  onStopAgentInstance: (
    agentId: string,
    instance: SerializedAgentInstance,
    agentLabel: string
  ) => void;
  onRebornAgentInstance: (
    agentId: string,
    instance: SerializedAgentInstance,
    agentLabel: string
  ) => void;
  onHandoffAgentInstance: (
    agentId: string,
    instance: SerializedAgentInstance,
    agentLabel: string,
    successor: string
  ) => void;
  onOpenAgentTrace: (target: AgentTraceTarget) => void;
}) {
  const launchQuery = useChannelAgentLaunches(channel, token, timeline);
  const launches = launchQuery.data?.launches ?? NO_LAUNCHES;
  const workItems = useMemo(() => buildAgentWorkItems(channel, events, launches),
    [channel, events, launches]);
  const intentSince = useIntentSince(workItems);
  const now = useNow();
  // Handoff successors are the harnesses this Space registered — the same
  // catalog the composer completes `:handoff:@` from.
  const registrationCatalog = useAgentRegistrationCatalog(channel?.spaceId ?? "", token ?? "",
    Boolean(token && channel?.spaceId && workItems.some(agentWorkCanReborn)));
  const handoffSuccessors = useMemo(() => agentWorkHandoffSuccessors(
    registrationCatalog.data?.capabilities.map((capability) => capability.harness) ?? []),
  [registrationCatalog.data]);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLElement | null>(null);

  /* The dock floats over the timeline and its scroller takes pointer events, so
     the timeline has to keep its tail clear of however much of it the dock
     actually covers. A constant cannot know that: the strip widens with every
     extra agent card, grows taller when a card wraps, and rides up and down
     with --app-composer-height. Whatever the constant falls short by lands on
     the newest message, whose hover controls sit at its
     bottom edge. Publish the measured distance and let the padding read it. */
  useLayoutEffect(() => {
    if (workItems.length === 0 && !approvals) {
      surfaceRef.current?.style.removeProperty("--app-agent-work-dock-clearance");
      return;
    }
    const dock = dockRef.current;
    const scroller = scrollerRef.current ?? dock;
    const surface = messageSurfaceOf(dock);
    if (!dock || !scroller || !surface) return;
    surfaceRef.current = surface;
    const dockElement = dock;
    const scrollerElement = scroller;
    const surfaceElement = surface;

    function publishClearance() {
      // The scroller overflows the dock's own box, so take whichever edge is
      // higher rather than assuming the dock bounds everything it paints.
      const top = Math.min(
        scrollerElement.getBoundingClientRect().top,
        dockElement.getBoundingClientRect().top
      );
      const clearance = surfaceElement.getBoundingClientRect().bottom - top;
      surfaceElement.style.setProperty(
        "--app-agent-work-dock-clearance",
        `${Math.max(0, Math.round(clearance))}px`
      );
    }

    publishClearance();
    const observer = new ResizeObserver(publishClearance);
    observer.observe(scrollerElement);
    observer.observe(dockElement);
    observer.observe(surfaceElement);
    /* A growing composer moves this dock without resizing it or the surface, so
       none of the observations above are delivered for it. The composer
       announces its own writes precisely because only the writer can order that
       correctly -- see MESSAGE_SURFACE_METRICS_EVENT. */
    surfaceElement.addEventListener(MESSAGE_SURFACE_METRICS_EVENT, publishClearance);
    window.addEventListener("resize", publishClearance);
    return () => {
      observer.disconnect();
      surfaceElement.removeEventListener(MESSAGE_SURFACE_METRICS_EVENT, publishClearance);
      window.removeEventListener("resize", publishClearance);
      surfaceElement.style.removeProperty("--app-agent-work-dock-clearance");
    };
  }, [workItems.length, approvals]);

  if (workItems.length === 0 && !approvals) return null;

  const controlsBusy =
    !!stoppingAgentInstanceId || !!reborningAgentInstanceId || !!handingOffAgentInstanceId;

  return (
    <div
      ref={dockRef}
      className="app-agent-work-dock pointer-events-none absolute inset-x-0 z-10 px-5 py-2"
    >
      {approvals}
      {workItems.length > 0 && <div
        ref={scrollerRef}
        className="app-agent-work-scroller pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto"
      >
        {workItems.map((item) => (
          <AgentWorkAvatar
            key={item.key}
            item={item}
            intentSince={intentSince.get(item.key)}
            now={now}
            stopping={stoppingAgentInstanceId === item.instance.id}
            stopDisabled={controlsBusy}
            reborning={reborningAgentInstanceId === item.instance.id}
            rebornDisabled={controlsBusy}
            handingOff={handingOffAgentInstanceId === item.instance.id}
            handoffSuccessors={handoffSuccessors}
            onStop={onStopAgentInstance}
            onReborn={onRebornAgentInstance}
            onHandoff={onHandoffAgentInstance}
            onOpenAgentTrace={onOpenAgentTrace}
          />
        ))}
      </div>}
    </div>
  );
}



export function AgentWorkAvatar({
  item,
  intentSince,
  now,
  stopping,
  stopDisabled,
  reborning,
  rebornDisabled,
  handingOff = false,
  handoffSuccessors = [],
  onStop,
  onReborn,
  onHandoff,
  onOpenAgentTrace,
}: {
  item: AgentWorkItem;
  /** When this client first saw the current intent (agent-work-intent.tsx). */
  intentSince?: number;
  now?: number;
  stopping: boolean;
  stopDisabled: boolean;
  reborning: boolean;
  rebornDisabled: boolean;
  handingOff?: boolean;
  /** Successor names offered by the Handoff picker, `auto` first. */
  handoffSuccessors?: readonly string[];
  onStop: (agentId: string, instance: SerializedAgentInstance, agentLabel: string) => void;
  onReborn: (agentId: string, instance: SerializedAgentInstance, agentLabel: string) => void;
  onHandoff?: (agentId: string, instance: SerializedAgentInstance, agentLabel: string, successor: string) => void;
  onOpenAgentTrace: (target: AgentTraceTarget) => void;
}) {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const touchHandledRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const avatarButtonRef = useRef<HTMLButtonElement | null>(null);
  const actionPopupRef = useRef<HTMLDivElement | null>(null);
  const actionToolbarRef = useRef<HTMLDivElement | null>(null);
  const hoverStackRef = useRef<HTMLDivElement | null>(null);
  const morphContentRef = useRef<HTMLDivElement | null>(null);
  // Which part of the item the pointer is on picks the card above it: the
  // island's words have their own (what it waits on), the face the Instance's.
  const [hoverPart, setHoverPart] = useState<"instance" | "intent">("instance");
  const [actionToolbarPosition, setActionToolbarPosition] = useState<CSSProperties>({ left: 0, top: 0 });
  const [handoffPickerOpen, setHandoffPickerOpen] = useState(false);
  const handoffPickerToggledRef = useRef(false);
  // Reborn, Handoff and Stop ask in place: the first press arms the button,
  // the second sends. A handoff arms the successor row that was pressed.
  const [armedAction, setArmedAction] = useState<string | null>(null);
  const stopArmed = armedAction === "stop";
  const stopArmedByGestureRef = useRef(false);
  const displayStatus = agentWorkDisplayStatus(item);
  const waiting = displayStatus === "waiting" ? item.instance.runtimeState?.waiting : undefined;
  const issue = item.instance.runtimeState?.issue;
  const notice = item.instance.runtimeState?.notice;
  // Decided upstream by `agentInstanceUsageLimit` from the same inputs the
  // detail row uses. Deriving it here again is what let the two disagree.
  const usageLimit = item.usageLimit;
  const canReborn = agentWorkCanReborn(item);
  // Handoff shares Reborn's address (`@<name>:<n>`); the picker only opens
  // when there is a successor to offer.
  const canHandoff = canReborn && Boolean(onHandoff) && handoffSuccessors.length > 0;
  const titleParts = [
    item.agentLabel,
    item.label,
    agentInstanceBranchLabel(item.instance),
    waiting ? agentWaitingPhrase(waiting, now ?? Date.now()) : presenceStatusLabel({
      status: displayStatus,
      activity: displayStatus === "busy" ? undefined : item.activity,
    }),
    usageLimit?.title,
    // Why its wake failed: the only place a wake, which answers no message, says so.
    item.instance.rest === "wake_failed" && item.instance.restReason ? item.instance.restReason : undefined,
    issue ? agentRuntimeIssuePhrase(issue, now ?? Date.now()) : undefined,
    notice ? agentRuntimeNoticePhrase(notice) : undefined,
  ].filter(Boolean);
  const title = titleParts.join(" - ");

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  function clearLongPressTimer() {
    if (longPressTimerRef.current === null) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }

  function requestStopFromGesture() {
    clearLongPressTimer();
    if (stopDisabled || item.canStop === false) return;
    longPressTriggeredRef.current = true;
    suppressNextClickRef.current = true;
    // The gesture opens the controls with Stop armed; pressing it there stops.
    stopArmedByGestureRef.current = true;
    setHandoffPickerOpen(false);
    setArmedAction("stop");
  }

  function pressArmed(action: string, send: () => void) {
    if (armedAction !== action) {
      setArmedAction(action);
      return;
    }
    setArmedAction(null);
    send();
  }

  function startLongPress() {
    clearLongPressTimer();
    if (stopDisabled || item.canStop === false) return;
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = window.setTimeout(requestStopFromGesture, 450);
  }

  function handleTouchEnd(event: ReactTouchEvent<HTMLButtonElement>) {
    clearLongPressTimer();
    touchHandledRef.current = true;
    if (longPressTriggeredRef.current) {
      event.preventDefault();
      longPressTriggeredRef.current = false;
    }
  }

  const positionActionToolbar = useCallback(() => {
    const avatar = avatarButtonRef.current;
    const popup = actionPopupRef.current;
    const stack = hoverStackRef.current;
    const content = morphContentRef.current;
    if (!avatar || !popup || !stack || !content) return;
    // The panel grows up out of the capsule the pointer is on: the island,
    // or the bare disc when there is none.
    const capsule = avatar.closest(".app-agent-work-island") ?? avatar;
    // The content keeps its final layout whatever size the glass is at, so
    // it measures the panel the glass grows into.
    const contentRect = content.getBoundingClientRect();
    const morph = morphPanelPosition(capsule, contentRect.width);
    // The panel sits outside the glass island. Its backdrop filter contains
    // the avatar, but does not contain this sibling popup.
    const containingBlockRect = fixedContainingBlockRect(popup);
    const nextPosition = {
      left: morph.left - (containingBlockRect?.left ?? 0),
      top: morph.bottom - (containingBlockRect?.top ?? 0),
      "--app-agent-work-capsule-x": `${morph.capsuleLeft}px`,
      "--app-agent-work-capsule-w": `${morph.capsuleWidth}px`,
      "--app-agent-work-capsule-h": `${morph.capsuleHeight}px`,
      "--app-agent-work-panel-w": `${Math.max(contentRect.width, morph.capsuleWidth)}px`,
      "--app-agent-work-panel-h": `${contentRect.height}px`,
    } as CSSProperties;
    setActionToolbarPosition((currentPosition) => {
      const current = currentPosition as Record<string, unknown>;
      const next = nextPosition as Record<string, unknown>;
      return Object.keys(next).every((key) => current[key] === next[key]) ? currentPosition : nextPosition;
    });
  }, []);

  // On the island the capsule is the one glass.
  const island = Boolean(item.intent || waiting || issue || notice);
  const intentCard = Boolean(island && (item.intent || waiting)) && (
    <div className="app-agent-work-action-menu" data-mode="card" role="note">
      <AgentWorkIntentCard intent={item.intent} since={intentSince} now={now ?? Date.now()}
        busy={displayStatus === "busy"} waiting={waiting} />
    </div>
  );
  // The usage limit heads the controls' own panel; it stands alone only when
  // there are no controls to share one with.
  const instanceCards = item.canStop !== false ? toolbar() : usageLimit && (
    <div className={cn("app-agent-work-action-menu", usageLimit.severity === "limit" && "text-destructive")}
      data-mode="card" role="note">
      <span className="app-agent-work-hover-line">{usageLimit.title}</span>
    </div>
  );
  const hoverCards = hoverPart === "intent" && intentCard ? intentCard : instanceCards;
  const { left: actionLayerLeft, top: actionLayerTop, ...morphGeometry } = actionToolbarPosition;
  const actionLayerPosition = { left: actionLayerLeft, top: actionLayerTop };
  const hasHoverCards = Boolean(hoverCards);

  useLayoutEffect(() => {
    const avatar = avatarButtonRef.current;
    const stack = hoverStackRef.current;
    const workItem = avatar?.closest(".app-agent-work-item");
    const layoutRoot = avatar?.closest(".app-message-surface");
    if (!avatar || !stack || !workItem || !layoutRoot) return;

    // The panel opens from the capsule's shape, so that shape has to be known
    // before the pointer arrives: follow the capsule's size while at rest too.
    const capsule = avatar.closest(".app-agent-work-island") ?? avatar;
    const capsuleObserver = new ResizeObserver(() => positionActionToolbar());
    capsuleObserver.observe(capsule);
    const stopFollowingLayout = observeToolbarLayout(avatar, stack, layoutRoot, positionActionToolbar, true,
      () => workItem.matches(":hover, :focus-within"));
    return () => {
      capsuleObserver.disconnect();
      stopFollowingLayout();
    };
  }, [positionActionToolbar, hasHoverCards, island]);

  useLayoutEffect(() => {
    positionActionToolbar();
    // The toolbar changes size under the pointer when the picker opens or
    // closes; keeping focus inside it keeps it shown (and keyboard-usable).
    if (!handoffPickerToggledRef.current) return;
    handoffPickerToggledRef.current = false;
    actionToolbarRef.current?.querySelector<HTMLButtonElement>(handoffPickerOpen
      ? '[data-action="handoff-successor"]' : '[data-action="handoff"]')?.focus();
  }, [handoffPickerOpen, positionActionToolbar]);

  useLayoutEffect(() => {
    if (!stopArmed || !stopArmedByGestureRef.current) return;
    stopArmedByGestureRef.current = false;
    // Focus within the item shows the controls (a touch never focuses the disc).
    avatarButtonRef.current?.focus();
    actionToolbarRef.current?.querySelector<HTMLButtonElement>('[data-action="stop"]')?.focus();
  }, [stopArmed]);

  const avatarButton = (
    <button
      ref={avatarButtonRef}
      type="button"
      aria-label={`Open ${title}`}
      onClick={(event) => {
        if (suppressNextClickRef.current) {
          suppressNextClickRef.current = false;
          event.preventDefault();
          return;
        }
        onOpenAgentTrace(item.target);
      }}
      onContextMenu={(event) => {
        if (item.canStop === false) return;
        event.preventDefault();
        event.stopPropagation();
        requestStopFromGesture();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenAgentTrace(item.target);
        } else if (item.canStop !== false && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
          event.preventDefault();
          requestStopFromGesture();
        }
      }}
      onPointerDown={(event) => {
        if (item.canStop === false) return;
        if (touchHandledRef.current && event.pointerType !== "mouse") return;
        if (event.pointerType === "mouse") return;
        startLongPress();
      }}
      onPointerEnter={positionActionToolbar}
      onPointerUp={(event) => {
        clearLongPressTimer();
        if (touchHandledRef.current && event.pointerType !== "mouse") {
          touchHandledRef.current = false;
          return;
        }
        if (longPressTriggeredRef.current) {
          event.preventDefault();
          longPressTriggeredRef.current = false;
        }
      }}
      onPointerCancel={clearLongPressTimer}
      onPointerLeave={clearLongPressTimer}
      onTouchStart={() => {
        if (item.canStop === false) return;
        touchHandledRef.current = true;
        startLongPress();
      }}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={clearLongPressTimer}
      onFocus={() => {
        setHoverPart("instance");
        positionActionToolbar();
      }}
      className="app-agent-work-avatar relative flex shrink-0 items-center justify-center rounded-full outline-none"
    >
      <IdentityAvatar
        kind={item.avatarKind || "agent"}
        label={item.agentLabel}
        status={displayStatus}
        imageUrl={item.avatarUrl}
        initials={avatarInitials(item.agentLabel)}
        size="md"
        showKindBadge={false}
        glass={false}
        className="pointer-events-none"
      />
      {usageLimit && (
        <span
          className={cn(
            "app-agent-work-limit flex min-w-6 items-center justify-center rounded-full border border-background px-1 py-0.5 text-[9px] font-black uppercase leading-none shadow-sm",
            usageLimit.severity === "limit"
              ? "bg-destructive text-destructive-foreground"
              : statusInkClass("attention", "bg-background")
          )}
        >
          {usageLimit.label}
        </span>
      )}
    </button>
  );

  return (
    <div
      className="app-agent-work-item group relative flex shrink-0 items-center"
      data-morph={hoverCards ? (island ? "panel" : "row") : undefined}
      // The capsule's geometry rides on the item, so a stretching disc can
      // push the items after it aside by exactly the width it grows.
      style={morphGeometry}
      onPointerOver={(event) => {
        // Moving onto the card itself keeps the card it is on.
        const target = event.target as Element;
        if (target.closest(".app-agent-work-actions")) return;
        setHoverPart(target.closest(".app-agent-work-intent") ? "intent" : "instance");
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        setHandoffPickerOpen(false);
        setArmedAction(null);
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setHandoffPickerOpen(false);
        setArmedAction(null);
      }}
    >
      {island ? (
        // The island (docs/design/agent-status.md §2): a glass capsule the
        // avatar's own size, growing straight out of the circular face.
        <LiquidGlassPill className="app-agent-work-island cursor-pointer" data-waiting={waiting?.kind}
          data-status={displayStatus}
          onClick={(event) => {
            // The disc handles its own click; the rest of the island opens the same trace.
            if (!avatarButtonRef.current?.contains(event.target as Node)) onOpenAgentTrace(item.target);
          }}>
          {avatarButton}
          <AgentRuntimeNotice issue={issue} notice={notice} now={now ?? Date.now()}
            onOpenTrace={() => onOpenAgentTrace(item.target)} />
          {(item.intent || waiting) && <AgentWorkIntent intent={item.intent} since={intentSince} now={now ?? Date.now()}
            busy={displayStatus === "busy"} waiting={waiting} />}
        </LiquidGlassPill>
      ) : avatarButton}
      {hoverCards ? (
        // The island grows up into a panel, as the composer does for its
        // completions: one glass whose bottom row is the island itself (the
        // seat), with the card the pointer asked for above it. A bare disc
        // has no words to sit under, so it just stretches right into a
        // capsule with its controls beside the face.
        <div ref={actionPopupRef} className="app-agent-work-actions" style={actionLayerPosition}>
          <LiquidGlassPill className="app-agent-work-morph" data-shape={island ? "panel" : "row"}>
            <div ref={morphContentRef} className="app-agent-work-morph-content">
              <div ref={hoverStackRef} className="app-agent-work-hover-stack">{hoverCards}</div>
              <span className="app-agent-work-morph-seat" aria-hidden="true" />
            </div>
          </LiquidGlassPill>
        </div>
      ) : null}
    </div>
  );

  function toolbar() {
    return (
      <div
        ref={actionToolbarRef}
        className="app-agent-work-action-menu"
        data-mode={handoffPickerOpen && canHandoff ? "handoff" : undefined}
        data-usage={usageLimit ? usageLimit.severity : undefined}
        role="toolbar"
        aria-label={`Controls for ${item.instance.label}`}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onFocus={positionActionToolbar}
      >
        {usageLimit && (
          <p className={cn("app-agent-work-usage-line", usageLimit.severity === "limit" && "text-destructive")}
            role="note">
            {usageLimit.title}
          </p>
        )}
        {handoffPickerOpen && canHandoff ? (
          <>
            <div className="app-agent-work-picker-header">
              <button
                type="button"
                aria-label="Back to controls"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handoffPickerToggledRef.current = true;
                  setArmedAction(null);
                  setHandoffPickerOpen(false);
                }}
                className="app-agent-work-action"
                data-action="back"
              >
                <ChevronLeft className="size-3.5" aria-hidden="true" />
              </button>
              <span className="app-agent-work-picker-label">Hand off {item.label} to</span>
            </div>
            {/* One row per successor, so five or fifty stay one column;
                the list scrolls inside the toolbar past a few rows. */}
            <div className="app-agent-work-picker-list" role="group" aria-label={`Hand off ${item.instance.label} to`}>
              {handoffSuccessors.map((successor) => {
                const armed = armedAction === `handoff:${successor}`;
                const target = successor === "auto" ? "the best available agent" : `a new @${successor}`;
                return (
                  <button
                    key={successor}
                    type="button"
                    aria-label={`${armed ? "Confirm hand off" : "Hand off"} ${item.instance.label} to ${target}`}
                    disabled={rebornDisabled}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      pressArmed(`handoff:${successor}`, () => {
                        setHandoffPickerOpen(false);
                        onHandoff?.(item.agentId, item.instance, item.agentLabel, successor);
                      });
                    }}
                    className="app-agent-work-action"
                    data-action="handoff-successor"
                    data-armed={armed || undefined}
                  >
                    <span>{armed ? "Confirm" : successor === "auto" ? "Auto" : `@${successor}`}</span>
                    {successor === "auto" && !armed ? (
                      <span className="app-agent-work-picker-hint">most headroom</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </>
        ) : <div className="app-agent-work-action-row">
        <span className="app-agent-work-instance-name">{item.label}</span>
        {canReborn ? (
          <button
            type="button"
            aria-label={armedAction === "reborn" ? `Confirm reborn ${item.instance.label}` : `Reborn ${item.instance.label}`}
            disabled={rebornDisabled}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              pressArmed("reborn", () => onReborn(item.agentId, item.instance, item.agentLabel));
            }}
            className="app-agent-work-action"
            data-action="reborn"
            data-armed={armedAction === "reborn" || undefined}
          >
            {reborning ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden="true" />
            )}
            <span>{armedAction === "reborn" ? "Confirm" : "Reborn"}</span>
          </button>
        ) : null}
        {canHandoff ? (
          <button
            type="button"
            aria-label={`Hand off ${item.instance.label}`}
            disabled={rebornDisabled}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handoffPickerToggledRef.current = true;
              setArmedAction(null);
              setHandoffPickerOpen(true);
            }}
            className="app-agent-work-action"
            data-action="handoff"
          >
            {handingOff ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ArrowRightLeft className="size-3.5" aria-hidden="true" />
            )}
            <span>Handoff</span>
          </button>
        ) : null}
        <button
          type="button"
          aria-label={stopArmed ? `Confirm stop ${item.instance.label}` : `Stop ${item.instance.label}`}
          disabled={stopDisabled}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            pressArmed("stop", () => onStop(item.agentId, item.instance, item.agentLabel));
          }}
          className="app-agent-work-action"
          data-action="stop"
          data-armed={stopArmed || undefined}
        >
          {stopping ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="size-3.5" aria-hidden="true" />
          )}
          <span>{stopArmed ? "Confirm" : "Stop"}</span>
        </button>
        </div>}
      </div>
    );
  }
}



export function agentWorkDisplayStatus(item: AgentWorkItem): string {
  return agentInstanceDisplayStatus({
    agentId: item.agentId,
    events: item.latestEvent ? [item.latestEvent] : [],
    instance: item.instance,
    fallbackStatus: item.status,
    name: item.agentLabel,
    activity: item.activity,
  });
}



/** `auto` first, then each registered harness once, in catalog order. */
export function agentWorkHandoffSuccessors(harnesses: readonly string[]): string[] {
  const names = harnesses.map((harness) => harness.trim().replace(/^[@＠]/, ""))
    .filter((harness) => harness && isHandoffSuccessorName(harness) && !isAutoHandoffSuccessor(harness));
  return names.length > 0 ? ["auto", ...new Set(names)] : [];
}

export function agentWorkCanReborn(item: AgentWorkItem): boolean {
  if (item.canStop === false) return false;
  if (item.avatarKind === "system") return false;
  const channelInstanceId = item.instance.channelInstanceId?.trim();
  return Boolean(channelInstanceId && /^[1-9]\d*$/.test(channelInstanceId));
}



export {
  RichMessageContent,
  messageMarkdownComponents,
} from "./workspace-shell-rich-message";

export { MarkdownPre } from "./workspace-shell-formatters";

export { messageAttachmentBindings } from "./workspace-shell-message-model";

export {
  messageProvenance,
  timelineItemId,
  agentInstanceBranchLabel,
} from "./workspace-shell-message-model";

/** Where a cross-Channel message came from. A reader who cannot open the
 *  origin sees only that it came from elsewhere, never which Channel. */
function LinkOriginTag({
  origin,
  onOpenInternalAppLink,
}: {
  origin: MessageLinkOrigin;
  onOpenInternalAppLink: (href: string) => boolean;
}) {
  const label = messageLinkOriginLabel(origin);
  const title = messageLinkOriginTitle(origin);
  if (!origin.href) {
    return <span className={tagClass("app-link-origin-tag")} title={title}>{label}</span>;
  }
  return (
    <a
      href={origin.href}
      title={title}
      className={tagClass("app-link-origin-tag", "hover:text-foreground")}
      onClick={(event) => {
        if (onOpenInternalAppLink(origin.href!)) event.preventDefault();
      }}
    >
      {label}
    </a>
  );
}

function attachmentCopyLabel(name: string, failed: boolean, copied: boolean): string {
  return `${failed ? "Could not copy" : copied ? "Copied" : "Copy"} ${name}`;
}
