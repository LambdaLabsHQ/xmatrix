"use client";

import { pageShellActions } from "./page-shell-actions";
import { useDesktopFullScreen } from "@/lib/desktop/use-desktop-full-screen";
import { discussionDraft, discussionTitle } from "./selection-discussion";
import { pageApi } from "@/lib/pages/page-client";
import { createConversation } from "./start-conversation";

import { isMessageSendDeadlineError } from "@/lib/relay-v2/message-send-deadline";
import { fetchChannelCatalogResolve } from "./channel-catalog-query";
import { useHumanProfileViewState } from "./use-human-profile-view-state";
import {
  commitReconciledOutgoing,
  createUnconfirmedSendReconciler,
  reconnectableUnconfirmedSends,
} from "./reconcile-unconfirmed-send";

import type {
  DesktopAgentPresetDiscovery,
  DesktopWorkspaceCandidate,
} from "@/lib/desktop/bridge";

import {
  INITIAL_HISTORY_LIMIT,
  TIMELINE_BOTTOM_STICK_MS,
} from "./workspace-shell-constants";

import { createMobileChannelHistoryNavigation } from "./mobile-channel-history-navigation";
import { sendHumanChannelFocus } from "./send-human-channel-focus";
import { pointerActivationAlreadyHandled } from "./pointer-activation-guard";
import {
  MORE_TAB_VIEWS,
  toolItemPath,
} from "./workspace-shell-navigation";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";

import {
  localMentionContextFromDaemon,
  parseAppMentions,
} from "@/components/dashboard/mention-complete";
import {
  clearChannelComposerDraft,
  writeChannelComposerDraft,
} from "@/components/dashboard/channel-composer-drafts";
import { useAgentTraceHistorySync } from "@/components/dashboard/use-agent-trace-history-sync";
import {
  resolveAgentTraceTargetOwner,
} from "@/components/dashboard/agent-trace-target";
import {
  workspaceKey,
} from "@/components/dashboard/agent-workspaces";
import {
  absoluteChannelUrl,
  channelAppPath,
  channelTitle,
  parseInternalChannelLink,
  resolveChannelRouteKey,
  resolveSpaceRouteKey,
  spaceAppPath,
} from "@/components/dashboard/channel-links";
import { APP_CONNECTORS } from "@/lib/app-connectors";
import { AGENT_PRESETS, WEB_PROXY_ROUTES, agentLaunchExecutable, canonicalRegistrationHarness, parseHandoffInstanceTarget, type AgentRegistrationDetails } from "@xmatrix/protocol";
import type {
  ChannelMessage,
  SerializedAgentInstance,
  SerializedChannel,
  SerializedSpace,
  SpaceMemberPermissions,
  SerializedWorkspace,
} from "@xmatrix/protocol";

import {
  createSpaceInviteCodeRequest,
  type SpaceInviteCodeOptions,
} from "@/components/dashboard/space-invite-codes";
import {
  AgentConfigForm,
  AgentTraceTarget,
  AppView,
  ChannelCreateMode,
  ChannelHistoryCacheEntry,
  ComposerSendSnapshot,
  DESKTOP_SETUP_VERSION,
  EVENT_LIMIT,
  LocalManagedAgent,
  MOBILE_CHANNEL_LIST_RETURN_PATH_STATE_KEY,
  MOBILE_MORE_RETURN_PATH_STATE_KEY,
  OLDER_HISTORY_LIMIT,
  OutgoingMessage,
  SpaceInviteResult,
  SpaceInviteRole,
  SpaceMemberActionResult,
  TimelineItem,
  agentInstanceStopBody,
  agentPresetOrCustom,
  agentTraceTargetFromAgentInstance,
  agentTraceTargetFromInstance,
  appLinkMessageIdFromHash,
  appRouteInfo,
  appViewPath,
  appendChannelMessageWithAttachments,
  claimOutgoingClientIdForEntry,
  appendOutgoingTimelineItems,
  buildLocalManagedAgents,
  buildMachineSummaries,
  buildTimeline,
  canInviteToSpace,
  channelUnreadCount,
  clearBrowserHash,
  copyTextToClipboard,
  currentBrowserLocation,
  daemonStatusNeedsSessionSync,
  defaultAgentName,
  parseConfigList,
  deleteWorkspace,
  desktopUpdateErrorStatus,
  earliestPositiveSequence,
  emptyAgentConfigForm,
  errorMessage,
  eventLabel,
  exchangeDesktopCliSession,
  fetchChannels,
  fetchEvents,
  fetchProjects,
  fetchSpaces,
  isLlmTraceEvent,
  isNativeNotificationEvent,
  isThreadChannel,
  isTimelineNearBottom,
  isValidChannelMessage,
  latestSequence,
  localWorkspacesForDesktop,
  metadataString,
  nativeNotificationEventMessageId,
  nativeNotificationEventMessageIdWasHandled,
  notificationPathForEvent,
  optimisticDesktopUpdateInstallStatus,
  pushBrowserPath,
  reactToChannelMessage,
  rebornBodyForMessageSender,
  recallChannelMessage,
  registerWorkspace,
  replaceBrowserPath,
  replaceChannel,
  replaceSpace,
  replaceWorkspace,
  replyPreviewSequence,
  observeTimelineContentResize,
  restoreTimelineScrollTop,
  scrollTimelineToBottom,
  sortProjects,
  threadChannelForMessage,
  timelineBelongsToChannel,
  updateChannelMessage,
  useStableCallback,
  viewLabels,
} from "./workspace-shell-modules";
import { shareTimelineItems } from "./workspace-shell-message-model";
import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { registrationSpaceCommand } from "./registration-space-command";
import { xmatrixApiRequest, requireResponseOk } from "@/lib/query/api-client";
import type { WorkspaceShellState } from "./use-workspace-shell-state";
import { useWorkspaceAutomationActions } from "./use-workspace-automation-actions";
import { spaceMemberCanCreate } from "./space-member-permissions";

export function useWorkspaceShellActions(s: WorkspaceShellState) {
  const queryClient = useQueryClient();
  const fetch = useXMatrixQueryFetch(s.authenticatedUserId);
  const { profileUserId, setProfileUserId } = useHumanProfileViewState();
  const {
    setBrowserPath,
    bumpMessageJumpRevision,
    setView,
    setBrowserHash,
    landMessageJump,
    settleMessageJump,
    armMessageJumpHighlight,
    queueMessageJump,
    setChannels,
    setSpaces,
    setProjects,
    setScheduleFocusId,
    setEvents,
    setChannelReadCounts,
    setChannelReadCountsBaselineReady,
    setSelectedChannelId,
    setPendingExplicitSpaceId,
    runMobileScreenTransition,
    setWorkingSpaceId,
    setLoadingWorkspace,
    setLoadingHistory,
    setOlderLoading,
    setReborningAgentInstanceId,
    setAgentInstanceStopRequest,
    setRenamingChannelId,
    setUpdatingChannelVisibilityId,
    setOutgoingMessages,
    setError,
    setHistoryError,
    setAgentsError,
    setSpacesError,
    setMobileChannelDetailsOpen,
    setDesktopContext,
    setDesktopDaemonStatus,
    setDesktopUpdateStatus,
    setDesktopSetupStatus,
    setAgentPresetDiscoveries,
    setLoadingAgentPresetDiscoveries,
    setLocalActionBusy,
    setLocalActionError,
    setRuntimeCheck,
    setCheckingDesktopUpdates,
    setMentionInsertRequest,
    setComposerAutoFocusRequest,
    setDraftWorkspaceTarget,
    setDraftAttachments,
    setReplyTarget,
    seedComposerDraftText,
    setAgentTraceTarget,
    setAgentTraceHistoryPanelState,
    cancelAgentTraceHistoryBootstrap,
    reconcileAgentTraceChannelAccess,
    setAgentConfigDialog,
    setAgentConfigForm,
    setSavingAgentConfig,
    setDeletingAgentId,
    setComposingConversation,
    setChannelMoveOpen,
    setChannelMoveTargetSpaceId,
    setMovingChannelId,
    setChannelMoveError,
    setChannelQuickOpen,
    setWorkspaceSearchOpen,
    setRenamingSpaceId,
    setNewSpaceName,
    setCreatingSpace,
    authorizeHistoryRender,
    mergeAndRememberChannelHistory,
    queueChannelTimelineScroll,
    markChannelReadToSequence,
    applyChannelHistory,
    recordHistoryTailBase,
    markNativeMessageNotified,
  } = s;

  // One cache entry per history window, shared with the shell's own reads.
  const fetchChannelHistory = s.fetchChannelHistoryQuery;

  // Timeline pagination and message-jump pagination share this loader. React
  // state is asynchronous, so the ref keeps both paths to one keyset request.
  const olderHistoryLoadInFlightRef = useRef(false);

  // Stable timeline handlers so MessageTimeline memo can skip when only draft-unrelated shell state churns.
  const handleTimelineScrollPositionChange = useStableCallback((pinned: boolean, scrollTop: number) => {
    if (!s.timelineActiveRef.current) return;
    if (s.pendingChannelScrollRef.current || Date.now() <= s.timelineBottomStickUntilRef.current) {
      // Programmatic bottom-landing ignores onScroll while it owns the tail.
      // A reader who has clearly left the tail (scrollbar, keyboard, trackpad
      // without a wheel target on the timeline) must still take ownership —
      // otherwise stick + ResizeObserver keep yanking them back down.
      if (pinned) return;
      s.timelineBottomStickUntilRef.current = 0;
      s.timelineBottomStickCleanupRef.current?.();
      s.pendingChannelScrollRef.current = null;
    } else if (!pinned) {
      // Drop a stale bottom-growth watcher once the reader leaves the tail,
      // even after the open-channel stick window has already expired.
      s.timelineBottomStickCleanupRef.current?.();
    }
    s.timelinePinnedToBottomRef.current = pinned;
    s.timelineScrollTopRef.current = scrollTop;
  });

  // Touching or wheeling the timeline hands the scroll position back to the
  // reader immediately, whatever the open-channel landing is still doing.
  const handleTimelineScrollGesture = useStableCallback(() => {
    if (!s.timelineScrollRef.current) return;
    s.timelineBottomStickUntilRef.current = 0;
    s.timelineBottomStickCleanupRef.current?.();
    s.pendingChannelScrollRef.current = null;
    s.timelinePinnedToBottomRef.current = isTimelineNearBottom(s.timelineScrollRef.current);
  });

  const handleTimelineNearTop = useStableCallback(() => {
    if (s.pendingChannelScrollRef.current) return;
    void loadOlderMessages();
  });

  const handleTimelineLoadOlder = useStableCallback(() => {
    void loadOlderMessages();
  });

  // Follow-up evidence often carries an exact sequence. Prefer one bounded
  // seek into that neighborhood over many tail-to-head page walks when the
  // evidence is far behind the currently loaded window.
  const handleTimelineSeekForJump = useStableCallback((
    channelId: string,
    messageId: string,
    sequence: number,
    requestId: number,
  ) => {
    void seekHistoryForMessageJump(channelId, messageId, sequence, requestId);
  });

  const handleTimelineReact = useStableCallback((message: TimelineItem, emoji: string) => {
    void toggleMessageReaction(message, emoji);
  });

  const handleTimelineEdit = useStableCallback((message: TimelineItem, body: string) => {
    void editMessage(message, body);
  });

  const handleTimelineRecall = useStableCallback((message: TimelineItem) => {
    void recallMessage(message);
  });

  const handleTimelineReply = useStableCallback((message: TimelineItem) => {
    s.replyTargetRef.current = message;
    s.replyTargetHistoryRevisionRef.current = s.historyRevision;
    setReplyTarget(message);
  });

  /* Jumping to a quoted message inside the open channel arms the same intent a
     cross-channel navigation does. A reply target always lives in the same
     channel, so this never has to route; it only has to be an intent, or the
     jump silently dies whenever the target is outside the loaded window. */
  const handleTimelineJumpToMessage = useStableCallback((messageId: string, sequence?: number) => {
    const channelId = s.selectedChannelIdRef.current;
    if (!channelId || !messageId) return;
    queueMessageJump(channelId, messageId, sequence);
  });

  const handleTimelineOpenThread = useStableCallback((message: TimelineItem) => {
    void openMessageThread(message);
  });

  const handleTimelineMentionSender = useStableCallback((message: TimelineItem) => {
    insertMentionIntoComposer(message.senderMention || message.author);
  });

  const handleTimelineRebornSender = useStableCallback((message: TimelineItem) => {
    void rebornMessageSender(message);
  });

  const handleTimelineQuestionnaireAnswer = useStableCallback((message: TimelineItem, answer: string) => {
    void sendQuestionnaireAnswer(message, answer);
  });

  const handleTimelineOpenInternalAppLink = useStableCallback((href: string) => openInternalAppLink(href));

  // The in-memory cache holds only this user's reads; it renders once the
  // selected Channel's rows are authorized. A copy per cache revision lets the
  // memos below see writes to the cache ref.
  const renderableHistoryCache = useMemo(() => {
    if (!s.historyRenderAuthorized || !s.selectedChannelId || s.historyCacheRevision < 0) {
      return new Map<string, ChannelHistoryCacheEntry>();
    }
    return new Map(s.historyCacheRef.current);
  }, [s.historyCacheRef, s.historyCacheRevision, s.historyRenderAuthorized, s.selectedChannelId]);

  const renderableOutgoingMessages = useMemo(() => {
    const authorizedById = new Map(s.renderableHistory.map((message) => [message.messageId, message]));
    return s.outgoingMessages.map((message) => {
      if (!message.replyToMessageId) return message;
      const target = authorizedById.get(message.replyToMessageId);
      return {
        ...message,
        replyTo: target
          ? {
              messageId: target.messageId,
              author: target.from.label,
              body: target.recalledAt ? "Message recalled" : target.body,
              ...replyPreviewSequence(target.sequence),
            }
          : undefined,
      };
    });
  }, [s.outgoingMessages, s.renderableHistory]);

  const previousTimelineRef = useRef<readonly TimelineItem[]>([]);
  const timeline = useMemo(
    () => {
      const shared = shareTimelineItems(previousTimelineRef.current, appendOutgoingTimelineItems(
        buildTimeline(
          s.renderableHistory,
          s.selectedChannel,
          s.channels,
          s.agentStatusEvents,
          s.user,
          s.channelReadCounts,
          renderableHistoryCache,
          s.outboundClientIdsByMessageIdRef.current,
          s.outboundPreviewByClientIdRef.current,
          s.currentSpace?.members,
        ),
        renderableOutgoingMessages,
        s.selectedChannel?.id,
        s.user
      ));
      previousTimelineRef.current = shared;
      return shared;
    },
    [
      s.agentStatusEvents,
      s.currentSpace?.members,
      s.channelReadCounts,
      s.channels,
      renderableHistoryCache,
      renderableOutgoingMessages,
      s.selectedChannel,
      s.renderableHistory,
      s.user, s.outboundPreviewByClientIdRef, s.outboundClientIdsByMessageIdRef,
    ]
  );

  const selectedThreadRootContext = useMemo(() => {
    if (!s.selectedChannel || !isThreadChannel(s.selectedChannel)) return null;
    const parentChannelId = metadataString(s.selectedChannel.metadata, "threadRootChannelId");
    const rootMessageId = metadataString(s.selectedChannel.metadata, "threadRootMessageId");
    const rootCopyMessageId = metadataString(s.selectedChannel.metadata, "threadRootCopyMessageId");
    if (!parentChannelId || !rootMessageId) return null;
    // When the thread history already contains the root message (e.g. via Authority
    // channel-history injection), render it as the first timeline message
    // instead of duplicating it with a separate context row.
    if (
      renderableHistoryCache.get(s.selectedChannel.id)?.messages
        .some((item) => item.messageId === rootCopyMessageId || item.messageId === rootMessageId)
    ) {
      return null;
    }
    const parentChannel = s.channels.find((item) => item.id === parentChannelId);
    const rootMessage = renderableHistoryCache.get(parentChannelId)?.messages
      .find((item) => item.messageId === rootMessageId);
    if (!parentChannel || !rootMessage) return null;
    const rootTimeline = buildTimeline(
      [rootMessage],
      parentChannel,
      s.channels,
      s.agentStatusEvents,
      s.user,
      s.channelReadCounts,
      renderableHistoryCache,
      s.outboundClientIdsByMessageIdRef.current,
      s.outboundPreviewByClientIdRef.current,
      s.currentSpace?.members,
    );
    const message = rootTimeline[0];
    return message ? { message, channel: parentChannel } : null;
  }, [
    s.agentStatusEvents,
    s.currentSpace?.members,
    s.channelReadCounts,
    s.channels,
    renderableHistoryCache,
    s.selectedChannel,
    s.user, s.outboundClientIdsByMessageIdRef, s.outboundPreviewByClientIdRef,
  ]);

  const latestTimelineItemId = timeline[timeline.length - 1]?.id || "";

  const settleTimelineBottom = useCallback((channelId: string, hash: string) => {
    const stillHoldingBottom = () =>
      s.selectedChannelIdRef.current === channelId &&
      !hash &&
      Boolean(s.timelineScrollRef.current) &&
      s.timelinePinnedToBottomRef.current;

    const scrollIfStillSticky = () => {
      if (!stillHoldingBottom() || Date.now() > s.timelineBottomStickUntilRef.current) return;
      scrollTimelineToBottom(s.timelineScrollRef.current, s.messagesEndRef.current);
    };

    window.requestAnimationFrame(() => {
      scrollIfStillSticky();
      window.requestAnimationFrame(scrollIfStillSticky);
    });
    window.setTimeout(scrollIfStillSticky, 120);

    // Two frames only cover rows that are already laid out. Attachments,
    // avatars and web fonts land later — on a phone routinely hundreds of
    // milliseconds later — and every one of them pushes the newest message
    // back off screen. A reader parked on the newest message stays there
    // through that growth; the watcher is dropped the moment they scroll away
    // by hand, leave the channel, or a jump takes the scroll position.
    s.timelineBottomStickCleanupRef.current?.();
    const stopObservingResize = observeTimelineContentResize(s.timelineScrollRef.current, () => {
      if (!stillHoldingBottom()) return;
      scrollTimelineToBottom(s.timelineScrollRef.current, s.messagesEndRef.current);
    });
    s.timelineBottomStickCleanupRef.current = () => {
      s.timelineBottomStickCleanupRef.current = null;
      stopObservingResize();
    };
  }, [s.timelineScrollRef, s.messagesEndRef, s.timelinePinnedToBottomRef, s.timelineBottomStickUntilRef, s.selectedChannelIdRef, s.timelineBottomStickCleanupRef]);

  /* A cold `#message:` deep link is an intent, not a landing. Promote it to a
     real jump request once its channel is selected so it gets the same
     paging/seek path as an in-app jump instead of silently failing whenever the
     target sits outside the first history page. */
  useEffect(() => {
    if (!s.selectedChannelId) return;
    const hashMessageId = appLinkMessageIdFromHash(s.browserHash);
    if (!hashMessageId) return;
    const pending = s.pendingMessageJumpRef.current;
    if (
      pending &&
      pending.channelId === s.selectedChannelId &&
      pending.messageId === hashMessageId
    ) {
      return;
    }
    queueMessageJump(s.selectedChannelId, hashMessageId);
  }, [s.browserHash, s.pendingMessageJumpRef, queueMessageJump, s.selectedChannelId]);

  useLayoutEffect(() => {
    const previousTimelineLength = s.previousTimelineLengthRef.current;
    s.previousTimelineLengthRef.current = timeline.length;
    if (!s.selectedChannelId) return;

    const pendingChannelScroll = s.pendingChannelScrollRef.current;
    const pendingMessageJump = s.pendingMessageJumpRef.current;
    const pendingJumpForChannel =
      pendingMessageJump && pendingMessageJump.channelId === s.selectedChannelId
        ? pendingMessageJump
        : null;
    // Prefer the armed in-app jump target; fall back to the URL hash for cold
    // deep links that never went through navigateToChannel.
    const jumpHash = pendingJumpForChannel
      ? `#message:${pendingJumpForChannel.messageId}`
      : s.browserHash;
    if (
      pendingChannelScroll?.channelId === s.selectedChannelId &&
      (s.loadingWorkspace ||
        s.loadingHistory ||
        timeline.length === 0 ||
        !s.timelineScrollRef.current ||
        !timelineBelongsToChannel(timeline, s.selectedChannelId))
    ) {
      return;
    }
    if (!latestTimelineItemId) return;

    const lastTarget = s.lastTimelineScrollTargetRef.current;
    const channelChanged = lastTarget.channelId !== s.selectedChannelId;
    const tailChanged = channelChanged || lastTarget.itemId !== latestTimelineItemId;
    const timelineRehydrated = previousTimelineLength === 0 && timeline.length > 0;
    s.lastTimelineScrollTargetRef.current = {
      channelId: s.selectedChannelId,
      itemId: latestTimelineItemId,
    };

    const jumpTargetMessageId =
      pendingJumpForChannel?.messageId || appLinkMessageIdFromHash(jumpHash);
    const jumpOutcome = landMessageJump(jumpHash, jumpTargetMessageId);
    if (jumpOutcome === "settling") {
      // The row is in the data but not yet placed. Keep the jump armed - and
      // keep the scroll - until the landing is observed.
      if (pendingJumpForChannel) settleMessageJump(pendingJumpForChannel.requestId);
      return;
    }
    if (jumpOutcome === "landed") {
      if (pendingChannelScroll?.channelId === s.selectedChannelId) {
        s.pendingChannelScrollRef.current = null;
      }
      if (
        pendingJumpForChannel &&
        s.pendingMessageJumpRef.current?.requestId === pendingJumpForChannel.requestId
      ) {
        s.pendingMessageJumpRef.current = null;
      }
      s.timelinePinnedToBottomRef.current = false;
      // The intent is consumed right here, so the highlight must outlive it —
      // hold the target row visible long enough for the reader to find it.
      if (jumpTargetMessageId) {
        armMessageJumpHighlight(jumpTargetMessageId);
      }
      clearBrowserHash();
      setBrowserHash("");
      return;
    }

    // Follow-up evidence can be older than the initial history page. Pull
    // earlier pages (or seek by sequence) while the jump is armed so the
    // target can mount. Never fall through to scroll-to-bottom while armed.
    if (pendingJumpForChannel) {
      const targetIsLoaded = timeline.some(
        (item) => item.messageId === pendingJumpForChannel.messageId
      );
      if (!targetIsLoaded) {
        const evidenceSequence = pendingJumpForChannel.sequence;
        const earliestLoaded = earliestPositiveSequence(s.history);
        const canSeekBySequence =
          typeof evidenceSequence === "number" &&
          evidenceSequence > 0 &&
          (earliestLoaded === undefined || evidenceSequence < earliestLoaded);
        const seekInFlight =
          s.messageJumpSeekInFlightRef.current === pendingJumpForChannel.requestId;
        const seekAlreadyTried =
          s.messageJumpSeekAttemptedRef.current === pendingJumpForChannel.requestId;
        if (canSeekBySequence && !seekAlreadyTried && !seekInFlight) {
          handleTimelineSeekForJump(
            pendingJumpForChannel.channelId,
            pendingJumpForChannel.messageId,
            evidenceSequence,
            pendingJumpForChannel.requestId,
          );
          return;
        }
        if (canSeekBySequence && seekInFlight) {
          // Seek already in flight for this jump request.
          return;
        }
        if (s.hasOlderMessages) {
          if (!s.olderLoading) handleTimelineLoadOlder();
          return;
        }
        // Keep waiting while the first page is still arriving or an older page
        // is in flight. Abandoning here made follow-ups look like a no-op when
        // the cache briefly claimed "no older messages".
        if (
          s.loadingHistory ||
          s.loadingWorkspace ||
          s.olderLoading ||
          s.historyRefreshInFlightRef.current ||
          timeline.length === 0
        ) {
          return;
        }

        // The channel history is exhausted and the snapshot points at a message
        // that is no longer available. Release the jump so ordinary timeline
        // scrolling is not permanently suppressed by a stale follow-up.
        s.pendingMessageJumpRef.current = null;
        clearBrowserHash();
        setBrowserHash("");
        return;
      }

      // The target is in React state but its row has not mounted yet. Keep the
      // jump armed for the next layout pass rather than scrolling to the tail.
      return;
    }

    // Opening a channel owns the scroll position for a short window, not for a
    // single commit. A cold open paints in stages — cached tail first, then the
    // authority window — and the later stages keep the same newest message
    // while adding rows above it, so the tail-changed test alone never fires.
    // Blink hides this behind scroll anchoring; WebKit has none, which is why
    // the iOS app is where opening a channel lands short of the newest message.
    const channelOpenStillOwnsScroll = Date.now() <= s.timelineBottomStickUntilRef.current;

    if (pendingChannelScroll?.channelId === s.selectedChannelId) {
      scrollTimelineToBottom(s.timelineScrollRef.current, s.messagesEndRef.current);
      s.timelinePinnedToBottomRef.current = true;
      s.pendingChannelScrollRef.current = null;
      s.timelineBottomStickUntilRef.current = Date.now() + TIMELINE_BOTTOM_STICK_MS;
      settleTimelineBottom(s.selectedChannelId, s.browserHash);
      return;
    }

    if (
      (tailChanged || timelineRehydrated || channelOpenStillOwnsScroll) &&
      s.timelinePinnedToBottomRef.current
    ) {
      scrollTimelineToBottom(s.timelineScrollRef.current, s.messagesEndRef.current);
      s.timelinePinnedToBottomRef.current = true;
      if (channelOpenStillOwnsScroll) {
        // Renew rather than count frames: the open intent should outlive a slow
        // history stage, and expire once the channel stops changing.
        s.timelineBottomStickUntilRef.current = Date.now() + TIMELINE_BOTTOM_STICK_MS;
      }
      settleTimelineBottom(s.selectedChannelId, s.browserHash);
    } else if (timelineRehydrated) {
      restoreTimelineScrollTop(s.timelineScrollRef.current, s.timelineScrollTopRef.current);
    }
  }, [
    armMessageJumpHighlight,
    s.browserHash,
    handleTimelineLoadOlder,
    handleTimelineSeekForJump,
    s.hasOlderMessages,
    s.history,
    landMessageJump,
    latestTimelineItemId,
    settleMessageJump,
    s.loadingHistory,
    s.loadingWorkspace,
    s.messageJumpRevision,
    s.olderLoading,
    s.selectedChannelId,
    settleTimelineBottom,
    timeline,
    timeline.length, s.messagesEndRef, s.pendingMessageJumpRef, setBrowserHash, s.previousTimelineLengthRef, s.messageJumpSeekAttemptedRef, s.pendingChannelScrollRef, s.lastTimelineScrollTargetRef, s.timelinePinnedToBottomRef, s.messageJumpSeekInFlightRef, s.timelineScrollRef, s.historyRefreshInFlightRef, s.timelineBottomStickUntilRef, s.timelineScrollTopRef,
  ]);

  useEffect(() => {
    s.latestHistorySequenceRef.current = latestSequence(s.history);
  }, [s.history, s.latestHistorySequenceRef]);


  const openAgentTrace = useCallback(
    (target: AgentTraceTarget) => {
      cancelAgentTraceHistoryBootstrap();
      setAgentTraceHistoryPanelState(null);
      setAgentTraceTarget(resolveAgentTraceTargetOwner(target, s.agents));
    },
    [s.agents, cancelAgentTraceHistoryBootstrap, setAgentTraceHistoryPanelState, setAgentTraceTarget]
  );

  const closeAgentTrace = useCallback(() => {
    cancelAgentTraceHistoryBootstrap();
    setAgentTraceHistoryPanelState(null);
    setAgentTraceTarget(null);
  }, [cancelAgentTraceHistoryBootstrap, setAgentTraceHistoryPanelState, setAgentTraceTarget]);

  const { targetKey: agentTraceHistoryTargetKey, loadOlder: loadOlderAgentTrace } = useAgentTraceHistorySync({
    target: s.agentTraceTarget,
    token: s.token,
    revision: s.agentTraceHistoryBootstrapRevision,
    cancel: cancelAgentTraceHistoryBootstrap,
    syncRef: s.agentTraceHistoryBootstrapRef,
    setReplicas: s.setAgentTraceReplicas,
    setPanelState: setAgentTraceHistoryPanelState,
  });

  const daemonLocalMentionContext = useMemo(
    () => localMentionContextFromDaemon(s.machineDaemons, s.desktopContext),
    [s.desktopContext, s.machineDaemons]
  );

  const localMentionContext = daemonLocalMentionContext;

  const localWorkspaces = useMemo(
    () => localWorkspacesForDesktop(s.projects, s.desktopContext),
    [s.desktopContext, s.projects]
  );

  const registrationCatalog = useAgentRegistrationCatalog(s.currentSpaceId ?? "", s.token ?? "",
    Boolean(s.currentSpaceId && s.token));
  const localManagedAgents = useMemo(
    () => buildLocalManagedAgents(registrationCatalog.data?.registrations ?? [], s.desktopContext),
    [s.desktopContext, registrationCatalog.data]
  );

  const [localMachineName, setLocalMachineName] = useState<string | null>();
  const readLocalMachineName = useCallback(async (machineId: string): Promise<string | null> => {
    if (!s.token) throw new Error("Sign in to name this machine.");
    const result = await xmatrixApiRequest<{ machineId: string; name: string | null }>({
      url: WEB_PROXY_ROUTES.machine_name(machineId), token: s.token,
    });
    if (result.machineId !== machineId) throw new Error("Could not verify this machine's name.");
    return result.name;
  }, [s.token]);
  useEffect(() => {
    setLocalMachineName(undefined);
    if (!s.token || !s.desktopContext?.machineId) return;
    let cancelled = false;
    void readLocalMachineName(s.desktopContext.machineId).then(name => {
      if (!cancelled) setLocalMachineName(name);
    }).catch(error => {
      if (!cancelled) setLocalActionError(errorMessage(error, "Could not read this machine's name."));
    });
    return () => { cancelled = true; };
  }, [s.token, s.desktopContext?.machineId, readLocalMachineName, setLocalActionError]);

  async function nameLocalMachine(name: string) {
    if (!s.token || !s.desktopContext?.machineId || s.localActionBusy) return;
    const machineId = s.desktopContext.machineId;
    setLocalActionBusy("machine:name");
    setLocalActionError(null);
    try {
      const result = await xmatrixApiRequest<{ machineId: string; name: string }>({
        url: WEB_PROXY_ROUTES.machine_name(machineId), token: s.token, method: "POST", body: { name: name.trim() },
      });
      if (result.machineId !== machineId || !result.name) throw new Error("Could not confirm this machine's name.");
      setLocalMachineName(result.name);
      const status = await s.desktopBridge?.startDaemon?.();
      if (status) setDesktopDaemonStatus(status);
    } catch (error) {
      setLocalActionError(errorMessage(error, "Could not name this machine."));
    } finally { setLocalActionBusy(null); }
  }

  const localSetupReady =
    Boolean(s.user) &&
    Boolean(localMachineName) &&
    s.desktopDaemonStatus?.state === "running" &&
    localWorkspaces.length > 0 &&
    localManagedAgents.length > 0;

  const machines = useMemo(
    () => buildMachineSummaries(s.machineDaemons, s.projects, s.desktopContext),
    [s.desktopContext, s.machineDaemons, s.projects]
  );

  const refreshLocalDesktopState = useCallback(async () => {
    if (!s.desktopBridge) return;
    const setup = await s.desktopBridge.getSetupStatus?.().catch(() => null);
    if (setup) setDesktopSetupStatus(setup);
  }, [s.desktopBridge, setDesktopSetupStatus]);

  const refreshAgentPresetDiscoveries = useCallback(async () => {
    if (!s.desktopBridge?.discoverAgentPresets) return;
    setLoadingAgentPresetDiscoveries(true);
    setLocalActionError(null);
    try {
      const discoveries = await s.desktopBridge.discoverAgentPresets(AGENT_PRESETS);
      setAgentPresetDiscoveries(discoveries);
    } catch (err) {
      setLocalActionError(errorMessage(err, "Could not discover local agents."));
    } finally {
      setLoadingAgentPresetDiscoveries(false);
    }
  }, [s.desktopBridge, setLocalActionError, setAgentPresetDiscoveries, setLoadingAgentPresetDiscoveries]);

  useEffect(() => {
    if (!s.desktopBridge?.discoverAgentPresets) {
      setAgentPresetDiscoveries([]);
      return;
    }
    void refreshAgentPresetDiscoveries();
  }, [s.desktopBridge, refreshAgentPresetDiscoveries, setAgentPresetDiscoveries]);

  const totalChannelUnreadCount = useMemo(
    () =>
      s.channels.reduce(
        (total, channel) =>
          total + channelUnreadCount(channel, s.channelReadCounts, s.channelReadCountsBaselineReady),
        0
      ),
    [s.channelReadCounts, s.channelReadCountsBaselineReady, s.channels]
  );

  const totalChannelMentionCount = useMemo(
    () =>
      s.channels.reduce(
        (total, channel) => total + (channel.attention?.unreadAttentionCount || 0),
        0
      ),
    [s.channels]
  );

  useEffect(() => {
    if (!s.desktopBridge) return;

    const viewTitle = s.view === "messages" && s.selectedChannel
      ? `#${channelTitle(s.selectedChannel)}`
      : viewLabels[s.view];
    const title = `${viewTitle} - xMatrix`;
    void s.desktopBridge.setTitle(title);
    document.title = title;
  }, [s.desktopBridge, s.selectedChannel, s.view]);

  useEffect(() => {
    if (!s.desktopBridge) return;
    void s.desktopBridge.setBadge({
      mentionCount: totalChannelMentionCount,
      hasUnread: totalChannelUnreadCount > 0,
    });
  }, [s.desktopBridge, totalChannelMentionCount, totalChannelUnreadCount]);

  useEffect(() => {
    if (!s.desktopBridge?.onNotificationReply) return;

    const unsubscribe = s.desktopBridge.onNotificationReply(({ channelId, body }) => {
      const currentToken = s.accessTokenRef.current;
      const text = body;
      if (!currentToken || !channelId || !text.trim()) return;

      void fetch(WEB_PROXY_ROUTES.channel_messages(channelId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${currentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: text }),
        cache: "no-store",
      })
        .then(async (res) => {
          if (!res.ok) return;
          const payload = (await res.json().catch(() => ({}))) as { message?: unknown };
          if (!isValidChannelMessage(payload.message)) return;
          mergeAndRememberChannelHistory(channelId, [payload.message]);
          markChannelReadToSequence(channelId, payload.message.sequence);
        })
        .catch(() => undefined);
    });

    return unsubscribe;
  }, [s.desktopBridge, fetch, markChannelReadToSequence, mergeAndRememberChannelHistory, s.accessTokenRef]);

  useEffect(() => {
    if (!s.desktopBridge) return;

    const knownIds = s.knownDesktopEventIdsRef.current;
    const nextIds = new Set(s.events.map((event) => event.id));
    const newEvents = s.events.filter((event) => !knownIds.has(event.id));
    s.knownDesktopEventIdsRef.current = nextIds;

    if (knownIds.size === 0 || newEvents.length === 0) return;
    if (!document.hidden && document.hasFocus()) return;

    const visibleEvents = newEvents.filter(
      (event) =>
        isNativeNotificationEvent(event) &&
        !nativeNotificationEventMessageIdWasHandled(event, s.nativeNotifiedMessageIdsRef.current) &&
        (event.type === "channel_mention" || event.channelId !== s.selectedChannelId)
    );
    if (visibleEvents.length === 0) return;

    const latest = visibleEvents[visibleEvents.length - 1];
    const latestChannel = latest.channelId
      ? s.channels.find((item) => item.id === latest.channelId)
      : undefined;
    markNativeMessageNotified(nativeNotificationEventMessageId(latest));
    void s.desktopBridge.notify({
      title: latest.agentName || "xMatrix activity",
      subtitle: latestChannel ? `#${channelTitle(latestChannel)}` : undefined,
      body: eventLabel(latest),
      url: notificationPathForEvent(latest, s.channels, s.spaces, s.routeSpaceId),
      channelId: latest.channelId,
    });
  }, [s.channels, s.desktopBridge, s.events, s.routeSpaceId, s.selectedChannelId, s.spaces, s.knownDesktopEventIdsRef, markNativeMessageNotified, s.nativeNotifiedMessageIdsRef]);

  useEffect(() => {
    const desktopBridge = s.desktopBridge;
    if (
      !desktopBridge?.saveCliSession ||
      !desktopBridge.startDaemon ||
      !s.token ||
      !daemonStatusNeedsSessionSync(s.desktopDaemonStatus)
    ) {
      return;
    }

    if (s.desktopCliSessionSyncTokenRef.current === s.token) {
      return;
    }
    s.desktopCliSessionSyncTokenRef.current = s.token;

    let cancelled = false;
    void exchangeDesktopCliSession(s.token)
      .then((cliSession) => desktopBridge.saveCliSession?.(cliSession))
      .then(async () => {
        const context = await desktopBridge.getContext();
        if (cancelled) return undefined;
        setDesktopContext(context);
        if (!context.machineId) throw new Error("Update xMatrix to finish setting up this machine.");
        const name = await readLocalMachineName(context.machineId);
        if (cancelled) return undefined;
        setLocalMachineName(name);
        if (!name) {
          setDesktopDaemonStatus({ state: "stopped", message: "Name this machine to continue setup.", updatedAt: new Date().toISOString() });
          return undefined;
        }
        return desktopBridge.startDaemon?.();
      })
      .then((status) => {
        if (!cancelled && status) setDesktopDaemonStatus(status);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setDesktopDaemonStatus({
          state: "error",
          message: errorMessage(nextError, "Could not refresh the local daemon session."),
          updatedAt: new Date().toISOString(),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [s.desktopBridge, s.desktopDaemonStatus, s.token, setDesktopContext, s.desktopCliSessionSyncTokenRef, setDesktopDaemonStatus, readLocalMachineName]);

  useEffect(() => {
    if (!s.desktopBridge) return;

    let cancelled = false;
    function refreshDesktopContext() {
      void s.desktopBridge?.getContext().then((context) => {
        if (!cancelled) setDesktopContext(context);
      }).catch(() => undefined);
    }

    refreshDesktopContext();
    void refreshLocalDesktopState();

    void s.desktopBridge.getUpdateStatus?.().then((status) => {
      if (!cancelled) setDesktopUpdateStatus(status);
    }).catch(() => undefined);

    void s.desktopBridge.getDaemonStatus?.().then((status) => {
      if (!cancelled) setDesktopDaemonStatus(status);
    }).catch(() => undefined);

    const unsubscribeUpdate = s.desktopBridge.onUpdateStatus?.((status) => {
      setDesktopUpdateStatus(status);
    }) || (() => undefined);

    const unsubscribeDaemon = s.desktopBridge.onDaemonStatus?.((status) => {
      setDesktopDaemonStatus(status);
      if (status.state === "running") {
        refreshDesktopContext();
      }
    }) || (() => undefined);

    return () => {
      cancelled = true;
      unsubscribeUpdate();
      unsubscribeDaemon();
    };
  }, [s.desktopBridge, refreshLocalDesktopState, setDesktopDaemonStatus, setDesktopContext, setDesktopUpdateStatus]);

  async function checkDesktopUpdates() {
    if (!s.desktopBridge || s.checkingDesktopUpdates) return;

    setCheckingDesktopUpdates(true);
    try {
      const status = await s.desktopBridge.checkForUpdates();
      if (status) setDesktopUpdateStatus(status);
    } finally {
      setCheckingDesktopUpdates(false);
    }
  }

  async function installDesktopUpdate() {
    if (!s.desktopBridge?.installUpdate) return;

    setDesktopUpdateStatus((current) => optimisticDesktopUpdateInstallStatus(current));
    try {
      const status = await s.desktopBridge.installUpdate();
      setDesktopUpdateStatus(status);
    } catch (error) {
      setDesktopUpdateStatus((current) => desktopUpdateErrorStatus(current, error));
    }
  }

  async function startDesktopDaemon() {
    if (!s.desktopBridge?.startDaemon) return;
    if (!localMachineName) { setLocalActionError("Name this machine before starting the daemon."); return; }

    const status = await s.desktopBridge.startDaemon();
    setDesktopDaemonStatus(status);
  }

  /**
   * Installs the CLI from the App's bundled seed. Shells without a seed (or
   * older shells without this bridge method) fall back to the docs page.
   */
  async function installDesktopCli() {
    if (!s.desktopBridge) return;
    if (!s.desktopBridge.installCli) {
      await s.desktopBridge.openCliInstall();
      return;
    }
    setDesktopDaemonStatus({
      state: "starting",
      message: "Installing the xMatrix CLI from this App...",
      updatedAt: new Date().toISOString(),
    });
    const result = await s.desktopBridge.installCli();
    if (!result.ok) {
      if (result.reason === "no-seed") {
        await s.desktopBridge.openCliInstall();
      }
      setDesktopDaemonStatus({
        state: "missing",
        message: result.message,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    // The daemon-status subscription refreshes the desktop context once the
    // adopted daemon reports running.
    const status = await s.desktopBridge.getDaemonStatus?.();
    if (status) setDesktopDaemonStatus(status);
  }

  async function stopDesktopDaemon() {
    if (!s.desktopBridge?.stopDaemon) return;

    const status = await s.desktopBridge.stopDaemon();
    setDesktopDaemonStatus(status);
  }

  async function restartDesktopDaemon() {
    if (!s.desktopBridge?.restartDaemon) return;
    if (!localMachineName) { setLocalActionError("Name this machine before starting the daemon."); return; }

    const status = await s.desktopBridge.restartDaemon();
    setDesktopDaemonStatus(status);
  }

  async function addLocalWorkspace() {
    if (!s.token) {
      setLocalActionError("Sign in before adding a local directory.");
      return;
    }
    if (!s.desktopBridge?.chooseWorkspaceDirectory) {
      setLocalActionError("Update the desktop app to add local directories from this screen.");
      return;
    }
    setLocalActionBusy("workspace:add");
    setLocalActionError(null);
    try {
      const candidate = await s.desktopBridge.chooseWorkspaceDirectory();
      if (!candidate) return;
      const workspace = await registerWorkspace(s.token, candidate);
      setProjects((current) => sortProjects(replaceWorkspace(current, workspace)));
    } catch (err) {
      setLocalActionError(errorMessage(err, "Could not add local directory."));
    } finally {
      setLocalActionBusy(null);
    }
  }

  async function importDiscoveredWorkspace(candidate: DesktopWorkspaceCandidate) {
    if (!s.token || s.localActionBusy) return;
    setLocalActionBusy(`workspace:import:${candidate.canonicalCwd}`);
    setLocalActionError(null);
    try {
      const workspace = await registerWorkspace(s.token, candidate);
      setProjects((current) => sortProjects(replaceWorkspace(current, workspace)));
    } catch (err) {
      setLocalActionError(errorMessage(err, "Could not import workspace."));
    } finally {
      setLocalActionBusy(null);
    }
  }

  async function importDiscoveredAgent(discovery: DesktopAgentPresetDiscovery) {
    if (!s.token || s.localActionBusy) return;
    const preset = agentPresetOrCustom(discovery.presetId);
    const form: AgentConfigForm = {
      ...emptyAgentConfigForm(),
      spaceId: s.currentSpaceId || "",
      presetId: preset.id,
      name: defaultAgentName(preset),
      runtime: preset.runtime || discovery.runtime,
      argsText: preset.defaultArgs.join("\n"),
    };
    setAgentConfigForm(form);
    setAgentConfigDialog({ source: "local-discovery" });
    setLocalActionError(null);
  }

  async function removeLocalWorkspace(workspace: SerializedWorkspace) {
    if (!s.token || s.localActionBusy) return;
    if (!window.confirm(`Remove local directory ${workspace.displayName}?`)) return;

    const key = workspaceKey(workspace);
    setLocalActionBusy(`workspace:remove:${key}`);
    setLocalActionError(null);
    try {
      await deleteWorkspace(s.token, workspace);
      setProjects((current) => current.filter((item) => workspaceKey(item) !== key));
    } catch (err) {
      setLocalActionError(errorMessage(err, "Could not remove local directory."));
    } finally {
      setLocalActionBusy(null);
    }
  }

  async function revealLocalWorkspace(workspace: SerializedWorkspace) {
    if (!s.desktopBridge?.revealPath) return;
    setLocalActionError(null);
    const ok = await s.desktopBridge.revealPath(workspace.canonicalCwd);
    if (!ok) setLocalActionError("Could not reveal the local directory path on this machine.");
  }

  async function checkLocalRuntime(runtime: string) {
    if (!s.desktopBridge?.checkRuntime || s.localActionBusy) return;
    setLocalActionBusy(`runtime:${runtime}`);
    setLocalActionError(null);
    try {
      setRuntimeCheck(await s.desktopBridge.checkRuntime(runtime));
    } finally {
      setLocalActionBusy(null);
    }
  }

  async function completeDesktopSetup() {
    if (!s.desktopBridge?.saveSetupStatus || !localSetupReady) return;
    setLocalActionBusy("setup:complete");
    setLocalActionError(null);
    try {
      const status = await s.desktopBridge.saveSetupStatus({
        setupVersion: DESKTOP_SETUP_VERSION,
        completedAt: new Date().toISOString(),
      });
      setDesktopSetupStatus(status);
    } catch (err) {
      setLocalActionError(errorMessage(err, "Could not save setup status."));
    } finally {
      setLocalActionBusy(null);
    }
  }

  const {
    toggleAutomation,
    updateAutomation,
    deleteAutomation,
  } = useWorkspaceAutomationActions({
    token: s.token,
    currentSpaceId: s.currentSpaceId,
    automations: s.automations,
    busy: s.automationBusy,
    setAutomations: s.setAutomations,
    setBusy: s.setAutomationBusy,
    setError: s.setAutomationError,
  });

  function openLocalAgentDiscovery() {
    setView("local");
    const nextPath = appViewPath(s.selectedChannel, "local", s.currentSpaceId, s.spaces);
    pushBrowserPath(nextPath);
    setBrowserPath(nextPath);
    void refreshAgentPresetDiscoveries();
  }

  /** `item` opens one item of a destination's list, as its address names it (`?item=`). */
  function changeAppView(nextView: AppView, item?: string) {
    setView(nextView);
    if (nextView !== "messages") {
      setSelectedChannelId(null);
      setMobileChannelDetailsOpen(false);
      setReplyTarget(null);
    }
    const viewPath = appViewPath(nextView === "messages" ? s.selectedChannel : null, nextView, s.currentSpaceId, s.spaces);
    const nextPath = toolItemPath(viewPath, item ?? null);
    const pathState = s.view === "more" && MORE_TAB_VIEWS.includes(nextView)
      ? { [MOBILE_MORE_RETURN_PATH_STATE_KEY]: appViewPath(null, "more", s.currentSpaceId, s.spaces) }
      : undefined;
    pushBrowserPath(nextPath, pathState);
    setBrowserPath(nextPath);
  }

  /** `userId` omitted means the viewer's own profile — the rail avatar's case. */
  function openHumanProfile(userId?: string, spaceId?: string) {
    setProfileUserId(userId && userId !== s.user?.id ? userId : null);
    if (!spaceId || spaceId === s.currentSpaceId) {
      changeAppView("profile");
      return;
    }
    // The profile reads the current Space's roster, so a member of another
    // Space has to land there before the view opens.
    setPendingExplicitSpaceId(spaceId);
    setWorkingSpaceId(spaceId);
    setView("profile");
    setSelectedChannelId(null);
    setMobileChannelDetailsOpen(false);
    setReplyTarget(null);
    const nextPath = appViewPath(null, "profile", spaceId, s.spaces);
    const pathState = s.view === "more"
      ? { [MOBILE_MORE_RETURN_PATH_STATE_KEY]: appViewPath(null, "more", spaceId, s.spaces) }
      : undefined;
    pushBrowserPath(nextPath, pathState);
    setBrowserPath(nextPath);
  }

  /** Schedules, opened at one Automation with its editor. */
  function openSchedule(automationId: string) {
    setScheduleFocusId(automationId);
    changeAppView("automation", automationId);
  }

  const clearScheduleFocus = useCallback(() => setScheduleFocusId(null), [setScheduleFocusId]);

  function openAppsForSpace(spaceId: string) {
    setPendingExplicitSpaceId(spaceId);
    setWorkingSpaceId(spaceId);
    setSelectedChannelId(null);
    setMobileChannelDetailsOpen(false);
    setReplyTarget(null);
    setView("apps");
    const nextPath = appViewPath(null, "apps", spaceId, s.spaces);
    pushBrowserPath(nextPath);
    setBrowserPath(nextPath);
  }

  function backToMore() {
    const nextPath = appViewPath(null, "more", s.currentSpaceId, s.spaces);
    setView("more");
    setSelectedChannelId(null);
    setMobileChannelDetailsOpen(false);
    setReplyTarget(null);

    if (window.history.state?.[MOBILE_MORE_RETURN_PATH_STATE_KEY] === nextPath) {
      window.history.back();
    } else {
      replaceBrowserPath(nextPath);
    }
    setBrowserPath(nextPath);
  }

  function selectSpace(spaceId: string) {
    /* Switching workspace lands on its channels, not a summary page, with
       none of them opened for the reader: they pick one from the list. */
    setPendingExplicitSpaceId(spaceId);
    setWorkingSpaceId(spaceId);
    setView("messages");
    setSelectedChannelId(null);
    const nextPath = `${spaceAppPath(spaceId, s.spaces)}/channels`;
    pushBrowserPath(nextPath);
    setBrowserPath(nextPath);
    setBrowserHash("");
  }

  const {
    openMobileChannelDetails,
    closeMobileChannelDetails,
    backToChannelList,
  } = createMobileChannelHistoryNavigation({
    mobileChannelDetailsOpen: s.mobileChannelDetailsOpen,
    setMobileChannelDetailsOpen,
    selectedChannel: s.selectedChannel,
    selectedChannelIdRef: s.selectedChannelIdRef,
    currentSpaceId: s.currentSpaceId,
    spaces: s.spaces,
    setSelectedChannelId,
    setReplyTarget,
    setBrowserPath,
    setBrowserHash,
    runMobileScreenTransition,
  });

  function navigateToChannel(channelId: string, messageId?: string, sequence?: number) {
    const channelInState = s.channels.find((current) => current.id === channelId);
    const channel = channelInState || s.channelsRef.current.find((current) => current.id === channelId);
    if (!channel) return;
    setComposingConversation(false);
    if (!messageId && pointerActivationAlreadyHandled(channelId)) return;
    if (s.viewRef.current === "messages") {
      sendHumanChannelFocus({
        channelId,
        socket: s.relaySocketRef.current,
        connected: s.relayPushConnectedRef.current,
        selectedChannelIdRef: s.selectedChannelIdRef,
        historyChannelIdRef: s.historyChannelIdRef,
        lastHumanFocusRequestRef: s.lastHumanFocusRequestRef,
      });
    }
    const navigationSpaces = channelInState ? s.spaces : s.spacesRef.current;

    const nextPath = `${channelAppPath(channel, navigationSpaces)}${messageId ? `#message:${messageId}` : ""}`;
    const currentPath = currentBrowserLocation();
    const currentRoute = appRouteInfo(currentPath);
    const mobileChannelListReturnPath =
      currentRoute.view === "messages" &&
      !currentRoute.channelKey &&
      !currentRoute.legacyChannelId
        ? currentPath
        : null;
    const commitNavigation = () => {
      const hasImmediateHistory = Boolean(
        s.mobileListFixture?.history[channelId] || s.historyCacheRef.current.has(channelId)
      );
      setView("messages");
      setMobileChannelDetailsOpen(false);
      setPendingExplicitSpaceId(channel.spaceId);
      setWorkingSpaceId(channel.spaceId);
      setHistoryError(null);
      setLoadingHistory(!hasImmediateHistory);
      setSelectedChannelId(channelId);
      s.viewRef.current = "messages";
      s.selectedChannelIdRef.current = channelId;
      setChannelQuickOpen(false);
      setWorkspaceSearchOpen(false);
      if (!messageId && !s.isMobileViewportRef.current) {
        setComposerAutoFocusRequest((current) => current + 1);
      }
      // No eager mark-read here: the timeline reports rendered rows through
      // handleTimelineMessageExposed once the navigation lands, so the cursor
      // only clears for messages the user actually got on screen.
      pushBrowserPath(nextPath, {
        [MOBILE_CHANNEL_LIST_RETURN_PATH_STATE_KEY]: mobileChannelListReturnPath,
      });
      setBrowserPath(nextPath);
    };
    if (s.selectedChannelIdRef.current !== channelId) {
      runMobileScreenTransition("forward", commitNavigation);
    } else {
      commitNavigation();
    }
    if (messageId) {
      // Arm a distinct jump intent every time — including when the channel is
      // already open. Clearing browserHash after the first landing would
      // otherwise make a second follow-up click a no-op.
      queueMessageJump(channelId, messageId, sequence);
    } else {
      s.pendingMessageJumpRef.current = null;
      setBrowserHash("");
    }
  }

  const copyChannelLink = useCallback(async (channel: SerializedChannel): Promise<void> => {
    await copyTextToClipboard(absoluteChannelUrl(channel, s.spacesRef.current));
  }, [s.spacesRef]);

  const { openPage, closePage, internalPageLink, startPageConversation, openPageConversation,
    closePageConversation } = pageShellActions({
    token: s.token, user: s.user, view: s.view, selectedPageId: s.selectedPageId, selectedChannelId: s.selectedChannelId, currentSpaceId: s.currentSpaceId, spaces: s.spaces, setView,
    setSelectedPageId: s.setSelectedPageId, setSelectedChannelId, setChannels, setBrowserPath,
    focusComposer: () => setComposerAutoFocusRequest((current) => current + 1),
    seedDraft: (conversationId, text) => writeChannelComposerDraft(s.channelComposerDraftsRef.current, conversationId,
      { text, workspaceTarget: null, attachments: [] }),
  });

  /**
   * A conversation started from a passage of a message (selection-discussion.ts).
   * It opens holding the quote and a link back to the message, is as open as
   * the conversation it came from, and is linked to the same pages, so it
   * inherits their context as that conversation does.
   */
  async function discussMessagePassage(message: TimelineItem, quote: string) {
    const sourceId = message.channelId ?? s.selectedChannelIdRef.current;
    const source = s.channelsRef.current.find((channel) => channel.id === sourceId);
    const token = s.token;
    if (!token || !s.user || !source || !message.messageId) return;
    try {
      const channel = await createConversation({ token: token, spaceId: source.spaceId,
        memberName: s.user.name || s.user.email || "Human", name: discussionTitle(quote), mode: source.mode,
        metadata: { fromChannelId: source.id, fromMessageId: message.messageId } });
      const { links } = await pageApi.links(source.spaceId, token, { conversationId: source.id });
      const places = new Map(links.filter((link) => !link.resolvedAt)
        .map((link) => [`${link.pageId}\u0000${link.blockId}`, link] as const));
      await Promise.all([...places.values()].map((link) => pageApi.link(source.spaceId, token, {
        conversationId: channel.id, pageId: link.pageId, ...(link.blockId ? { blockId: link.blockId } : {}) })));
      const href = `${absoluteChannelUrl(source, s.spacesRef.current)}#message:${encodeURIComponent(message.messageId)}`;
      writeChannelComposerDraft(s.channelComposerDraftsRef.current, channel.id, {
        text: discussionDraft(quote, { label: `${message.author} in #${channelTitle(source)}`, href }),
        workspaceTarget: null, attachments: [] });
      setChannels((current) => replaceChannel(current, channel));
      s.channelsRef.current = replaceChannel(s.channelsRef.current, channel);
      // Beside a page it opens beside the page, as a discussion of the page does.
      if (s.viewRef.current === "pages" && s.selectedPageId) openPageConversation(channel.id, { focus: true });
      else navigateToChannel(channel.id);
    } catch (err) {
      setHistoryError(errorMessage(err, "Could not start the conversation."));
    }
  }

  const handleTimelineDiscussPassage = useStableCallback((message: TimelineItem, quote: string) => {
    void discussMessagePassage(message, quote);
  });

  function openInternalAppLink(href: string): boolean {
    const pageLink = internalPageLink(href, window.location.href);
    if (pageLink) {
      openPage(pageLink);
      return true;
    }
    const internalLink = parseInternalChannelLink(href, window.location.href);
    if (internalLink) {
      void openInternalChannelLink(internalLink);
      return true;
    }
    return false;
  }

  async function openInternalChannelLink(link: {
    spaceKey: string | null;
    channelKey: string;
    messageId?: string;
  }): Promise<void> {
    const currentSpaces = s.spacesRef.current;
    const currentChannels = s.channelsRef.current;
    const currentSpaceId = resolveSpaceRouteKey(currentSpaces, link.spaceKey);
    const currentChannel = resolveChannelRouteKey(currentChannels, link.channelKey, currentSpaceId);
    if (currentChannel) {
      setHistoryError(null);
      navigateToChannel(currentChannel.id, link.messageId);
      return;
    }

    if (!s.token) {
      setHistoryError("Sign in to open this channel link.");
      return;
    }

    try {
      const [nextChannels, nextSpaces] = await Promise.all([
        fetchChannels(s.token),
        fetchSpaces(s.token),
      ]);
      const nextSpaceId = resolveSpaceRouteKey(nextSpaces, link.spaceKey);
      const nextChannel = resolveChannelRouteKey(nextChannels, link.channelKey, nextSpaceId);
      if (!nextChannel) {
        setHistoryError("This channel does not exist or you do not have access to it.");
        return;
      }

      setChannels(nextChannels);
      s.spacesRef.current = nextSpaces;
      setSpaces(s.spacesRef.current);
      s.channelsRef.current = nextChannels;
      setHistoryError(null);
      navigateToChannel(nextChannel.id, link.messageId);
    } catch (error) {
      setHistoryError(errorMessage(error, "Could not open this channel link."));
    }
  }

  /**
   * Sends one request through the Web proxy as the signed-in Human and reads
   * its JSON answer, which `complete` must accept. Fails with the Hub's error,
   * or with `failure` when it gives none.
   */
  async function requestHub<T extends object>(
    url: string,
    request: { method: "POST" | "PATCH" | "DELETE"; body?: unknown },
    failure: string,
    complete: (payload: T) => boolean = () => true,
  ): Promise<T> {
    const res = await fetch(url, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${s.token}`,
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      cache: "no-store",
    });
    const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok || !complete(payload)) {
      throw new Error(payload.error || failure);
    }
    return payload;
  }

  /** Sends one Space change; the Hub answers with the Space as it now stands. */
  async function requestSpaceChange(
    url: string,
    request: { method: "POST" | "PATCH" | "DELETE"; body?: unknown },
    failure: string,
  ): Promise<SerializedSpace> {
    const { space } = await requestHub<{ space?: SerializedSpace }>(
      url, request, failure, (payload) => Boolean(payload.space),
    );
    return space!;
  }

  async function updateSpacePreferredLanguage(spaceId: string, language: "zh" | "en" | "") {
    if (!s.token) throw new Error("Sign in before updating the space");
    const space = s.spaces.find((item) => item.id === spaceId);
    if (!space) throw new Error("Space not found");
    const metadata = { ...space.metadata };
    if (language) {
      metadata.locale = {
        defaultLocale: language === "zh" ? "zh-CN" : "en",
        supportedLocales: ["zh-CN", "en"],
      };
      // Keep the earlier key during the read-side migration.
      metadata.preferredLanguage = language;
    } else {
      delete metadata.locale;
      delete metadata.preferredLanguage;
    }
    const updated = await requestSpaceChange(WEB_PROXY_ROUTES.space(spaceId), {
      method: "PATCH",
      body: { metadata },
    }, "Could not update the space language");
    setSpaces((current) => replaceSpace(current, updated));
  }

  async function updateSpaceMemberPermissions(
    spaceId: string,
    patch: Partial<SpaceMemberPermissions>,
  ): Promise<void> {
    if (!s.token) throw new Error("Sign in before updating Space member permissions");
    const space = await requestSpaceChange(WEB_PROXY_ROUTES.space_member_permissions(spaceId), {
      method: "PATCH",
      body: patch,
    }, "Could not update Space member permissions");
    setSpaces((current) => replaceSpace(current, space));
  }

  async function renameSpace(spaceId: string, name: string) {
    if (!s.token || s.renamingSpaceId) return;

    const nextName = name.trim();
    if (!nextName) {
      setSpacesError("Workspace name cannot be empty");
      return;
    }

    setRenamingSpaceId(spaceId);
    setSpacesError(null);
    try {
      const space = await requestSpaceChange(WEB_PROXY_ROUTES.space(spaceId), {
        method: "PATCH",
        body: { name: nextName },
      }, "Failed to rename workspace");
      setSpaces((current) => replaceSpace(current, space));
      if (s.currentSpaceId === space.id) {
        const nextPath = appViewPath(s.selectedChannel, s.view, space.id, replaceSpace(s.spaces, space));
        pushBrowserPath(nextPath);
        setBrowserPath(nextPath);
      }
    } catch (err) {
      setSpacesError((err as Error).message);
    } finally {
      setRenamingSpaceId(null);
    }
  }

  /* Deletion only schedules the purge; the owner can restore the Space until
     the returned time, from the Team view's list of deleted Spaces. */
  async function deleteSpace(spaceId: string): Promise<{ purgeAfter: string }> {
    if (!s.token) throw new Error("Sign in before deleting a Space");
    const { deletion } = await requestHub<{ deletion?: { purgeAfter?: unknown } }>(
      WEB_PROXY_ROUTES.space(spaceId),
      { method: "DELETE" },
      "Could not delete the Space",
      (payload) => typeof payload.deletion?.purgeAfter === "string",
    );
    const purgeAfter = deletion!.purgeAfter as string;
    const remaining = s.spaces.filter((space) => space.id !== spaceId);
    setSpaces(remaining);
    if (s.currentSpaceId === spaceId) {
      const next = remaining[0] || null;
      const nextPath = appViewPath(null, s.view, next?.id ?? null, remaining);
      pushBrowserPath(nextPath);
      setBrowserPath(nextPath);
    }
    return { purgeAfter };
  }

  async function restoreSpace(spaceId: string): Promise<void> {
    if (!s.token) throw new Error("Sign in before restoring a Space");
    const res = await fetch(WEB_PROXY_ROUTES.space_restore(spaceId), {
      method: "POST",
      headers: { Authorization: `Bearer ${s.token}` },
      cache: "no-store",
    });
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(payload.error || "Could not restore the Space");
    await refreshWorkspace();
  }

  async function refreshWorkspace() {
    if (s.mobileListFixture) {
      setChannels(s.mobileListFixture.channels);
      setSpaces(s.mobileListFixture.spaces);
      setChannelReadCounts(s.mobileListFixture.readCounts);
      setChannelReadCountsBaselineReady(true);
      setLoadingWorkspace(false);
      setError(null);
      setSpacesError(null);
      return;
    }
    if (!s.token) return;
    setLoadingWorkspace(true);
    try {
      const [nextChannels, nextEvents, nextSpaces, nextProjects] = await Promise.all([
        fetchChannels(s.token),
        fetchEvents(s.token, EVENT_LIMIT),
        fetchSpaces(s.token),
        fetchProjects(s.token),
      ]);
      reconcileAgentTraceChannelAccess(nextChannels);
      setChannels(nextChannels);
      setSpaces(nextSpaces);
      setProjects(nextProjects);
      setEvents(nextEvents.filter((event) => !isLlmTraceEvent(event)));
      setError(null);
      setSpacesError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingWorkspace(false);
    }
  }

  /** + or Ctrl/⌘+N: an empty conversation whose first message creates it. */
  function openNewConversation() {
    setComposingConversation(true);
    setView("messages");
  }

  async function createNewConversation(body: string, mode: "open" | "closed") {
    if (!s.token || !s.user || !s.currentSpaceId) throw new Error("Choose a Space first");
    return createConversation({ token: s.token, spaceId: s.currentSpaceId,
      memberName: s.user.name || s.user.email || "Human", body, mode });
  }

  /* The conversation opens as soon as it exists and its first message shows
     there as pending, as any send does; the shell's own send reads the
     selected conversation from React state, which has not settled in the tick
     after a create, so the message is delivered to the created channel. */
  async function sendNewConversationMessage(channel: SerializedChannel, snapshot: ComposerSendSnapshot) {
    if (!s.token) throw new Error("Sign in again to send");
    setChannels((current) => replaceChannel(current, channel));
    setComposingConversation(false);
    setPendingExplicitSpaceId(channel.spaceId);
    setWorkingSpaceId(channel.spaceId);
    setSelectedChannelId(channel.id);
    setView("messages");
    const nextPath = channelAppPath(channel, s.spaces);
    pushBrowserPath(nextPath);
    setBrowserPath(nextPath);
    await deliverOutgoingMessage(channel, {
      body: snapshot.body,
      attachments: snapshot.attachments,
      invocationSelections: snapshot.invocationSelections,
      appMentions: parseAppMentions(snapshot.body, APP_CONNECTORS),
    });
  }


  async function updateChannelVisibility(
    channel: SerializedChannel,
    mode: ChannelCreateMode
  ) {
    if (!s.token || s.updatingChannelVisibilityId || channel.mode === mode) return;
    if (
      mode === "closed" &&
      !window.confirm(
        `Make #${channelTitle(channel)} private? Space members without explicit channel access will lose access immediately.`
      )
    ) {
      return;
    }

    setUpdatingChannelVisibilityId(channel.id);
    try {
      const res = await fetch(WEB_PROXY_ROUTES.channel(channel.id), {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${s.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mode }),
        cache: "no-store",
      });
      const payload = (await res.json().catch(() => ({}))) as {
        channel?: SerializedChannel;
        message?: unknown;
      };
      if (!res.ok) {
        if (isValidChannelMessage(payload.message)) {
          mergeAndRememberChannelHistory(channel.id, [payload.message]);
          if (s.selectedChannelIdRef.current === channel.id) {
            queueChannelTimelineScroll(channel.id);
          }
          markChannelReadToSequence(channel.id, payload.message.sequence);
        }
        return;
      }
      if (!payload.channel) return;

      setChannels((current) => replaceChannel(current, payload.channel!));
    } catch (err) {
      console.warn("Failed to update channel visibility before Hub could record the result", {
        channelId: channel.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUpdatingChannelVisibilityId(null);
    }
  }

  function openChannelMove(channel: SerializedChannel) {
    setChannelMoveTargetSpaceId(channel.spaceId || s.currentSpaceId || "");
    setChannelMoveError(null);
    setChannelMoveOpen(true);
  }

  async function moveChannel(channel: SerializedChannel) {
    if (!s.token || s.movingChannelId) return;
    const targetSpaceId = s.channelMoveTargetSpaceId.trim();
    if (!targetSpaceId) {
      setChannelMoveError("Select a target workspace");
      return;
    }

    if (targetSpaceId === channel.spaceId) {
      setChannelMoveOpen(false);
      return;
    }
    setMovingChannelId(channel.id);
    setChannelMoveError(null);
    try {
      const response = await fetch(WEB_PROXY_ROUTES.channel_transfer_proposals(channel.id), {
        method: "POST", headers: { Authorization: `Bearer ${s.token}`, "content-type": "application/json" },
        body: JSON.stringify({ spaceId: targetSpaceId }),
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Failed to create transfer proposal");
      await queryClient.invalidateQueries({ queryKey: ["channel-transfers"] });
      setChannelMoveOpen(false);
    } catch (err) {
      setChannelMoveError((err as Error).message);
    } finally {
      setMovingChannelId(null);
    }
  }

  async function createSpace(nameOverride?: string, options?: { select?: boolean }) {
    if (!s.token || s.creatingSpace) return;
    const name = (nameOverride ?? s.newSpaceName).trim();
    if (!name) {
      setSpacesError("Workspace name is required");
      return;
    }

    setCreatingSpace(true);
    setSpacesError(null);
    try {
      const res = await fetch(WEB_PROXY_ROUTES.spaces, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${s.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name }),
        cache: "no-store",
      });
      await requireResponseOk(res, "Failed to create workspace");

      const payload = (await res.json()) as { space?: SerializedSpace };
      if (payload.space) {
        setSpaces((current) => replaceSpace(current, payload.space!));
        if (options?.select) {
          const nextSpaces = replaceSpace(s.spaces, payload.space);
          setPendingExplicitSpaceId(payload.space.id);
          setWorkingSpaceId(payload.space.id);
          setView("messages");
          setSelectedChannelId(null);
                const nextPath = `${spaceAppPath(payload.space.id, nextSpaces)}/channels`;
          pushBrowserPath(nextPath);
          setBrowserPath(nextPath);
          setBrowserHash("");
        }
      }
      if (!nameOverride) setNewSpaceName("");
      return payload.space;
    } catch (err) {
      setSpacesError((err as Error).message);
    } finally {
      setCreatingSpace(false);
    }
  }

  const createSpaceInviteCode = (spaceId: string, options: SpaceInviteCodeOptions) =>
    createSpaceInviteCodeRequest({ token: s.token, userId: s.user?.id, spaces: s.spaces, spaceId, options });

  async function inviteSpaceMembers(
    spaceId: string,
    emails: string[]
  ): Promise<SpaceInviteResult> {
    if (!s.token) throw new Error("Sign in before inviting members");
    if (!s.user) throw new Error("Sign in before inviting members");
    const space = s.spaces.find((item) => item.id === spaceId);
    if (!space || !canInviteToSpace(space, s.user.id)) {
      throw new Error("Only workspace owners and admins can invite members");
    }
    return requestHub<SpaceInviteResult>(WEB_PROXY_ROUTES.space_invite_emails(spaceId), {
      method: "POST",
      body: {
        emails,
        role: "member",
        workspaceName: space?.name,
      },
    }, "Failed to send invite");
  }

  /** A Space member the signed-in Human may manage; the owner never is, for the `ownerRefusal` reason. */
  function administeredMember(spaceId: string, memberUserId: string, ownerRefusal: string) {
    if (!s.token) throw new Error("Sign in before managing members");
    if (!s.user) throw new Error("Sign in before managing members");
    const space = s.spaces.find((item) => item.id === spaceId);
    if (!space || !canInviteToSpace(space, s.user.id)) {
      throw new Error("Only workspace owners and admins can manage members");
    }
    const member = space.members.find((item) => item.userId === memberUserId);
    if (!member) throw new Error("Member not found");
    if (member.role === "owner") throw new Error(ownerRefusal);
    return member;
  }

  async function updateSpaceMemberRole(
    spaceId: string,
    memberUserId: string,
    role: SpaceInviteRole
  ): Promise<SpaceMemberActionResult> {
    const member = administeredMember(spaceId, memberUserId, "The owner role cannot be changed");
    const updated = await requestSpaceChange(WEB_PROXY_ROUTES.space_members(spaceId), {
      method: "POST",
      body: {
        userId: member.userId,
        email: member.email,
        name: member.name,
        avatarUrl: member.avatarUrl,
        role,
      },
    }, "Failed to update member");
    setSpaces((current) => replaceSpace(current, updated));
    return { space: updated };
  }

  async function removeSpaceMember(
    spaceId: string,
    memberUserId: string
  ): Promise<SpaceMemberActionResult> {
    administeredMember(spaceId, memberUserId, "The owner cannot be removed");
    const updated = await requestSpaceChange(WEB_PROXY_ROUTES.space_member(spaceId, memberUserId), {
      method: "DELETE",
    }, "Failed to remove member");
    setSpaces((current) => replaceSpace(current, updated));
    return { space: updated };
  }

  const reconcileUnconfirmedSend = createUnconfirmedSendReconciler({
    delaysMs: [1_500, 4_000, 10_000],
    probeDeadlineMs: 10_000,
    currentToken: () => s.accessTokenRef.current ?? s.token ?? null,
    isStillOutstanding: (id) =>
      s.outgoingMessagesRef.current.some((item) => item.clientMessageId === id),
    fetchPage: (probeToken, channelId, signal) =>
      fetchChannelHistory(probeToken, channelId, { limit: 30, signal }),
    commitCommitted: (committed: ChannelMessage, channelId) =>
      commitReconciledOutgoing({
        committed,
        outgoing: s.outgoingMessagesRef.current,
        claim: (entry, outgoing) =>
          claimOutgoingClientIdForEntry(
            entry,
            outgoing as OutgoingMessage[],
            s.outboundClientIdsByMessageIdRef.current,
            s.outboundPreviewByClientIdRef.current,
          ),
        merge: (entry) => mergeAndRememberChannelHistory(channelId, [entry]),
        remove: (claimed) =>
          setOutgoingMessages((current) =>
            current.filter((item) => item.clientMessageId !== claimed)
          ),
      }),
  });

  s.reconcileUnconfirmedOnReconnectRef.current = () => {
    for (const { outgoing } of reconnectableUnconfirmedSends(
      s.outgoingMessagesRef.current,
      s.channelsRef.current,
    )) {
      void reconcileUnconfirmedSend(outgoing.channelId, outgoing.clientMessageId);
    }
  };

  async function refreshSelectedHistory() {
    if (!s.selectedChannel || !s.token) return;
    const channelId = s.selectedChannel.id;
    // A history refresh replaces or supplements the current data window; it
    // is not a navigation or a newly sent message. Requesting a tail landing
    // here races the refreshed rows and pulls a reader away from the message
    // they were reading on both the desktop and mobile surfaces.
    if (s.historyRef.current.length === 0) setLoadingHistory(true);
    try {
      const onlinePage = await fetchChannelHistory(s.token, channelId, {
        limit: INITIAL_HISTORY_LIMIT,
      });
      if (s.selectedChannelIdRef.current !== channelId) return;
      applyChannelHistory(
        channelId,
        onlinePage.messages,
        onlinePage.hasMore,
      );
      recordHistoryTailBase(channelId);
      if (s.user?.id) authorizeHistoryRender({ userId: s.user.id, channelId, historyRevision: s.historyRevision });
      setHistoryError(null);
    } catch (err) {
      if (s.historyRef.current.length === 0) setHistoryError((err as Error).message);
    } finally {
      setLoadingHistory(false);
    }
  }

  async function seekHistoryForMessageJump(
    channelId: string,
    messageId: string,
    sequence: number,
    requestId: number,
  ) {
    if (
      !s.token ||
      !s.selectedChannel ||
      s.selectedChannel.id !== channelId ||
      s.messageJumpSeekInFlightRef.current === requestId
    ) {
      return;
    }
    const pendingJump = s.pendingMessageJumpRef.current;
    if (
      !pendingJump ||
      pendingJump.requestId !== requestId ||
      pendingJump.channelId !== channelId ||
      pendingJump.messageId !== messageId
    ) {
      return;
    }

    s.messageJumpSeekInFlightRef.current = requestId;
    const readStillCurrent = (): boolean =>
      s.selectedChannelIdRef.current === channelId &&
      s.pendingMessageJumpRef.current?.requestId === requestId;

    try {
      // beforeSequence is exclusive: S+1 returns a page that can include S.
      const seekPage = await fetchChannelHistory(s.token, channelId, {
        limit: OLDER_HISTORY_LIMIT,
        beforeSequence: sequence + 1,
      });
      const seekMessages = seekPage.messages;
      const nextHasOlderMessages = seekPage.hasMore;
      if (!readStillCurrent()) return;
      if (seekMessages.length === 0) {
        // Seek found nothing; fall back to ordinary older pagination on the
        // next layout pass when hasOlderMessages is still true.
        return;
      }

      mergeAndRememberChannelHistory(
        channelId,
        seekMessages,
        // Preserve any already-known older flag when merging into a live tail.
        s.hasOlderMessagesRef.current || nextHasOlderMessages,
      );
      setHistoryError(null);
      // Force the jump layout effect to re-run after the seek page lands.
      bumpMessageJumpRevision();
    } catch {
      // Leave the jump armed; the layout effect may still page older or wait.
    } finally {
      if (s.messageJumpSeekInFlightRef.current === requestId) {
        s.messageJumpSeekInFlightRef.current = 0;
      }
      // One seek attempt per jump request — empty or failed seeks fall back to
      // older pagination / abandon instead of looping forever.
      if (s.pendingMessageJumpRef.current?.requestId === requestId) {
        s.messageJumpSeekAttemptedRef.current = requestId;
      }
    }
  }

  async function loadOlderMessages() {
    if (
      !s.token ||
      !s.selectedChannel ||
      s.history.length === 0 ||
      s.olderLoading ||
      olderHistoryLoadInFlightRef.current ||
      !s.hasOlderMessages
    ) return;

    const beforeSequence = earliestPositiveSequence(s.history);
    if (beforeSequence === undefined) return;
    olderHistoryLoadInFlightRef.current = true;
    setOlderLoading(true);
    try {
      const olderPage = await fetchChannelHistory(s.token, s.selectedChannel.id, {
        limit: OLDER_HISTORY_LIMIT,
        beforeSequence,
      });
      if (s.selectedChannelIdRef.current !== s.selectedChannel.id) return;
      mergeAndRememberChannelHistory(
        s.selectedChannel.id,
        olderPage.messages,
        olderPage.hasMore,
      );
      setHistoryError(null);
    } catch (err) {
      setHistoryError((err as Error).message);
    } finally {
      olderHistoryLoadInFlightRef.current = false;
      setOlderLoading(false);
    }
  }

  function stopAgentInstance(
    agentId: string,
    instance: SerializedAgentInstance,
    agentLabel?: string
  ) {
    if (!s.token || s.stoppingAgentInstanceId || s.reborningAgentInstanceId || s.handingOffAgentInstanceId) return;
    const liveAgent = s.agents.find((candidate) => candidate.id === agentId);
    const body = agentInstanceStopBody(liveAgent, instance, agentLabel);
    if (!body) {
      const message = "This instance has no channel address to stop.";
      setAgentsError(message);
      setHistoryError(message);
      return;
    }
    setAgentInstanceStopRequest({
      instance,
      body,
      target: liveAgent
        ? agentTraceTargetFromAgentInstance(liveAgent, instance)
        : agentTraceTargetFromInstance(agentId, instance),
    });
  }

  /** Posts one lifecycle mention while `setBusy` marks that Instance busy. */
  async function sendLifecycleMention(
    body: string,
    instanceId: string,
    setBusy: (instanceId: string | null) => void,
  ) {
    setBusy(instanceId);
    setAgentsError(null);
    setHistoryError(null);
    try {
      await sendChannelMessage({ body });
    } catch (err) {
      const message = (err as Error).message;
      setAgentsError(message);
      setHistoryError(message);
    } finally {
      setBusy(null);
    }
  }

  function lifecycleControlBlocked(): boolean {
    return !s.token || !s.selectedChannel || !s.canUseSelectedChannel ||
      Boolean(s.reborningAgentInstanceId || s.stoppingAgentInstanceId || s.handingOffAgentInstanceId);
  }

  /** The Agent name a lifecycle mention addresses, without a leading @. */
  function lifecycleMentionName(agentId: string, agentLabel: string): string {
    const agent = s.agents.find((candidate) => candidate.id === agentId);
    return (agent?.name || agentLabel).trim().replace(/^[@＠]/, "");
  }

  async function rebornAgentInstance(agentId: string, instance: SerializedAgentInstance, agentLabel: string) {
    if (lifecycleControlBlocked()) return;

    const channelInstanceId = instance.channelInstanceId?.trim();
    if (!channelInstanceId || !/^[1-9]\d*$/.test(channelInstanceId)) {
      const message = "This instance has no channel instance number to reborn.";
      setAgentsError(message);
      setHistoryError(message);
      return;
    }

    const mentionName = lifecycleMentionName(agentId, agentLabel);
    if (!mentionName || mentionName.toLowerCase() === "xmatrix") {
      const message = "This agent cannot be reborn from the work controls.";
      setAgentsError(message);
      setHistoryError(message);
      return;
    }

    await sendLifecycleMention(`@${mentionName}:${channelInstanceId}:reborn`, instance.id,
      setReborningAgentInstanceId);
  }

  /** Posts the same `@<name>:<n>:handoff:@<successor>` mention a person would type. */
  async function handoffAgentInstance(
    agentId: string,
    instance: SerializedAgentInstance,
    agentLabel: string,
    successor: string,
  ) {
    if (lifecycleControlBlocked()) return;

    const channelInstanceId = instance.channelInstanceId?.trim();
    const mentionName = lifecycleMentionName(agentId, agentLabel);
    const successorName = successor.trim().replace(/^[@＠]/, "");
    const body = channelInstanceId && /^[1-9]\d*$/.test(channelInstanceId) && mentionName && successorName
      ? `@${mentionName}:${channelInstanceId}:handoff:@${successorName}`
      : "";
    if (!body || mentionName.toLowerCase() === "xmatrix" || !parseHandoffInstanceTarget(body.slice(1))) {
      const message = "This instance cannot be handed off from the work controls.";
      setAgentsError(message);
      setHistoryError(message);
      return;
    }

    await sendLifecycleMention(body, instance.id, s.setHandingOffAgentInstanceId);
  }

  async function rebornMessageSender(message: TimelineItem) {
    if (!s.token || !s.selectedChannel || !s.canUseSelectedChannel) return;
    if (s.reborningAgentInstanceId || s.stoppingAgentInstanceId) return;

    const rebornBody = rebornBodyForMessageSender(message);
    if (!rebornBody) {
      const error = "This message sender cannot be reborn.";
      setAgentsError(error);
      setHistoryError(error);
      return;
    }

    const busyKey = message.senderInstanceId || message.senderMention || message.messageId || message.author;
    setReborningAgentInstanceId(busyKey);
    setAgentsError(null);
    setHistoryError(null);
    try {
      await sendChannelMessage({ body: rebornBody });
    } catch (err) {
      const error = (err as Error).message;
      setAgentsError(error);
      setHistoryError(error);
    } finally {
      setReborningAgentInstanceId(null);
    }
  }

  function openAgentCreate() {
    if (!s.user || !spaceMemberCanCreate(s.currentSpace, s.user.id, "agentCreation")) {
      setAgentsError(
        s.currentSpace
          ? `Only owners and admins can add Agents to ${s.currentSpace.name}.`
          : "Choose a Space before adding an agent.",
      );
      return;
    }
    const preset = agentPresetOrCustom("codex");
    setAgentConfigDialog({});
    setAgentConfigForm({
      ...emptyAgentConfigForm(),
      spaceId: s.currentSpaceId || "",
      name: defaultAgentName(preset),
    });
    setAgentsError(null);
  }

  /** A registration is edited from the Space's Agents list. */
  function openLocalManagedAgentEdit() {
    changeAppView("agents");
  }

  async function renameChannel(channelId: string, name: string) {
    if (!s.token || s.renamingChannelId) return;

    const nextName = name.trim().replace(/^#+/, "").trim();
    if (!nextName) {
      setHistoryError("Channel name is required");
      return;
    }

    setRenamingChannelId(channelId);
    setHistoryError(null);
    try {
      const { channel } = await requestHub<{ channel?: SerializedChannel }>(
        WEB_PROXY_ROUTES.channel(channelId),
        { method: "PATCH", body: { name: nextName } },
        "Failed to rename channel",
        (payload) => Boolean(payload.channel),
      ) as { channel: SerializedChannel };
      setChannels((current) => replaceChannel(current, channel));
      if (s.selectedChannelIdRef.current === channel.id) {
        const nextPath = channelAppPath(channel, s.spaces);
        pushBrowserPath(nextPath);
        setBrowserPath(nextPath);
      }
    } catch (err) {
      setHistoryError((err as Error).message);
    } finally {
      setRenamingChannelId(null);
    }
  }

  /** New agent: the owner adds a harness on this machine to the Space as a
   * registration, declared, granted and enabled in one command. */
  async function saveAgentConfig() {
    if (!s.agentConfigDialog || s.savingAgentConfig) return;
    const name = s.agentConfigForm.name.trim();
    const preset = agentPresetOrCustom(s.agentConfigForm.presetId);
    const runtime = s.agentConfigForm.runtime.trim() || preset.runtime;
    const targetSpace = s.spaces.find((space) => space.id === s.agentConfigForm.spaceId);
    if (!name) {
      setAgentsError("Name the agent");
      return;
    }
    if (!runtime) {
      setAgentsError("Choose how this agent runs");
      return;
    }
    if (!targetSpace || !s.user || !spaceMemberCanCreate(targetSpace, s.user.id, "agentCreation")) {
      setAgentsError("Only Space owners and admins can add Agents to this Space.");
      return;
    }
    const machineId = s.desktopContext?.machineId;
    if (!s.token || !machineId) {
      setAgentsError("Add an agent from the xMatrix desktop app on the machine it runs on.");
      return;
    }
    setSavingAgentConfig(true);
    setAgentsError(null);
    try {
      const routing = s.agentConfigForm.routing;
      await xmatrixApiRequest({
        url: WEB_PROXY_ROUTES.space_agent_registration_command(targetSpace.id), token: s.token, method: "POST",
        body: {
          action: "create",
          commandId: `registration-create:${crypto.randomUUID()}`,
          key: { spaceId: targetSpace.id, ownerUserId: s.user.id, machineId, harness: canonicalRegistrationHarness(preset.id === "custom" ? runtime : preset.id) },
          displayName: name,
          environment: {
            schemaVersion: 1,
            enabled: true,
            models: routing?.models ?? [],
            description: routing?.description ?? "",
            availability: routing?.availability ?? "unknown",
            capabilities: routing?.capabilities ?? [],
            launch: {
              runtime: agentLaunchExecutable(runtime),
              runtimeArgs: parseConfigList(s.agentConfigForm.argsText),
              ...(preset.backend ? { backend: preset.backend } : {}),
            },
          },
          ...(routing?.defaultWorkspace ? { defaultWorkspace: routing.defaultWorkspace } : {}),
        },
      });
      await registrationCatalog.refetch();
      setAgentConfigDialog(null);
    } catch (err) {
      setAgentsError(errorMessage(err, "Could not add the agent to this Space."));
    } finally {
      setSavingAgentConfig(false);
    }
  }

  /** Disable a registration in this Space: its running work here stops. */
  async function deleteAgent(agent: LocalManagedAgent) {
    if (!s.token || s.deletingAgentId || !s.currentSpaceId) return;
    if (!window.confirm(`Disable ${agent.name}? Its running work here stops.`)) return;
    setDeletingAgentId(agent.id);
    setAgentsError(null);
    try {
      const current = await xmatrixApiRequest<AgentRegistrationDetails>({
        url: WEB_PROXY_ROUTES.space_agent_registration_query(s.currentSpaceId), token: s.token, method: "POST",
        body: agent.registration.key });
      await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.space_agent_registration_command(s.currentSpaceId), token: s.token,
        method: "POST", body: { ...registrationSpaceCommand(agent.registration.key, current, { kind: "space-disable" }),
          commandId: `registration-ui:${crypto.randomUUID()}` } });
      await registrationCatalog.refetch();
    } catch (err) {
      setAgentsError(errorMessage(err, "Could not disable the agent."));
    } finally {
      setDeletingAgentId(null);
    }
  }

  async function confirmStopAgentInstance() {
    if (!s.token || !s.agentInstanceStopRequest || s.stoppingAgentInstanceId) return;

    const { body, instance } = s.agentInstanceStopRequest;
    setAgentInstanceStopRequest(null);
    await sendLifecycleMention(body, instance.id, s.setStoppingAgentInstanceId);
  }

  function insertMentionIntoComposer(mention: string) {
    const normalized = mention.trim().replace(/^[@＠]/, "");
    if (!normalized) return;
    setMentionInsertRequest((current) => ({
      id: (current?.id || 0) + 1,
      kind: "mention",
      mention: normalized,
    }));
  }

  async function sendChannelMessage(
    summon?: { body?: string },
    composerSnapshot?: ComposerSendSnapshot
  ) {
    if (!s.token || !s.selectedChannel || !s.canUseSelectedChannel) {
      return;
    }

    // Snapshot and clear composer immediately so the input never waits on the network
    // and a second Enter before re-render cannot double-send the same draft.
    const fromComposer = !summon?.body;
    // The Composer render that enabled Send owns the authoritative attachment
    // snapshot. In particular, mobile can tap Send immediately after an XHR
    // upload reports Ready, before the shell's ref-backed draft catches up.
    const body = summon?.body ?? composerSnapshot?.body ?? s.draftRef.current;
    const attachments = fromComposer
      ? (composerSnapshot?.attachments ?? s.draftAttachmentsRef.current)
      : [];
    const replySnapshot = fromComposer && s.historyRenderAuthorized &&
      s.replyTargetHistoryRevisionRef.current === s.historyRevision
      ? s.replyTargetRef.current
      : null;
    if (!body.trim() && attachments.length === 0) {
      return;
    }

    const invocationSelections = fromComposer ? composerSnapshot?.invocationSelections : undefined;
    const appMentions = parseAppMentions(body, APP_CONNECTORS);
    const replyToMessageId = replySnapshot?.messageId;
    const replyTo = replySnapshot?.messageId
      ? {
          messageId: replySnapshot.messageId,
          author: replySnapshot.author,
          body: replySnapshot.body,
          ...replyPreviewSequence(replySnapshot.sequence),
        }
      : undefined;
    const channel = s.selectedChannel;
    const channelId = channel.id;
    if (fromComposer) {
      clearChannelComposerDraft(s.channelComposerDraftsRef.current, channelId);
      s.draftWorkspaceTargetValueRef.current = null;
      s.draftAttachmentsRef.current = [];
      s.replyTargetRef.current = null;
      s.replyTargetHistoryRevisionRef.current = -1;
      seedComposerDraftText("");
      setDraftWorkspaceTarget(null);
      setDraftAttachments([]);
      setReplyTarget(null);
    }
    await deliverOutgoingMessage(channel, {
      body, invocationSelections, attachments, replyToMessageId, replyTo, appMentions,
    });
  }

  /** Shows the message as pending in its channel at once, then appends it. */
  async function deliverOutgoingMessage(
    channel: SerializedChannel,
    { body, invocationSelections, attachments, replyToMessageId, replyTo, appMentions }:
      Pick<OutgoingMessage, "body" | "invocationSelections" | "attachments" | "replyToMessageId" | "replyTo" | "appMentions">,
  ) {
    if (!s.token) return;
    const channelId = channel.id;
    const clientMessageId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `out-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const sentAt = new Date().toISOString();
    setHistoryError(null);
    queueChannelTimelineScroll(channelId);

    const outgoing: OutgoingMessage = {
      clientMessageId,
      channelId,
      body,
      invocationSelections,
      attachments,
      replyToMessageId,
      replyTo,
      appMentions,
      sentAt,
      status: "pending",
    };
    s.outboundPreviewByClientIdRef.current.set(clientMessageId, {
      sentAt,
      attachments,
    });
    setOutgoingMessages((current) => [...current, outgoing]);

    try {
      const payload = await appendChannelMessageWithAttachments({
        token: s.token,
        channel,
        clientMessageId,
        body,
        invocationSelections,
        attachments,
        replyToMessageId,
        appMentions,
      });
      if (isValidChannelMessage(payload.message)) {
        // Stamp clientMessageId before dropping the pending row so the confirmed
        // timeline item reuses the same React key and does not remount/flicker.
        s.outboundClientIdsByMessageIdRef.current.set(payload.message.messageId, clientMessageId);
        s.outboundPreviewByClientIdRef.current.set(clientMessageId, {
          sentAt,
          attachments,
        });
        mergeAndRememberChannelHistory(channelId, [payload.message]);
        markChannelReadToSequence(channelId, payload.message.sequence);
        // Advance the live watermark on the channel row without relying on the
        // WS echo. This must not restart the history-loading effect (deps omit
        // historyHeadSequence); channelsRef is the read source for coversKnownHead.
        if (payload.message.sequence) {
          const confirmedSequence = payload.message.sequence;
          setChannels((current) =>
            current.map((channel) =>
              channel.id === channelId
                ? {
                    ...channel,
                    messageCount: Math.max(channel.messageCount || 0, confirmedSequence),
                    historyHeadSequence: Math.max(
                      channel.historyHeadSequence || 0,
                      confirmedSequence,
                    ),
                  }
                : channel
            )
          );
        }
      } else if (payload.message) {
        void refreshSelectedHistory();
      }
      setOutgoingMessages((current) =>
        current.filter((message) => message.clientMessageId !== clientMessageId)
      );
      if (payload.channel) {
        setChannels((current) => replaceChannel(current, payload.channel!));
      }
      if (payload.appConnectorResultChannels?.length) {
        setChannels((current) =>
          payload.appConnectorResultChannels!.reduce(
            (nextChannels, resultChannel) => replaceChannel(nextChannels, resultChannel),
            current
          )
        );
        const targetThread =
          payload.appConnectorResultChannels.find((resultChannel) => isThreadChannel(resultChannel)) ||
          payload.appConnectorResultChannels[0];
        if (targetThread) {
          const nextPath = channelAppPath(targetThread, s.spaces);
          setView("messages");
          setSelectedChannelId(targetThread.id);
          pushBrowserPath(nextPath);
          setBrowserPath(nextPath);
        }
      }
    } catch (err) {
      // A deadline says the result is unknown, not that the write failed: the
      // POST may have committed. Only a determinate error is a failure, and an
      // unknown result is carried by the row rather than the channel banner.
      const unknownResult = isMessageSendDeadlineError(err);
      const message = unknownResult ? "Result unconfirmed" : (err as Error).message;
      setOutgoingMessages((current) =>
        current.map((item) =>
          item.clientMessageId === clientMessageId
            ? { ...item, status: unknownResult ? "unconfirmed" : "failed", error: message }
            : item
        )
      );
      if (unknownResult) {
        void reconcileUnconfirmedSend(channelId, clientMessageId);
      } else {
        setHistoryError(message);
      }
    }
  }

  async function sendQuestionnaireAnswer(message: TimelineItem, answer: string) {
    if (!s.token || !message.channelId || !message.messageId || !answer.trim()) return;

    queueChannelTimelineScroll(message.channelId);
    setHistoryError(null);
    try {
      const res = await fetch(WEB_PROXY_ROUTES.channel_messages(message.channelId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${s.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          body: answer.trim(),
          replyToMessageId: message.messageId,
          metadata: {
            kind: "xmatrix.questionnaire_answer.v1",
            questionnaireMessageId: message.messageId,
          },
        }),
        cache: "no-store",
      });
      await requireResponseOk(res, "Failed to send answer");
      const payload = (await res.json()) as { message?: unknown; channel?: SerializedChannel };
      if (isValidChannelMessage(payload.message)) {
        mergeAndRememberChannelHistory(message.channelId, [payload.message]);
        if (s.selectedChannelIdRef.current === message.channelId) {
          queueChannelTimelineScroll(message.channelId);
        }
        markChannelReadToSequence(message.channelId, payload.message.sequence);
      } else if (payload.message) {
        void refreshSelectedHistory();
      }
      if (payload.channel) {
        setChannels((current) => replaceChannel(current, payload.channel!));
      }
    } catch (err) {
      setHistoryError((err as Error).message);
    }
  }

  async function resolveChannelById(
    spaceId: string,
    channelId: string,
    // The Thread can be absent from the paged client catalog. Resolve it from
    // Catalog authority rather than the legacy single-Channel route, while
    // keeping the lookup inside the thread-open deadline.
    signal?: AbortSignal,
  ): Promise<SerializedChannel | null> {
    if (!s.token) return null;
    const result = await fetchChannelCatalogResolve({
      token: s.token,
      spaceId,
      channelIds: [channelId],
      ...(signal ? { signal } : {}),
    });
    return result.channels.find((channel) => channel.id === channelId) ?? null;
  }

  /** The thread a message already has; conversations are no longer started from a message. */
  async function findMessageThreadChannel(
    parentChannel: SerializedChannel | null,
    message: TimelineItem
  ): Promise<SerializedChannel | null> {
    if (!s.token || !parentChannel || !message.messageId) return null;
    const known = message.threadChannel ??
      threadChannelForMessage(s.channels, parentChannel.id, message.messageId);
    if (known || !message.threadChannelId) return known ?? null;
    const resolved = await resolveChannelById(parentChannel.spaceId, message.threadChannelId);
    if (resolved) setChannels((current) => replaceChannel(current, resolved));
    return resolved;
  }

  async function openMessageThreadInChannel(parentChannel: SerializedChannel | null, message: TimelineItem) {
    try {
      const threadChannel = await findMessageThreadChannel(parentChannel, message);
      if (!threadChannel) return;
      const nextPath = channelAppPath(threadChannel, s.spaces);
      setView("messages");
      setSelectedChannelId(threadChannel.id);
      pushBrowserPath(nextPath);
      setBrowserPath(nextPath);
    } catch (err) {
      setHistoryError((err as Error).message);
    }
  }

  /**
   * Applies one change to a sent message and merges the Hub's updated copy
   * into the channel's history; `onMergedMessages` sees the result only while
   * that channel is still selected.
   */
  async function changeMessageInChannel(
    channel: SerializedChannel | null,
    message: TimelineItem,
    change: (accessToken: string, channelId: string, messageId: string) => Promise<ChannelMessage>,
    onMergedMessages?: (messages: ChannelMessage[]) => void
  ) {
    if (!s.token || !channel || !message.messageId || message.isEvent) return;

    try {
      const updatedMessage = await change(s.token, channel.id, message.messageId);
      const mergedMessages = mergeAndRememberChannelHistory(channel.id, [updatedMessage]);
      if (s.selectedChannelIdRef.current === channel.id) {
        onMergedMessages?.(mergedMessages);
      }
      setHistoryError(null);
    } catch (err) {
      setHistoryError((err as Error).message);
    }
  }

  async function toggleMessageReactionInChannel(
    channel: SerializedChannel | null,
    message: TimelineItem,
    emoji: string,
    onMergedMessages?: (messages: ChannelMessage[]) => void
  ) {
    await changeMessageInChannel(
      channel,
      message,
      (accessToken, channelId, messageId) => reactToChannelMessage(accessToken, channelId, messageId, emoji),
      onMergedMessages,
    );
  }

  async function openMessageThread(message: TimelineItem) {
    await openMessageThreadInChannel(s.selectedChannel, message);
  }

  async function toggleMessageReaction(message: TimelineItem, emoji: string) {
    await toggleMessageReactionInChannel(s.selectedChannel, message, emoji);
  }

  async function editMessageInChannel(
    channel: SerializedChannel | null,
    message: TimelineItem,
    body: string,
    onMergedMessages?: (messages: ChannelMessage[]) => void
  ) {
    await changeMessageInChannel(
      channel,
      message,
      (accessToken, channelId, messageId) => updateChannelMessage(accessToken, channelId, messageId, body),
      onMergedMessages,
    );
  }

  async function editMessage(message: TimelineItem, body: string) {
    await editMessageInChannel(s.selectedChannel, message, body);
  }

  async function recallMessageInChannel(
    channel: SerializedChannel | null,
    message: TimelineItem,
    onMergedMessages?: (messages: ChannelMessage[]) => void
  ) {
    await changeMessageInChannel(channel, message, recallChannelMessage, onMergedMessages);
  }

  async function recallMessage(message: TimelineItem) {
    await recallMessageInChannel(s.selectedChannel, message);
  }

  const desktopPlatform = s.desktopContext?.platform || s.desktopBridge?.platform;
  const isMacDesktop = desktopPlatform === "darwin";
  // The window frame the page draws into: macOS insets its traffic lights,
  // Windows overlays its caption buttons; each needs drag regions and a safe
  // corner kept clear of them.
  // Native full screen hides the traffic lights, so the rail drops their band.
  const desktopFullScreen = useDesktopFullScreen(s.desktopBridge);
  const desktopFrameClass = isMacDesktop
    ? desktopFullScreen ? "xmatrix-desktop-macos xmatrix-desktop-fullscreen" : "xmatrix-desktop-macos"
    : desktopPlatform === "win32"
      ? "xmatrix-desktop-windows"
      : undefined;

  return {
    ...s,
    handleTimelineScrollPositionChange,
    handleTimelineScrollGesture,
    handleTimelineNearTop,
    handleTimelineReact,
    handleTimelineEdit,
    handleTimelineRecall,
    handleTimelineReply,
    handleTimelineJumpToMessage,
    handleTimelineOpenThread,
    handleTimelineDiscussPassage,
    desktopFrameClass,
    handleTimelineMentionSender,
    handleTimelineRebornSender,
    handleTimelineQuestionnaireAnswer,
    handleTimelineOpenInternalAppLink,
    timeline,
    selectedThreadRootContext,
    openAgentTrace,
    closeAgentTrace,
    agentTraceHistoryTargetKey,
    loadOlderAgentTrace,
    localMentionContext,
    localWorkspaces,
    localManagedAgents,
    localSetupReady,
    localMachineName,
    nameLocalMachine,
    machines,
    refreshAgentPresetDiscoveries,
    checkDesktopUpdates,
    installDesktopUpdate,
    startDesktopDaemon,
    installDesktopCli,
    stopDesktopDaemon,
    restartDesktopDaemon,
    addLocalWorkspace,
    importDiscoveredWorkspace,
    importDiscoveredAgent,
    removeLocalWorkspace,
    revealLocalWorkspace,
    checkLocalRuntime,
    completeDesktopSetup,
    toggleAutomation,
    updateAutomation,
    deleteAutomation,
    openLocalAgentDiscovery,
    changeAppView,
    openHumanProfile,
    profileUserId,
    openSchedule,
    clearScheduleFocus,
    openAppsForSpace,
    backToMore,
    selectSpace,
    openMobileChannelDetails,
    closeMobileChannelDetails,
    backToChannelList,
    navigateToChannel,
    copyChannelLink,
    startPageConversation,
    openPage,
    closePage,
    openPageConversation,
    closePageConversation,
    updateSpaceMemberPermissions,
    updateSpacePreferredLanguage,
    renameSpace,
    deleteSpace,
    restoreSpace,
    openNewConversation,
    createNewConversation,
    sendNewConversationMessage,
    updateChannelVisibility,
    openChannelMove,
    moveChannel,
    createSpace,
    createSpaceInviteCode,
    inviteSpaceMembers,
    updateSpaceMemberRole,
    removeSpaceMember,
    stopAgentInstance,
    rebornAgentInstance,
    handoffAgentInstance,
    openAgentCreate,
    openLocalManagedAgentEdit,
    renameChannel,
    saveAgentConfig,
    deleteAgent,
    confirmStopAgentInstance,
    sendChannelMessage,
  };
}
export type WorkspaceShellModel = ReturnType<typeof useWorkspaceShellActions>;
