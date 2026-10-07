"use client";
import { useMachineDaemonLoad } from "./use-machine-daemon-load";

import type { ComposerInvocationDraft } from "./composer-invocation-bindings";

import { ChannelHistoryPreload } from "./channel-history-preload";
import { useStartupBackgroundReady } from "./use-startup-background-ready";

import type {
  DesktopAgentPresetDiscovery,
  DesktopBridge,
  DesktopContext,
  DesktopDaemonStatus,
  DesktopRuntimeCheckResult,
  DesktopSetupStatus,
  DesktopUpdateStatus,
} from "@/lib/desktop/bridge";
import {
  CHANNEL_ROW_INTENT_DWELL_MS,
  INITIAL_HISTORY_LIMIT,
  TIMELINE_BOTTOM_STICK_MS,
} from "./workspace-shell-constants";
import { sendHumanChannelFocus } from "./send-human-channel-focus";
import { useChannelHistoryWarmup } from "./use-channel-history-warmup";
import {
  bindHumanSocketHeartbeat,
  createHumanSocketSuspensionTracker,
  listenForHumanSocketResume,
  shouldResumeHumanSocketNow,
} from "./human-socket-heartbeat";
import { listenForForegroundRefresh } from "./foreground-refresh";
import {
  channelLastMessagePreviewFromEntry,
} from "./workspace-shell-formatters";
import { assembleWorkspaceSearchMessages } from "./workspace-shell-search-model";
import { useMessageJump } from "./use-message-jump";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { AUTH_TOKEN_REJECTED_EVENT, useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { applyChannelReadStateToCatalog } from "./channel-catalog-read-state";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { admittedHumanSocketUrl, handleHumanSocketCompatibilityClose } from "@/lib/app-client-compatibility";
import { applyMemberReadEvent } from "./mention-read-state";
import {
  filterHistoryForChannel,
  mergeChannelHistory,
  sameChannelHistoryWindow,
  sortChannelHistory,
} from "@/components/dashboard/channel-history";
import {
  readChannelComposerDraft,
  writeChannelComposerDraft,
  type ChannelComposerDraft,
} from "@/components/dashboard/channel-composer-drafts";
import {
  purgeAgentTraceReplicas,
  purgeThirdPartyAgentTraceReplicas,
  type AgentTraceReplica,
} from "@/components/dashboard/agent-trace-replica";
import {
  type AgentTraceHistorySync,
} from "@/components/dashboard/agent-trace-on-demand";
import {
  exactChannelIdFromRouteKey,
  channelAppPath,
  resolveChannelRouteKey,
  resolveSpaceRouteKey,
  spaceAppPath,
} from "@/components/dashboard/channel-links";
import { searchWorkspaceMessages } from "./workspace-message-search";
import { useWorkspaceShellTailCache } from "./use-workspace-shell-tail-cache";
import { removeRetiredBrowserReplica } from "@/lib/retired-browser-replica";
import { maybePushRecipientScopedNativeMessageNotification } from "./recipient-scoped-native-message-notification";
import { useHumanFocusHistoryHttpFallback } from "./use-human-focus-history-http-fallback";
import { invalidateWorkspaceResources, refetchUnlessHumanPush, setHumanPushConnected, type WorkspaceResourceChange } from "./workspace-resource-push";
import { useSelectedChannelHeadCatchUp } from "./use-selected-channel-head-catch-up";
import { clearProductMessageAttachmentMediaCache } from "@/lib/relay-v2/product-message-attachment-media";
import { channelActivityOf, DEFAULT_HUB_URL, HUMAN_AUTH_INVALID_FAILURE_CODE, HUMAN_AUTH_REQUIRED_CLOSE_CODE, HUMAN_CLIENT_PRESENCE_DIGEST, normalizeHubUrl, parseHumanChannelCatalogChangedMessage, parseHumanWorkspaceResourceChangedMessage } from "@xmatrix/protocol";
import type {
  ChannelAttachment,
  ChannelMessage,
  ObservabilityEvent,
  SerializedAgent,
  SerializedChannel,
  SerializedMachineDaemon,
  SerializedAutomation,
  SerializedSpace,
  SerializedWorkspace,
  HumanServerMessage,
} from "@xmatrix/protocol";

import {
  AgentConfigDialogState,
  AgentConfigForm,
  AgentInstanceStopRequest,
  AgentTraceHistoryPanelState,
  AgentTraceTarget,
  AppView,
  ChannelHistoryCacheEntry,
  ComposerMentionInsertRequest,
  EMPTY_CHANNEL_HISTORY,
  EVENT_LIMIT,
  HISTORY_REFRESH_INTERVAL_MS,
  RESTING_PRESENCE_REFRESH_DELAYS_MS,
  HUMAN_FOCUS_STABILITY_MS,
  HUMAN_SOCKET_HISTORY_GRACE_MS,
  HUMAN_SOCKET_HISTORY_PAINTED_GRACE_MS,
  OLDER_HISTORY_LIMIT,
  HistoryRenderAuthority,
  OutgoingMessage,
  RELAY_PUSH_PING_INTERVAL_MS,
  AUTOMATION_REFRESH_INTERVAL_MS,
  TRACE_EVENT_LIMIT,
  TimelineItem,
  WorkspaceMessageSearch,
  appRouteInfo,
  agentMessageInstanceIdentityIncomplete,
  appViewPath,
  conversationViewOpen,
  pagesViewPath,
  SPLIT_TOOL_VIEWS,
  adminViewPath,
  toolItemPath,
  toolItemSelection,
  pagesViewSelection,
  attentionSummaryFromEvent,
  browserDevicePresence,
  channelReadSequenceFromEvent,
  claimOutgoingClientIdForEntry,
  compactChannelHistoryCacheInPlace,
  createMobileListFixture,
  currentBrowserLocation,
  currentLoginReturnPath,
  emptyAgentConfigForm,
  errorMessage,
  fetchChannelHistory,
  fetchEvents,
  fetchProjects,
  fetchAutomations,
  fetchSpacesForLanding,
  fetchWorkingSpace,
  historyMessageCountEstimate,
  isLlmTraceEvent,
  isMobileChannelDetailsHistoryState,
  isMobileChannelDetailsLocation,
  isOwnChannelMessage,
  isThreadChannel,
  isTimelineNearBottom,
  isValidChannelMessage,
  latestChannelMentionTimestampMs,
  latestHistoryEntry,
  latestHistorySentAt,
  latestSequence,
  loginPathWithNext,
  mergeObservabilityEvents,
  patchChannelAgentPresenceFromMessage,
  patchChannelsAgentPresenceFromAgent,
  persistWorkingSpace,
  pushBrowserPath,
  readChannelMentionClearedAt,
  readChannelReadCounts,
  readWorkingSpaceCache,
  resolveCurrentSpaceId,
  spacesAuthorityReady,
  channelsAfterAgentInstanceOffline,
  replaceAgent,
  replaceBrowserPath,
  replaceChannel,
  replaceSpace,
  resolveSelectedChannelIdAfterChannelListChange,
  selectedChannelIdAfterRouteChange,
  scrollTimelineToBottom,
  mergeChannelListSnapshot,
  sortChannels,
  timestampMs,
  updateChannelReadState,
  useIsMobileViewport,
  writeChannelMentionClearedAt,
  writeChannelReadCounts,
  writeWorkingSpaceCache,
} from "./workspace-shell-modules";

import { useDesktopSidebarLayout } from "./use-desktop-sidebar-layout";
import { useShellDialogs } from "./use-shell-dialogs";
import { useChannelPins } from "./use-channel-pins";
import { useChannelReadSync } from "./use-channel-read-sync";
import { createRealtimeFrameBatcher, humanFrameBatchKey } from "./realtime-frame-batcher";

export function useWorkspaceShellState({ children }: { children?: React.ReactNode }) {

  const router = useRouter();

  const pathname = usePathname();

  const { user, session, loading, logout } = useAuth();

  const token = session?.access_token;

  const authenticatedUserId = user?.id || null;
  const queryClient = useQueryClient();
  const fetch = useXMatrixQueryFetch(authenticatedUserId);

  const [mobileListFixture] = useState(() => createMobileListFixture(pathname));

  const [browserPath, setBrowserPath] = useState(pathname);

  const routeInfo = useMemo(() => appRouteInfo(browserPath), [browserPath]);

  const desktopBridge = useMemo(() => getDesktopBridge(), []);

  const desktopUpdateBridgeAvailable = Boolean(
    desktopBridge?.getUpdateStatus && desktopBridge?.onUpdateStatus
  );

  const knownDesktopEventIdsRef = useRef<Set<string>>(new Set());

  const nativeNotifiedMessageIdsRef = useRef<Set<string>>(new Set());

  const latestHistorySequenceRef = useRef(0);

  const historyCacheRef = useRef<Map<string, ChannelHistoryCacheEntry>>(new Map());

  const historyRenderAuthoritiesRef = useRef<Map<string, HistoryRenderAuthority>>(new Map());

  const relayPushConnectedRef = useRef(false);

  const relaySocketRef = useRef<WebSocket | null>(null);
  const relayReconnectAttemptRef = useRef(0);

  /** Pings the live Human socket now; a dead one closes after the pong timeout. */
  const relaySocketProbeRef = useRef<(() => void) | null>(null);

  const reconcileUnconfirmedOnReconnectRef = useRef<(() => void) | null>(null);

  const lastHumanFocusRequestRef = useRef<{
    socket: WebSocket;
    channelId: string | null;
    sentAt: number;
  } | null>(null);

  const lastHumanHistoryResponseRef = useRef<{
    channelId: string;
    receivedAt: number;
  } | null>(null);

  const workspaceErrorRef = useRef<string | null>(null);

  const selectedChannelIdRef = useRef<string | null>(null);

  const historyChannelIdRef = useRef<string | null>(null);

  const mobileViewTransitionTokenRef = useRef(0);

  const viewRef = useRef<AppView>("messages");

  const historyRef = useRef<ChannelMessage[]>([]);

  const hasOlderMessagesRef = useRef(false);

  const eventsRef = useRef<ObservabilityEvent[]>([]);


  const agentTraceHistoryBootstrapRef = useRef<AgentTraceHistorySync | null>(null);

  const accessTokenRef = useRef<string | undefined>(token);
  const channelReadStateUserIdRef = useRef<string | null>(null);
  const desktopBridgeRef = useRef<DesktopBridge | null>(desktopBridge);
  const channelsRef = useRef<SerializedChannel[]>([]);
  // An Instance that went offline may be resting rather than gone; its rest is
  // recorded once its daemon reports the exit, a few seconds after the socket
  // closes. Read the channel's presence again after that so its avatar stays,
  // greyed, instead of vanishing until the next catalog refresh.
  function scheduleRestingPresenceRefresh(channelId: string | undefined) {
    if (!channelId || typeof window === "undefined") return;
    const spaceId = channelsRef.current.find((channel) => channel.id === channelId)?.spaceId;
    if (!spaceId) return;
    for (const delayMs of RESTING_PRESENCE_REFRESH_DELAYS_MS) {
      window.setTimeout(() => window.dispatchEvent(new CustomEvent("xmatrix:channel-catalog-change", {
        detail: { kind: "presence", spaceId, channelId },
      })), delayMs);
    }
  }
  const spacesRef = useRef<SerializedSpace[]>([]);

  const routeSpaceIdRef = useRef<string | null>(null);

  const historyRefreshInFlightRef = useRef(false);


  const timelineScrollRef = useRef<HTMLDivElement | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const historyPreloadRef = useRef(new ChannelHistoryPreload<Awaited<ReturnType<typeof fetchChannelHistory>>>());
  const historyPreloadKey = useCallback((accessToken: string, channelId: string) =>
    JSON.stringify([authenticatedUserId, accessToken, channelId]), [authenticatedUserId]);

  /**
   * Starts reading a Channel's latest page before its timeline asks for it.
   * The history read takes this page instead of waiting on the socket, so an
   * uncached Channel paints one Hub round trip after the reader's intent.
   */
  const preloadChannelHistory = useCallback((channelId: string) => {
    if (!token || !authenticatedUserId || historyCacheRef.current.has(channelId)) return;
    historyPreloadRef.current.start(historyPreloadKey(token, channelId), (signal) =>
      fetchChannelHistory(token, channelId, { limit: INITIAL_HISTORY_LIMIT, signal }));
  }, [authenticatedUserId, historyPreloadKey, token]);

  const fetchChannelHistoryQuery = useCallback(async (
    accessToken: string,
    channelId: string,
    options: Parameters<typeof fetchChannelHistory>[2],
  ) => {
    const knownHead = channelsRef.current.find((channel) => channel.id === channelId)
      ?.historyHeadSequence ?? 0;
    const data = await queryClient.fetchInfiniteQuery({
      queryKey: xmatrixQueryKeys.domain(
        { userId: authenticatedUserId || "anonymous" },
        "message-history",
        [channelId, knownHead, options.limit, options.before ?? null,
          options.beforeSequence ?? null, options.afterSequence ?? null],
      ),
      queryFn: async ({ signal }) => {
        if (options.limit === INITIAL_HISTORY_LIMIT && options.before === undefined &&
            options.beforeSequence === undefined && options.afterSequence === undefined) {
          const preloaded = await historyPreloadRef.current.take(
            historyPreloadKey(accessToken, channelId), knownHead,
          );
          if (preloaded) return preloaded;
        }
        return fetchChannelHistory(accessToken, channelId, {
          ...options,
          signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
        });
      },
      initialPageParam: null,
      getNextPageParam: () => undefined,
      staleTime: 1_000,
    });
    const page = data.pages[0];
    if (!page) throw new Error("Channel history query returned no page");
    return page;
  }, [authenticatedUserId, historyPreloadKey, queryClient]);

  const timelineActiveRef = useRef(true);

  const timelinePinnedToBottomRef = useRef(true);

  const timelineScrollTopRef = useRef(0);

  const timelineBottomStickUntilRef = useRef(0);

  /** Disposer for the resize watcher that holds the bottom while a channel opens. */
  const timelineBottomStickCleanupRef = useRef<(() => void) | null>(null);

  const previousTimelineLengthRef = useRef(0);

  const lastTimelineScrollTargetRef = useRef<{ channelId: string | null; itemId: string }>({
    channelId: null,
    itemId: "",
  });

  const pendingChannelScrollRef = useRef<{
    channelId: string;
  } | null>(null);

  const desktopCliSessionSyncTokenRef = useRef("");

  const desktopSetupAutoOpenRef = useRef(false);

  const previousRouteSelectionRef = useRef<{
    routeChannelId: string | null;
    routeSpaceId: string | null;
    view: AppView;
  }>({ routeChannelId: null, routeSpaceId: null, view: "messages" });

  const channelComposerDraftsRef = useRef<Map<string, ChannelComposerDraft<ChannelAttachment>>>(
    new Map()
  );

  // Track which channel owns the live composer state so switches can save/restore drafts.
  const draftChannelIdRef = useRef<string | null>(null);

  const draftWorkspaceTargetValueRef = useRef<string | null>(null);

  const [view, setView] = useState<AppView>("messages");

  const [browserHash, setBrowserHash] = useState("");

  /* The jump intent state machine lives in its own module: arm, reach, land,
     consume. It only needs the scroll container and the hash setter; it never
     reaches into channel or history authority. */
  const {
    pendingMessageJumpRef,
    messageJumpSeekInFlightRef,
    messageJumpSeekAttemptedRef,
    messageJumpRevision,
    bumpMessageJumpRevision,
    highlightedMessageId,
    armMessageJumpHighlight,
    queueMessageJump,
    timelineJumpRef,
    landMessageJump,
    settleMessageJump,
  } = useMessageJump({ timelineScrollRef, setBrowserHash });

  const [channels, setChannels] = useState<SerializedChannel[]>(() => mobileListFixture?.channels ?? []);
  const [spaces, setSpaces] = useState<SerializedSpace[]>(() => mobileListFixture?.spaces ?? []);

  // Who `spaces` is the answer for. An authoritative empty list is still an
  // answer, so `spaces.length` cannot express this — and the answer belongs to
  // the user, not to a JWT, so a token rotation must not retract it.
  const [spacesLoadedUserId, setSpacesLoadedUserId] = useState<string | null>(null);

  const [projects, setProjects] = useState<SerializedWorkspace[]>([]);

  const [automations, setAutomations] = useState<SerializedAutomation[]>([]);

  const [automationExecutionEnabled, setAutomationExecutionEnabled] = useState<boolean | null>(null);

  const [scheduleFocusId, setScheduleFocusId] = useState<string | null>(null);

  const [events, setEvents] = useState<ObservabilityEvent[]>([]);

  const [agentTraceReplicas, setAgentTraceReplicas] = useState<AgentTraceReplica[]>([]);

  const [agents, setAgents] = useState<SerializedAgent[]>([]);

  const [machineDaemons, setMachineDaemons] = useState<SerializedMachineDaemon[]>([]);

  const [channelReadCounts, setChannelReadCounts] = useState<Record<string, number>>(
    () => mobileListFixture?.readCounts ?? {}
  );

  const [channelMentionClearedAt, setChannelMentionClearedAt] = useState<Record<string, number>>({});

  const [channelReadCountsBaselineReady, setChannelReadCountsBaselineReady] = useState(Boolean(mobileListFixture));

  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  /** The page open in the Pages view; a shared page link names it with `?page=`. */
  const [selectedPageId, setSelectedPageId] = useState<string | null>(() => pagesViewSelection(currentBrowserLocation()).pageId);

  const [pendingExplicitSpaceId, setPendingExplicitSpaceId] = useState<string | null>(null);

  /* Mobile is chat-first: the messages view lands on the full-screen channel
     list, so we must NOT auto-pick channels[0]. Desktop keeps the sidebar +
     auto-selection. Read via ref inside selection resolvers (no re-render). */
  const isMobileViewportRef = useRef(false);

  const runMobileScreenTransition = useCallback((
    direction: "forward" | "back",
    update: () => void
  ) => {
    const transitionDocument = document as Document & {
      startViewTransition?: (callback: () => void) => { finished: Promise<void> };
    };
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!isMobileViewportRef.current || reduceMotion || !transitionDocument.startViewTransition) {
      update();
      return;
    }

    const token = mobileViewTransitionTokenRef.current + 1;
    mobileViewTransitionTokenRef.current = token;
    document.documentElement.dataset.xmatrixMobileNavigation = direction;
    try {
      const transition = transitionDocument.startViewTransition(() => {
        flushSync(update);
      });
      void transition.finished.finally(() => {
        if (mobileViewTransitionTokenRef.current === token) {
          delete document.documentElement.dataset.xmatrixMobileNavigation;
        }
      });
    } catch {
      delete document.documentElement.dataset.xmatrixMobileNavigation;
      update();
    }
  }, []);

  /* working workspace (last space the user was in): seeded synchronously from
     the localStorage mirror, reconciled from the cloud on mount. */
  const [workingSpaceId, setWorkingSpaceId] = useState<string | null>(null);

  const [workingSpaceLoaded, setWorkingSpaceLoaded] = useState(false);

  const persistedWorkingSpaceRef = useRef<string | null>(null);

  const workingSpaceRedirectedRef = useRef(false);

  const [history, setHistory] = useState<ChannelMessage[]>([]);

  const [historyCacheRevision, setHistoryCacheRevision] = useState(0);

  const [historyRevision, setHistoryRevision] = useState(0);

  const historyRevisionRef = useRef(0);

  const [historyRenderAuthority, setHistoryRenderAuthority] =
    useState<HistoryRenderAuthority | null>(null);

  const historyRenderAuthorityRef = useRef<HistoryRenderAuthority | null>(null);

  const [loadingWorkspace, setLoadingWorkspace] = useState(!mobileListFixture);

  const [loadingHistory, setLoadingHistory] = useState(false);

  const [olderLoading, setOlderLoading] = useState(false);

  const [hasOlderMessages, setHasOlderMessages] = useState(false);

  const [stoppingAgentInstanceId, setStoppingAgentInstanceId] = useState<string | null>(null);

  const [reborningAgentInstanceId, setReborningAgentInstanceId] = useState<string | null>(null);
  const [handingOffAgentInstanceId, setHandingOffAgentInstanceId] = useState<string | null>(null);

  const [agentInstanceStopRequest, setAgentInstanceStopRequest] =
    useState<AgentInstanceStopRequest | null>(null);

  const [renamingChannelId, setRenamingChannelId] = useState<string | null>(null);

  const [updatingChannelVisibilityId, setUpdatingChannelVisibilityId] = useState<string | null>(null);

  const [outgoingMessages, setOutgoingMessages] = useState<OutgoingMessage[]>([]);

  /** messageId → clientMessageId so confirmed rows keep the same React key as the pending row. */
  const outboundClientIdsByMessageIdRef = useRef(new Map<string, string>());

  /** Stable preview for outbound rows (local sentAt + attachment data URLs) so confirm does not flash. */
  const outboundPreviewByClientIdRef = useRef(
    new Map<string, { sentAt: string; attachments: ChannelAttachment[] }>()
  );

  /** Deduplicate eager thread creation with a send that starts before it completes. */

  const outgoingMessagesRef = useRef<OutgoingMessage[]>([]);

  outgoingMessagesRef.current = outgoingMessages;

  const [error, setError] = useState<string | null>(null);

  workspaceErrorRef.current = error;

  const [historyError, setHistoryError] = useState<string | null>(null);

  const [agentsError, setAgentsError] = useState<string | null>(null);

  const [spacesError, setSpacesError] = useState<string | null>(null);

  const [mobileChannelDetailsOpen, setMobileChannelDetailsOpen] = useState(false);

  const [desktopContext, setDesktopContext] = useState<DesktopContext | null>(null);

  const [desktopDaemonStatus, setDesktopDaemonStatus] = useState<DesktopDaemonStatus | null>(null);

  const [desktopUpdateStatus, setDesktopUpdateStatus] = useState<DesktopUpdateStatus | null>(null);

  const [desktopSetupStatus, setDesktopSetupStatus] = useState<DesktopSetupStatus | null>(null);

  const [agentPresetDiscoveries, setAgentPresetDiscoveries] = useState<DesktopAgentPresetDiscovery[]>([]);

  const [loadingAgentPresetDiscoveries, setLoadingAgentPresetDiscoveries] = useState(false);

  const [localActionBusy, setLocalActionBusy] = useState<string | null>(null);

  const [localActionError, setLocalActionError] = useState<string | null>(null);

  const [automationBusy, setAutomationBusy] = useState<string | null>(null);

  const [automationError, setAutomationError] = useState<string | null>(null);

  const [automationLoadError, setAutomationLoadError] = useState<string | null>(null);

  const [loadingAutomations, setLoadingAutomations] = useState(false);

  const [runtimeCheck, setRuntimeCheck] = useState<DesktopRuntimeCheckResult | null>(null);

  const [checkingDesktopUpdates, setCheckingDesktopUpdates] = useState(false);

  // `draft` is only updated for external seeds (channel restore, send clear, role inject).
  // Keystrokes update draftRef + Composer local state so typing does not re-render the shell.
  // `composerDraftSeedRevision` forces Composer localDraft resync even when the seed text
  // is unchanged (empty→empty after send, or same restored text across channels).
  const [draft, setDraft] = useState("");

  const [composerDraftSeedRevision, setComposerDraftSeedRevision] = useState(0);

  const [mentionInsertRequest, setMentionInsertRequest] =
    useState<ComposerMentionInsertRequest | null>(null);

  const [composerAutoFocusRequest, setComposerAutoFocusRequest] = useState(0);

  const [draftWorkspaceTarget, setDraftWorkspaceTarget] = useState<string | null>(null);

  const [draftAttachments, setDraftAttachments] = useState<ChannelAttachment[]>([]);

  const [replyTarget, setReplyTarget] = useState<TimelineItem | null>(null);

  const draftRef = useRef(draft);

  const draftAttachmentsRef = useRef(draftAttachments);

  const replyTargetRef = useRef(replyTarget);

  const replyTargetHistoryRevisionRef = useRef(-1);

  draftWorkspaceTargetValueRef.current = draftWorkspaceTarget;

  draftAttachmentsRef.current = draftAttachments;

  replyTargetRef.current = replyTarget;

  const seedComposerDraftText = useCallback((text: string) => {
    draftRef.current = text;
    setDraft(text);
    setComposerDraftSeedRevision((value) => value + 1);
  }, []);

  // Why a thread reply did not land, carried per root message so the draft that
  // sent it can say so. See ThreadDraftComposer.

  const [agentTraceTarget, setAgentTraceTarget] = useState<AgentTraceTarget | null>(null);

  const agentTraceTargetRef = useRef<AgentTraceTarget | null>(null);

  agentTraceTargetRef.current = agentTraceTarget;

  const [agentTraceHistoryPanelState, setAgentTraceHistoryPanelState] =
    useState<AgentTraceHistoryPanelState | null>(null);

  const [agentTraceHistoryBootstrapRevision, setAgentTraceHistoryBootstrapRevision] = useState(0);

  const cancelAgentTraceHistoryBootstrap = useCallback(() => {
    agentTraceHistoryBootstrapRef.current?.cancel();
    agentTraceHistoryBootstrapRef.current = null;
  }, []);

  const reconcileAgentTraceChannelAccess = useCallback((
    nextChannels: SerializedChannel[],
    options: { revalidateAll?: boolean } = {}
  ) => {
    const allowedChannelIds = new Set(nextChannels.map((channel) => channel.id));
    setAgentTraceReplicas((current) => options.revalidateAll
      ? []
      : current.filter((replica) => allowedChannelIds.has(replica.scope.channelId))
    );
    const currentTarget = agentTraceTargetRef.current;
    if (currentTarget?.channelId && !allowedChannelIds.has(currentTarget.channelId)) {
      cancelAgentTraceHistoryBootstrap();
      setAgentTraceHistoryPanelState(null);
      setAgentTraceTarget(null);
    } else if (currentTarget && options.revalidateAll) {
      cancelAgentTraceHistoryBootstrap();
      setAgentTraceHistoryPanelState(null);
      setAgentTraceHistoryBootstrapRevision((current) => current + 1);
    }
  }, [cancelAgentTraceHistoryBootstrap]);

  const invalidateAgentTraceChannels = useCallback((
    channelIds: readonly string[],
    currentTargetAction: "reload" | "close"
  ) => {
    const affected = new Set(channelIds);
    if (affected.size === 0) return;
    setAgentTraceReplicas((current) => purgeAgentTraceReplicas(current, { channelIds }));
    const currentTarget = agentTraceTargetRef.current;
    if (!currentTarget) return;
    if (currentTarget.channelId && !affected.has(currentTarget.channelId)) return;
    cancelAgentTraceHistoryBootstrap();
    setAgentTraceHistoryPanelState(null);
    if (currentTargetAction === "close" && currentTarget.channelId) {
      setAgentTraceTarget(null);
    } else {
      setAgentTraceHistoryBootstrapRevision((current) => current + 1);
    }
  }, [cancelAgentTraceHistoryBootstrap]);

  const [agentConfigDialog, setAgentConfigDialog] = useState<AgentConfigDialogState | null>(null);

  const [agentConfigForm, setAgentConfigForm] = useState<AgentConfigForm>(() => emptyAgentConfigForm());

  const [savingAgentConfig, setSavingAgentConfig] = useState(false);

  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);

  // A new conversation starts from a composer: what should happen, sent.
  const [composingConversation, setComposingConversation] = useState(false);
  // The draft belongs to Messages: any other destination (rail, route, Back)
  // drops it, so it neither covers that view nor comes back on return.
  useEffect(() => {
    if (view !== "messages") setComposingConversation(false);
  }, [view]);

  const [channelMoveOpen, setChannelMoveOpen] = useState(false);

  const [channelMoveTargetSpaceId, setChannelMoveTargetSpaceId] = useState("");

  const [movingChannelId, setMovingChannelId] = useState<string | null>(null);

  const [channelMoveError, setChannelMoveError] = useState<string | null>(null);

  const isMobileViewport = useIsMobileViewport();

  const {
    channelQuickOpen,
    setChannelQuickOpen,
    workspaceSearchOpen,
    setWorkspaceSearchOpen,
    openWorkspaceSearch,
  } = useShellDialogs(isMobileViewport);

  const [renamingSpaceId, setRenamingSpaceId] = useState<string | null>(null);

  const [newSpaceName, setNewSpaceName] = useState("");

  const [creatingSpace, setCreatingSpace] = useState(false);


  const {
    desktopSidebarWidth,
    resizingDesktopSidebar,
    startDesktopSidebarResize,
    handleDesktopSidebarResizeKey,
  } = useDesktopSidebarLayout();

  const clearReplyTarget = useCallback((): void => {
    replyTargetRef.current = null;
    replyTargetHistoryRevisionRef.current = -1;
    setReplyTarget(null);
  }, []);

  const invalidateHistoryRenderAuthority = useCallback((): void => {
    const channelId = historyRenderAuthorityRef.current?.channelId;
    if (channelId) historyRenderAuthoritiesRef.current.delete(channelId);
    historyRenderAuthorityRef.current = null;
    setHistoryRenderAuthority(null);
    clearReplyTarget();
  }, [clearReplyTarget]);

  const deactivateHistoryRenderAuthority = useCallback((): void => {
    historyRenderAuthorityRef.current = null;
    setHistoryRenderAuthority(null);
    clearReplyTarget();
  }, [clearReplyTarget]);

  const authorizeHistoryRender = useCallback((authority: HistoryRenderAuthority): void => {
    historyRenderAuthoritiesRef.current.set(authority.channelId, authority);
    historyRenderAuthorityRef.current = authority;
    setHistoryRenderAuthority(authority);
  }, []);

  const bumpHistoryRevision = useCallback((): void => {
    const next = historyRevisionRef.current + 1;
    historyRevisionRef.current = next;
    setHistoryRevision(next);
  }, []);

  const clearChannelHistory = useCallback((channelId?: string): void => {
    if (channelId === undefined) {
      historyCacheRef.current.clear();
      historyRenderAuthoritiesRef.current.clear();
      historyTailBaseGenerationRef.current.clear();
    } else {
      historyCacheRef.current.delete(channelId);
      historyRenderAuthoritiesRef.current.delete(channelId);
      historyTailBaseGenerationRef.current.delete(channelId);
    }
    purgeProductTailCacheChannel(channelId);
    if (channelId !== undefined && historyChannelIdRef.current !== channelId) return;
    invalidateHistoryRenderAuthority();
    historyRef.current = [];
    hasOlderMessagesRef.current = false;
    latestHistorySequenceRef.current = 0;
    setHistory([]);
    setHasOlderMessages(false);
    // The tail cache below consumes this callback, so its generation map and
    // purge callback (both stable) are declared after it and cannot be listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invalidateHistoryRenderAuthority]);

  const syncChannelSummaryFromHistory = useCallback((channelId: string, messages: ChannelMessage[]) => {
    const messageCount = historyMessageCountEstimate(messages);
    const updatedAt = latestHistorySentAt(messages);
    const latestEntry = latestHistoryEntry(messages);
    const lastMessage = latestEntry
      ? channelLastMessagePreviewFromEntry(latestEntry)
      : undefined;
    if (!messageCount && !updatedAt && !lastMessage) return;

    setChannels((current) => {
      let changed = false;
      const next = current.map((channel) => {
        if (channel.id !== channelId) return channel;
        const nextMessageCount = messageCount
          ? Math.max(channel.messageCount || 0, messageCount)
          : channel.messageCount;
        const nextUpdatedAt = updatedAt && timestampMs(updatedAt) > timestampMs(channel.updatedAt)
          ? updatedAt
          : channel.updatedAt;
        const nextLastMessage = lastMessage && (
          !channel.lastMessage ||
          timestampMs(lastMessage.sentAt) >= timestampMs(channel.lastMessage.sentAt)
        )
          ? lastMessage
          : channel.lastMessage;
        if (
          nextMessageCount === channel.messageCount &&
          nextUpdatedAt === channel.updatedAt &&
          nextLastMessage === channel.lastMessage
        ) {
          return channel;
        }
        changed = true;
        return {
          ...channel,
          messageCount: nextMessageCount,
          updatedAt: nextUpdatedAt,
          ...(nextLastMessage ? { lastMessage: nextLastMessage } : {}),
        };
      });
      return changed ? sortChannels(next) : current;
    });
  }, []);

  const bumpHistoryCacheRevision = useCallback(() => {
    setHistoryCacheRevision((current) => current + 1);
  }, []);

  const {
    relaySocketGenerationRef, historyTailBaseGenerationRef, productTailCacheGapRef,
    productTailCacheHydratedStampsRef, productTailCacheStoreRef,
    relaySocketLive, recordHistoryTailBase, historyTailContiguous, productTailCacheHydrationTick,
    scheduleProductTailCachePersist, purgeProductTailCacheChannel,
    cachedCatalogChannels, setCachedCatalogChannels,
  } = useWorkspaceShellTailCache({
    user, mobileListFixture, channels, channelsRef, historyCacheRef,
    historyRenderAuthoritiesRef, historyRevisionRef, selectedChannelIdRef,
    historyChannelIdRef, historyRef, hasOlderMessagesRef, latestHistorySequenceRef,
    relayPushConnectedRef, relaySocketRef, setHistory, setHasOlderMessages, setLoadingHistory,
    authorizeHistoryRender, bumpHistoryCacheRevision, clearChannelHistory, syncChannelSummaryFromHistory,
  });

  const rememberChannelHistory = useCallback((
    channelId: string,
    messages: ChannelMessage[],
    nextHasOlderMessages = historyCacheRef.current.get(channelId)?.hasOlderMessages || false
  ) => {
    const channelMessages = sortChannelHistory(filterHistoryForChannel(channelId, messages));
    historyCacheRef.current.set(channelId, {
      messages: channelMessages,
      hasOlderMessages: nextHasOlderMessages,
      cachedAt: Date.now(),
    });
    compactChannelHistoryCacheInPlace(historyCacheRef.current);
    bumpHistoryCacheRevision();
    syncChannelSummaryFromHistory(channelId, channelMessages);
    scheduleProductTailCachePersist(channelId);
  }, [bumpHistoryCacheRevision, scheduleProductTailCachePersist, syncChannelSummaryFromHistory]);

  const commitChannelHistory = useCallback((
    channelId: string,
    messages: ChannelMessage[],
    nextHasOlderMessages: boolean,
  ) => {
    const channelMessages = sortChannelHistory(filterHistoryForChannel(channelId, messages));
    // A later empty refresh must not replace a focus page that already
    // landed. Click-delayed effect work used to win this race and paint
    // "No messages yet." after user_focus_channel had already answered.
    if (
      channelMessages.length === 0 &&
      historyRef.current.length > 0 &&
      selectedChannelIdRef.current === channelId &&
      historyChannelIdRef.current === channelId
    ) {
      return historyRef.current;
    }
    rememberChannelHistory(channelId, channelMessages, nextHasOlderMessages);
    if (
      selectedChannelIdRef.current !== channelId ||
      historyChannelIdRef.current !== channelId
    ) {
      return channelMessages;
    }
    // A refresh that converges on the identical window must not visibly
    // re-render the timeline.
    if (
      sameChannelHistoryWindow(historyRef.current, channelMessages) &&
      hasOlderMessagesRef.current === nextHasOlderMessages
    ) {
      return channelMessages;
    }
    historyRef.current = channelMessages;
    hasOlderMessagesRef.current = nextHasOlderMessages;
    setHistory(channelMessages);
    setHasOlderMessages(nextHasOlderMessages);
    return channelMessages;
  }, [rememberChannelHistory]);

  /** The window held for a Channel: its presented rows when selected, else its cache. */
  const heldChannelWindow = useCallback((channelId: string, absentHasOlder: boolean) => {
    if (selectedChannelIdRef.current === channelId && historyChannelIdRef.current === channelId) {
      return { messages: historyRef.current, hasOlder: hasOlderMessagesRef.current };
    }
    const cached = historyCacheRef.current.get(channelId);
    return { messages: cached?.messages || [], hasOlder: cached?.hasOlderMessages ?? absentHasOlder };
  }, []);

  const mergeAndRememberChannelHistory = useCallback((
    channelId: string,
    incoming: ChannelMessage[],
    nextHasOlderMessages?: boolean,
  ) => {
    const held = heldChannelWindow(channelId, true);
    return commitChannelHistory(
      channelId,
      mergeChannelHistory(channelId, held.messages, incoming),
      nextHasOlderMessages ?? held.hasOlder,
    );
  }, [commitChannelHistory, heldChannelWindow]);

  const updateChannelReadCounts = useCallback((
    updater: (current: Record<string, number>) => Record<string, number>
  ) => {
    if (!user?.id) return;
    setChannelReadCounts((current) => {
      const next = updater(current);
      if (next === current) return current;
      writeChannelReadCounts(user.id, next);
      return next;
    });
  }, [user?.id]);

  const updateChannelMentionClearedAt = useCallback((
    updater: (current: Record<string, number>) => Record<string, number>
  ) => {
    if (!user?.id) return;
    setChannelMentionClearedAt((current) => {
      const next = updater(current);
      if (next === current) return current;
      writeChannelMentionClearedAt(user.id, next);
      return next;
    });
  }, [user?.id]);

  const markChannelMentionsSeen = useCallback((channelId: string) => {
    const latestMentionAt = latestChannelMentionTimestampMs(channelId, eventsRef.current);
    if (latestMentionAt <= 0) return;
    // Keep clear timestamps ahead of slightly skewed server event clocks.
    const seenAt = Math.max(Date.now(), latestMentionAt);
    updateChannelMentionClearedAt((current) => {
      if ((current[channelId] || 0) >= latestMentionAt) return current;
      return {
        ...current,
        [channelId]: seenAt,
      };
    });
  }, [updateChannelMentionClearedAt]);

  const queueChannelTimelineScroll = useCallback((channelId: string) => {
    pendingChannelScrollRef.current = {
      channelId,
    };
    timelinePinnedToBottomRef.current = true;
    timelineScrollTopRef.current = 0;
    timelineBottomStickUntilRef.current = Date.now() + TIMELINE_BOTTOM_STICK_MS;
  }, []);

  // Hub read authority stays separate from the first-paint device mirror.
  // The hook coalesces viewport signals before they become mutations.
  const {
    markChannelReadToSequence,
    observeChannelReadSequence,
    resetChannelReadSync,
  } = useChannelReadSync({
    accessTokenRef,
    userId: user?.id,
    channelsRef,
    selectedChannelIdRef,
    timelineActiveRef,
    viewRef,
    setChannels,
    updateChannelReadCounts,
  });

  const selectedChannelIsReadableNow = useCallback((channelId: string) => (
    selectedChannelIdRef.current === channelId &&
    conversationViewOpen(viewRef.current) &&
    timelineActiveRef.current &&
    !document.hidden &&
    document.hasFocus()
  ), []);

  // Highest message sequence that has actually been rendered inside the
  // timeline viewport, per channel. Read state only ever advances to this
  // high-water mark: a focused-but-unscrolled channel no longer counts as
  // having read messages that stayed above or below the fold.
  const viewportExposureRef = useRef<Record<string, number>>({});

  const handleTimelineMessageExposed = useCallback((channelId: string, sequence: number) => {
    if (!Number.isFinite(sequence) || sequence <= 0) return;
    const seen = viewportExposureRef.current[channelId] || 0;
    if (sequence > seen) viewportExposureRef.current[channelId] = sequence;
    const highWater = viewportExposureRef.current[channelId];
    markChannelReadToSequence(channelId, highWater);
    if (
      selectedChannelIdRef.current === channelId &&
      highWater >= latestSequence(historyRef.current)
    ) {
      markChannelMentionsSeen(channelId);
    }
  }, [markChannelMentionsSeen, markChannelReadToSequence]);

  const markSelectedChannelReadNow = useCallback(() => {
    const channelId = selectedChannelIdRef.current;
    if (!channelId || !selectedChannelIsReadableNow(channelId)) return;
    const exposed = viewportExposureRef.current[channelId] || 0;
    if (exposed <= 0) return;
    markChannelReadToSequence(channelId, exposed);
    if (exposed >= latestSequence(historyRef.current)) {
      markChannelMentionsSeen(channelId);
    }
  }, [markChannelMentionsSeen, markChannelReadToSequence, selectedChannelIsReadableNow]);

  /** Merges a Hub page into the Channel's window; a page never shrinks it. */
  const applyChannelHistory = useCallback((
    channelId: string,
    messages: ChannelMessage[],
    nextHasOlderMessages: boolean,
  ) => {
    const held = heldChannelWindow(channelId, false);
    commitChannelHistory(
      channelId,
      mergeChannelHistory(channelId, held.messages, messages),
      // A sparse realtime/cache tail does not prove that this complete
      // history page has reached the beginning of the channel. Preserve
      // either source's older-page evidence so pagination can fill every
      // unseen middle range.
      held.hasOlder || nextHasOlderMessages,
    );
  }, [commitChannelHistory, heldChannelWindow]);

  const routeSpaceId = useMemo(
    () => resolveSpaceRouteKey(spaces, routeInfo.spaceKey),
    [routeInfo.spaceKey, spaces]
  );

  const routeChannelId = useMemo(
    () =>
      resolveChannelRouteKey(
        channels,
        routeInfo.channelKey || routeInfo.legacyChannelId || routeInfo.conversationKey,
        routeSpaceId
      )?.id || null,
    [channels, routeInfo.channelKey, routeInfo.conversationKey, routeInfo.legacyChannelId, routeSpaceId]
  );

  const exactRouteHistoryId = routeInfo.view === "messages"
    ? exactChannelIdFromRouteKey(routeInfo.channelKey || "") || routeInfo.legacyChannelId
    : routeInfo.conversationKey;

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId) || null,
    [channels, selectedChannelId]
  );

  const resolvedSpaceId = resolveCurrentSpaceId({
    pendingExplicitSpaceId,
    routeSpaceId,
    workingSpaceId,
    selectedChannelSpaceId: selectedChannel?.spaceId ?? null,
    spaces,
    spacesLoaded: spacesAuthorityReady(spacesLoadedUserId, authenticatedUserId),
  });

  const startupCatalogKey = token && authenticatedUserId
    ? JSON.stringify([authenticatedUserId, resolvedSpaceId]) : null;
  const [settledStartupCatalogKey, setSettledStartupCatalogKey] = useState<string | null>(null);
  const hasChannelRoute = Boolean(routeInfo.channelKey || routeInfo.legacyChannelId);
  const startupHistoryChannelId = exactRouteHistoryId || routeChannelId;
  const startupBackgroundReady = useStartupBackgroundReady(
    token && authenticatedUserId && routeInfo.view === "messages"
      ? hasChannelRoute
        ? JSON.stringify([authenticatedUserId, routeInfo.channelKey, routeInfo.legacyChannelId])
        : startupCatalogKey
      : null,
    hasChannelRoute
      ? Boolean(historyError || (historyRenderAuthority?.userId === authenticatedUserId &&
        historyRenderAuthority?.channelId === startupHistoryChannelId && !loadingHistory))
      : Boolean(mobileListFixture || spacesError ||
        (spacesAuthorityReady(spacesLoadedUserId, authenticatedUserId) && spaces.length === 0) ||
        (startupCatalogKey && settledStartupCatalogKey === startupCatalogKey)),
  );

  const markNativeMessageNotified = useCallback((messageId: string | null | undefined) => {
    if (!messageId) return;
    const notified = nativeNotifiedMessageIdsRef.current;
    notified.add(messageId);
    if (notified.size > 500) {
      const [oldest] = notified;
      if (oldest) notified.delete(oldest);
    }
  }, []);

  useEffect(() => {
    desktopBridgeRef.current = desktopBridge;
  }, [desktopBridge]);

  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  useEffect(() => {
    spacesRef.current = spaces;
  }, [spaces]);

  useEffect(() => {
    routeSpaceIdRef.current = routeSpaceId;
  }, [routeSpaceId]);

  useEffect(() => {
    if (pendingExplicitSpaceId && routeSpaceId === pendingExplicitSpaceId) {
      setPendingExplicitSpaceId(null);
    }
  }, [pendingExplicitSpaceId, routeSpaceId]);

  useEffect(() => {
    setBrowserPath(currentBrowserLocation(pathname));
  }, [pathname]);

  useEffect(() => {
    const syncDetailsFromLocation = () => {
      const nextPath = currentBrowserLocation(pathname);
      setMobileChannelDetailsOpen(
        isMobileChannelDetailsLocation(window.location.hash) ||
        isMobileChannelDetailsHistoryState(window.history.state, nextPath)
      );
    };
    const handlePopState = () => {
      setBrowserPath(currentBrowserLocation(pathname));
      setBrowserHash(window.location.hash);
      // Back and forward between pages restore the page the URL names.
      setSelectedPageId(pagesViewSelection(currentBrowserLocation()).pageId);
      // Summary / channel-info is a hash + history-state overlay on the same
      // channel route. Swipe-back must close it here; the pathname did not change.
      syncDetailsFromLocation();
    };
    const handleHashChange = () => {
      setBrowserHash(window.location.hash);
      syncDetailsFromLocation();
    };
    setBrowserHash(window.location.hash);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, [pathname]);

  useEffect(() => {
    const markInactive = () => {
      timelineActiveRef.current = false;
      const scrollContainer = timelineScrollRef.current;
      if (!scrollContainer) return;
      timelinePinnedToBottomRef.current = isTimelineNearBottom(scrollContainer);
      timelineScrollTopRef.current = scrollContainer.scrollTop;
    };
    const markActive = () => {
      timelineActiveRef.current = true;
      markSelectedChannelReadNow();
      if (timelinePinnedToBottomRef.current) {
        window.requestAnimationFrame(() => {
          scrollTimelineToBottom(timelineScrollRef.current, messagesEndRef.current);
          timelinePinnedToBottomRef.current = true;
        });
      }
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        markInactive();
      } else {
        markActive();
      }
    };

    window.addEventListener("blur", markInactive);
    window.addEventListener("focus", markActive);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", markInactive);
      window.removeEventListener("focus", markActive);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [markSelectedChannelReadNow]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => {
      isMobileViewportRef.current = query.matches;
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  /* working workspace: seed instantly from the localStorage mirror, then
     reconcile from the cloud (authoritative, cross-device). */
  const workingSpaceQuery = useQuery({
    queryKey: xmatrixQueryKeys.domain(
      { userId: user?.id ?? "anonymous" }, "working-space",
    ),
    queryFn: ({ signal }) => fetchWorkingSpace(token!, signal),
    enabled: Boolean(token && user?.id),
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!user?.id) return;
    const cached = readWorkingSpaceCache(user.id);
    if (cached) {
      setWorkingSpaceId(cached);
      persistedWorkingSpaceRef.current = cached;
    }
    if (workingSpaceQuery.data) {
      setWorkingSpaceId(workingSpaceQuery.data);
      persistedWorkingSpaceRef.current = workingSpaceQuery.data;
      writeWorkingSpaceCache(user.id, workingSpaceQuery.data);
    }
    if (workingSpaceQuery.isFetched) setWorkingSpaceLoaded(true);
  }, [user?.id, workingSpaceQuery.data, workingSpaceQuery.isFetched]);

  useEffect(() => {
    setView(routeInfo.view);
  }, [routeInfo.view]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    selectedChannelIdRef.current = selectedChannelId;
  }, [selectedChannelId]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    hasOlderMessagesRef.current = hasOlderMessages;
  }, [hasOlderMessages]);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    accessTokenRef.current = token;
  }, [token]);

  useLayoutEffect(() => {
    // The previous channel's landing must not keep watching a container that
    // now holds another conversation.
    timelineBottomStickCleanupRef.current?.();
    if (!selectedChannelId) {
      pendingChannelScrollRef.current = null;
      // Drop in-app evidence jumps when the conversation is closed so a later
      // open of the same channel is not stolen by a stale follow-up target.
      pendingMessageJumpRef.current = null;
      return;
    }

    queueChannelTimelineScroll(selectedChannelId);
    previousTimelineLengthRef.current = 0;
  }, [queueChannelTimelineScroll, selectedChannelId, pendingMessageJumpRef]);

  useEffect(() => () => timelineBottomStickCleanupRef.current?.(), []);

  // History is user-scoped. Only wipe the in-memory timeline when the signed-in
  // human changes — never on a same-user token refresh.
  useEffect(() => {
    clearChannelHistory();
  }, [clearChannelHistory, user?.id]);

  useEffect(() => {
    const previousChannelId = draftChannelIdRef.current;
    if (previousChannelId && previousChannelId !== selectedChannelId) {
      writeChannelComposerDraft(channelComposerDraftsRef.current, previousChannelId, {
        text: draftRef.current,
        workspaceTarget: draftWorkspaceTargetValueRef.current,
        attachments: draftAttachmentsRef.current,
      });
    }

    draftChannelIdRef.current = selectedChannelId;
    const restored = readChannelComposerDraft(channelComposerDraftsRef.current, selectedChannelId);
    draftWorkspaceTargetValueRef.current = restored.workspaceTarget;
    draftAttachmentsRef.current = restored.attachments;
    replyTargetRef.current = null;
    replyTargetHistoryRevisionRef.current = -1;
    seedComposerDraftText(restored.text);
    setDraftWorkspaceTarget(restored.workspaceTarget);
    setDraftAttachments(restored.attachments);
    // Reply targets are message-scoped UI state, not a reusable text draft.
    setReplyTarget(null);
  }, [seedComposerDraftText, selectedChannelId]);

  useEffect(() => {
    if (!loading && !user) {
      router.replace(loginPathWithNext(currentLoginReturnPath(pathname || "/app")));
    }
  }, [loading, pathname, router, user]);

  useEffect(() => {
    if (exactRouteHistoryId) preloadChannelHistory(exactRouteHistoryId);
  }, [exactRouteHistoryId, preloadChannelHistory]);

  // A reader resting on a Channel row is about to open it: read it now.
  useEffect(() => {
    let dwell: ReturnType<typeof setTimeout> | undefined;
    const rowChannelId = (target: EventTarget | null) => target instanceof Element
      ? target.closest("[data-channel-row-id]")?.getAttribute("data-channel-row-id") || ""
      : "";
    const onPointerOver = (event: PointerEvent) => {
      clearTimeout(dwell);
      const channelId = rowChannelId(event.target);
      if (!channelId) return;
      if (event.pointerType !== "mouse") {
        preloadChannelHistory(channelId);
        return;
      }
      dwell = setTimeout(() => preloadChannelHistory(channelId), CHANNEL_ROW_INTENT_DWELL_MS);
    };
    const onPointerDown = (event: PointerEvent) => {
      const channelId = rowChannelId(event.target);
      if (channelId) preloadChannelHistory(channelId);
    };
    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      clearTimeout(dwell);
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [preloadChannelHistory]);

  useEffect(() => {
    const preload = historyPreloadRef.current;
    return () => preload.clear();
  }, []);

  useChannelHistoryWarmup({
    token,
    ready: Boolean(authenticatedUserId && startupBackgroundReady),
    spaceId: resolvedSpaceId,
    channels,
    selectedChannelId,
    selectedChannelIdRef,
    historyCacheRef,
  });

  useEffect(() => {
    if (!authenticatedUserId) {
      channelReadStateUserIdRef.current = null;
      resetChannelReadSync();
      viewportExposureRef.current = {};
      setChannels([]);
      setChannelReadCounts({});
      setChannelMentionClearedAt({});
      setChannelReadCountsBaselineReady(false);
      return;
    }

    channelReadStateUserIdRef.current = null;
    resetChannelReadSync();
    viewportExposureRef.current = {};
    setChannels([]);
    setChannelReadCountsBaselineReady(false);
    setChannelReadCounts(readChannelReadCounts(authenticatedUserId));
    setChannelMentionClearedAt(readChannelMentionClearedAt(authenticatedUserId));
  }, [authenticatedUserId, resetChannelReadSync]);

  const humanHistoryFallback = useHumanFocusHistoryHttpFallback({ token, selectedChannelIdRef, historyChannelIdRef, channelsRef, applyHistory: (channelId, messages, hasOlderMessages) => applyChannelHistory(channelId, messages, hasOlderMessages), recordTailBase: recordHistoryTailBase, authorizeOnlineHistory: (channelId) => { if (user?.id) authorizeHistoryRender({ userId: user.id, channelId, historyRevision: historyRevisionRef.current }); }, setHistoryError, setLoadingHistory });

  useEffect(() => {
    if (!token || !user) return;
    const userId = user.id;

    let cancelled = false;
    let reconnectTimer: number | undefined;
    let socket: WebSocket | null = null;
    // Survives a token renewal re-running this effect, so a renewed token the Hub
    // still refuses backs off too; only an accepted connect resets it.
    const reconnectAttempt = relayReconnectAttemptRef;

    function relayUrl() {
      const hubUrl = normalizeHubUrl(
        process.env.NEXT_PUBLIC_XMATRIX_HUB_URL || DEFAULT_HUB_URL
      );
      return admittedHumanSocketUrl(hubUrl, userId);
    }

    function scheduleReconnect() {
      if (cancelled) return;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt.current, 5));
      reconnectAttempt.current += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    }

    const heartbeat = bindHumanSocketHeartbeat(
      relaySocketRef, RELAY_PUSH_PING_INTERVAL_MS, replaceSocket,
    );
    relaySocketProbeRef.current = () => heartbeat.probe();
    const suspension = createHumanSocketSuspensionTracker();

    /** Drops the current socket without waiting for its close event. */
    function dropSocket() {
      const stale = socket;
      socket = null;
      if (relaySocketRef.current === stale) relaySocketRef.current = null;
      relayPushConnectedRef.current = false;
      relaySocketGenerationRef.current += 1;
      heartbeat.stop();
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      // Its listeners see it is no longer current and stay silent.
      stale?.close();
    }

    /** Drops the current socket and dials a new one at once. */
    function replaceSocket() {
      if (cancelled) return;
      dropSocket();
      reconnectAttempt.current = 0;
      connect();
    }

    /**
     * The Hub refused this token. It holds the socket open before closing it, to
     * slow clients that only redial on close; this one renews the token now.
     */
    function refuseSocket() {
      if (cancelled || !socket) return;
      dropSocket();
      window.dispatchEvent(new Event(AUTH_TOKEN_REJECTED_EVENT));
      scheduleReconnect();
    }

    function resumeHumanSocket() {
      if (cancelled) return;
      const live = relaySocketRef.current;
      const hidden = document.hidden;
      const action = shouldResumeHumanSocketNow({
        hidden,
        online: navigator.onLine !== false,
        socketReadyState: live ? live.readyState : null,
        suspended: suspension.consume(hidden),
      });
      if (action === "probe") {
        heartbeat.probe();
        return;
      }
      if (action === "replace") {
        replaceSocket();
        return;
      }
      if (action !== "reconnect") return;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      reconnectAttempt.current = 0;
      connect();
    }

    // Presence and activity from many working Agents land as one commit per
    // flush window instead of one per frame (realtime-frame-batcher.ts).
    const relayFrames = createRealtimeFrameBatcher<HumanServerMessage>({
      batchKey: humanFrameBatchKey,
      apply: (frames) => {
        for (const frame of frames) {
          try {
            handleRelayMessage(frame);
          } catch {
            // One bad frame must not drop the rest of its batch.
          }
        }
      },
    });

    function handleRelayMessage(message: HumanServerMessage) {
      switch (message.type) {
        case "error":
          if (message.requestId === "web-subscribe" && !relayPushConnectedRef.current &&
              message.failure?.code === HUMAN_AUTH_INVALID_FAILURE_CODE) {
            refuseSocket();
            break;
          }
          humanHistoryFallback.recoverFromSocketError(message.requestId, message.message);
          break;
        case "human_connected":
          {
            setAgentTraceReplicas((current) =>
              purgeThirdPartyAgentTraceReplicas(current, userId)
            );
            const currentTarget = agentTraceTargetRef.current;
            if (currentTarget && currentTarget.ownerUserId !== userId) {
              cancelAgentTraceHistoryBootstrap();
              setAgentTraceHistoryPanelState(null);
              setAgentTraceHistoryBootstrapRevision((current) => current + 1);
            }
          }
          relayPushConnectedRef.current = true;
          setHumanPushConnected(true);
          reconnectAttempt.current = 0;
          reconcileUnconfirmedOnReconnectRef.current?.();
          sendHumanChannelFocus({
            channelId: conversationViewOpen(viewRef.current) ? selectedChannelIdRef.current : null,
            socket,
            connected: true,
            selectedChannelIdRef,
            historyChannelIdRef,
            lastHumanFocusRequestRef,
          });
          window.dispatchEvent(new CustomEvent("xmatrix:channel-catalog-change", {
            detail: { kind: "reconnect" },
          }));
          break;
        case "space_channel_catalog_changed":
          window.dispatchEvent(new CustomEvent("xmatrix:channel-catalog-change", {
            detail: {
              kind: "revision",
              spaceId: message.spaceId,
              revision: message.revision,
            },
          }));
          break;
        case "workspace_resource_changed":
          window.dispatchEvent(new CustomEvent("xmatrix:workspace-resource-changed", {
            detail: {
              spaceId: message.spaceId,
              resource: message.resource,
              revision: message.revision,
              ...(message.channelId ? { channelId: message.channelId } : {}),
            },
          }));
          break;
        case "observable_event":
          // Trace history is read directly from the exact Agent host only
          // when its detail is opened. Never turn a realtime relay event into
          // an alternate trace source.
          if (!isLlmTraceEvent(message.event)) {
            setEvents((current) => mergeObservabilityEvents(current, [message.event], TRACE_EVENT_LIMIT));
          }
          if (message.event.type === "channel_attention_updated" && message.event.channelId) {
            const attention = attentionSummaryFromEvent(message.event);
            const readSequence = channelReadSequenceFromEvent(message.event);
            if (readSequence !== undefined) {
              channelReadStateUserIdRef.current = userId;
              observeChannelReadSequence(message.event.channelId, readSequence);
            }
            if (attention || readSequence !== undefined) {
              setChannels((current) => updateChannelReadState(
                current,
                message.event.channelId!,
                { attention, readSequence }
              ));
              // The sidebar badges the paged catalog, which this event would
              // otherwise never reach: reading on another device has to put
              // this one's badge out too.
              if (userId) {
                applyChannelReadStateToCatalog({
                  client: queryClient,
                  prefix: xmatrixQueryKeys.all({ userId }),
                  readStates: new Map([[message.event.channelId, { attention, readSequence }]]),
                });
              }
            }
          }
          // Another member's cursor moved: mention read state at the `@`
          // updates in place, without refetching the channel.
          if (message.event.type === "channel_member_read_updated") {
            setChannels((current) => applyMemberReadEvent(current, message.event));
          }
          if (message.event.type === "agent_disconnected") {
            const instanceId = message.event.metadata?.instanceId;
            setChannels((current) => channelsAfterAgentInstanceOffline(current, {
              channelId: message.event.channelId,
              agentId: message.event.agentId,
              instanceId: typeof instanceId === "string" ? instanceId : undefined,
            }));
            scheduleRestingPresenceRefresh(message.event.channelId);
          }
          break;
        case "agent_lifecycle":
          if (message.status === "offline") {
            setChannels((current) => channelsAfterAgentInstanceOffline(current, message));
            scheduleRestingPresenceRefresh(message.channelId);
          }
          break;
        case "channel_list":
          channelReadStateUserIdRef.current = userId;
          reconcileAgentTraceChannelAccess(message.channels, { revalidateAll: true });
          setChannels((current) => mergeChannelListSnapshot(current, message.channels));
          // Intentionally do NOT clear the workspace `error` here: a channel_list
          // push only restores channels, not spaces/projects. Clearing the error
          // would let the refresh guard re-suppress background polling (relay push
          // connected) and leave spaces/projects stuck empty. The guard change in
          // the workspace refresh keeps polling alive while error is sticky, so the
          // full workspace self-heals and clears the error only on a complete load.
          break;
        case "space_created":
          setSpaces((current) => replaceSpace(current, message.space));
          break;
        case "space_updated":
        case "space_member_upserted":
        case "space_member_removed": {
          const affectedChannelIds = channelsRef.current
            .filter((channel) => channel.spaceId === message.space.id)
            .map((channel) => channel.id);
          const retainsAccess =
            message.space.ownerId === userId ||
            message.space.members.some((member) => member.userId === userId);
          invalidateAgentTraceChannels(
            affectedChannelIds,
            retainsAccess ? "reload" : "close"
          );
          if (agentTraceTargetRef.current && !agentTraceTargetRef.current.channelId) {
            cancelAgentTraceHistoryBootstrap();
            setAgentTraceHistoryPanelState(null);
            if (retainsAccess) {
              setAgentTraceHistoryBootstrapRevision((current) => current + 1);
            } else {
              setAgentTraceTarget(null);
            }
          }
          setSpaces((current) => replaceSpace(current, message.space));
          break;
        }
        case "space_deleted": {
          const affectedChannelIds = channelsRef.current
            .filter((channel) => channel.spaceId === message.spaceId)
            .map((channel) => channel.id);
          invalidateAgentTraceChannels(affectedChannelIds, "close");
          setSpaces((current) => current.filter((space) => space.id !== message.spaceId));
          break;
        }
        case "agent_list":
          setAgents(message.agents);
          setAgentsError(null);
          break;
        case "presence":
        case "enhanced_presence":
          setAgents((current) => replaceAgent(current, message.agent));
          setChannels((current) => patchChannelsAgentPresenceFromAgent(current, message.agent));
          break;
        case "presence_digest":
          // The same cards as enhanced_presence, a second's worth at once.
          setAgents((current) => message.agents.reduce(replaceAgent, current));
          setChannels((current) => message.agents.reduce(patchChannelsAgentPresenceFromAgent, current));
          break;
        case "channel_created":
          setChannels((current) => replaceChannel(current, message.channel));
          window.dispatchEvent(new CustomEvent("xmatrix:channel-catalog-change", {
            detail: { kind: "structure", spaceId: message.channel.spaceId },
          }));
          break;
        case "app_connector_result_channels": {
          setChannels((current) =>
            message.channels.reduce(
              (nextChannels, resultChannel) => replaceChannel(nextChannels, resultChannel),
              current,
            ),
          );
          // Result-channel events are broadcast to every authorized Human in
          // the source Channel. Only the browser that originated this exact
          // committed message should preserve send-time auto-navigation.
          if (!outboundClientIdsByMessageIdRef.current.has(message.sourceMessageId)) {
            break;
          }
          const targetThread =
            message.channels.find((resultChannel) => isThreadChannel(resultChannel)) ||
            message.channels[0];
          if (targetThread) {
            const nextPath = channelAppPath(targetThread, spacesRef.current);
            setView("messages");
            setSelectedChannelId(targetThread.id);
            pushBrowserPath(nextPath);
            setBrowserPath(nextPath);
          }
          break;
        }
        case "channel_updated":
          invalidateAgentTraceChannels([message.channel.id], "reload");
          {
            const previousChannel = channelsRef.current.find(
              (channel) => channel.id === message.channel.id,
            );
            // A visibility change re-reads history under the new audience.
            if (
              previousChannel && (
                previousChannel.mode !== message.channel.mode ||
                previousChannel.spaceId !== message.channel.spaceId
              )
            ) {
              clearChannelHistory(message.channel.id);
            }
          }
          setChannels((current) => replaceChannel(current, message.channel));
          {
            const previousChannel = channelsRef.current.find(
              (channel) => channel.id === message.channel.id,
            );
            const structureChanged = !previousChannel ||
              previousChannel.spaceId !== message.channel.spaceId ||
              previousChannel.name !== message.channel.name ||
              previousChannel.mode !== message.channel.mode ||
              previousChannel.metadata?.kind !== message.channel.metadata?.kind;
            if (structureChanged) {
              window.dispatchEvent(new CustomEvent("xmatrix:channel-catalog-change", {
                detail: { kind: "structure", spaceId: message.channel.spaceId },
              }));
            }
          }
          break;
        case "channel_deleted":
          invalidateAgentTraceChannels([message.channelId], "close");
          historyCacheRef.current.delete(message.channelId);
          historyTailBaseGenerationRef.current.delete(message.channelId);
          purgeProductTailCacheChannel(message.channelId);
          setChannels((current) => current.filter((channel) => channel.id !== message.channelId));
          window.dispatchEvent(new CustomEvent("xmatrix:channel-catalog-change", {
            detail: { kind: "structure" },
          }));
          if (selectedChannelIdRef.current === message.channelId) {
            historyChannelIdRef.current = null;
            historyRef.current = [];
            hasOlderMessagesRef.current = false;
            setHistory([]);
            setHasOlderMessages(false);
            setSelectedChannelId(null);
          }
          break;
        case "channel_topic_updated":
          setChannels((current) =>
            sortChannels(
              current.map((channel) =>
                channel.id === message.channelId
                  ? { ...channel, topic: message.topic, updatedAt: message.updatedAt }
                  : channel
              )
            )
          );
          window.dispatchEvent(new CustomEvent("xmatrix:channel-catalog-change", {
            detail: {
              kind: "structure",
              spaceId: channelsRef.current.find((channel) => channel.id === message.channelId)?.spaceId,
            },
          }));
          break;
        case "channel_history": {
          const requestedFocus = lastHumanFocusRequestRef.current;
          const isRequestedFocusPage = Boolean(
            requestedFocus &&
            requestedFocus.channelId === message.channelId &&
            requestedFocus.socket.readyState === WebSocket.OPEN
          );
          // A focus page can land before React commits the route. Keep it if
          // this is the channel we already asked for, even when the layout
          // effect has not yet copied the id into historyChannelIdRef.
          if (
            selectedChannelIdRef.current !== message.channelId &&
            !isRequestedFocusPage
          ) {
            break;
          }
          if (historyChannelIdRef.current !== message.channelId) {
            historyChannelIdRef.current = message.channelId;
          }
          const onlineMessages = filterHistoryForChannel(
            message.channelId,
            message.messages.filter(isValidChannelMessage),
          );
          if (humanHistoryFallback.recoverFromSocketPage({ channelId: message.channelId, hasMore: message.hasMore, receivedMessages: onlineMessages, rawMessageCount: message.messages.length })) break;
          applyChannelHistory(
            message.channelId,
            onlineMessages,
            message.hasMore,
          );
          recordHistoryTailBase(message.channelId);
          authorizeHistoryRender({
            userId,
            channelId: message.channelId,
            historyRevision: historyRevisionRef.current,
          });
          setHistoryError(null);
          setLoadingHistory(false);
          // Count the focus response only after validation and merge. A
          // sparse cache can paint a realtime tail, but it must never turn a
          // complete socket page into an acknowledged no-op.
          lastHumanHistoryResponseRef.current = {
            channelId: message.channelId,
            receivedAt: performance.now(),
          };
          break;
        }
        case "channel_message_received": {
          // The frame carries the message verbatim. Nothing is re-listed here:
          // a field this client forgets to copy is exactly how attachments and
          // rich metadata went missing from live delivery before.
          const entry = message.message;
          if (!isValidChannelMessage(entry)) {
            break;
          }
          if (agentMessageInstanceIdentityIncomplete(entry)) {
            // Do not synthesize an unaddressable live card. The catalog event below
            // refreshes Authority Presence; this event is a narrow observability hook.
            window.dispatchEvent(new CustomEvent("xmatrix:agent-message-identity-incomplete", {
              detail: {
                channelId: entry.channelId,
                messageId: entry.messageId,
                agentId: entry.from.identityId,
                instanceId: entry.from.instanceId,
              },
            }));
          }
          if (message.clientMessageId && isOwnChannelMessage(entry, userId)) {
            // The realtime event normally arrives before the POST response.
            // Reconcile here so the pending row is updated in place instead of
            // briefly rendering a second confirmed row with a different key.
            outboundClientIdsByMessageIdRef.current.set(entry.messageId, message.clientMessageId);
            setOutgoingMessages((current) =>
              current.filter((outgoing) => outgoing.clientMessageId !== message.clientMessageId)
            );
          }
          const cached = historyCacheRef.current.get(entry.channelId);
          const selected = selectedChannelIdRef.current === entry.channelId &&
            historyChannelIdRef.current === entry.channelId;
          const currentMessages = selected ? historyRef.current : (cached?.messages || []);
          const alreadyCached = currentMessages.some(
            (cachedMessage) => cachedMessage.messageId === entry.messageId
          );
          // If this is our own outbound still in the local queue, bind its client id now so the
          // WS echo reuses the pending row key instead of mounting a second message and flashing.
          let claimedOutboundClientId: string | undefined;
          if (isOwnChannelMessage(entry, userId)) {
            claimedOutboundClientId = claimOutgoingClientIdForEntry(
              entry,
              outgoingMessagesRef.current,
              outboundClientIdsByMessageIdRef.current,
              outboundPreviewByClientIdRef.current
            );
            if (claimedOutboundClientId) {
              setOutgoingMessages((current) =>
                current.filter((item) => item.clientMessageId !== claimedOutboundClientId)
              );
            }
          }
          mergeAndRememberChannelHistory(entry.channelId, [entry]);
          if (message.notification?.attention) {
            setChannels((current) => updateChannelReadState(current, entry.channelId, {
              attention: message.notification!.attention,
              readSequence: undefined,
            }));
          }
          maybePushRecipientScopedNativeMessageNotification({
            entry,
            alreadyCached,
            notification: message.notification,
            userId,
            notifiedMessageIds: nativeNotifiedMessageIdsRef.current,
            bridge: desktopBridgeRef.current,
            channels: channelsRef.current,
            spaces: spacesRef.current,
            routeSpaceId: routeSpaceIdRef.current,
            markNotified: markNativeMessageNotified,
          });
          if (selectedChannelIdRef.current === entry.channelId) {
            // Already visible as a pending row at the bottom — do not force a scroll jump.
            if (isOwnChannelMessage(entry, userId) && !claimedOutboundClientId) {
              queueChannelTimelineScroll(entry.channelId);
            }
          }
          setChannels((current) =>
            sortChannels(
              current.map((channel) => {
                if (channel.id !== entry.channelId) return channel;
                const nextCount = entry.sequence
                  ? Math.max(channel.messageCount || 0, entry.sequence)
                  : (channel.messageCount || 0) + 1;
                // An activity entry needs no reading: a reader who was caught
                // up before it stays caught up, as the catalog also derives
                // (docs/design/conversation-activity.md §3.2).
                const stillRead = channelActivityOf(entry.metadata) !== undefined &&
                  channel.readSequence !== undefined &&
                  channel.readSequence >= (channel.messageCount || 0);
                return patchChannelAgentPresenceFromMessage({
                  ...channel,
                  messageCount: nextCount,
                  ...(stillRead ? { readSequence: nextCount } : {}),
                  historyHeadSequence: entry.sequence
                    ? Math.max(channel.historyHeadSequence || 0, entry.sequence)
                    : channel.historyHeadSequence,
                  updatedAt: entry.sentAt,
                  lastMessage: channelLastMessagePreviewFromEntry(entry) ?? channel.lastMessage,
                }, entry);
              })
            )
          );
          window.dispatchEvent(new CustomEvent("xmatrix:channel-catalog-change", {
            detail: {
              kind: "message",
              channelId: entry.channelId,
              spaceId: channelsRef.current.find((channel) => channel.id === entry.channelId)?.spaceId,
              at: entry.sentAt,
            },
          }));
          break;
        }
        case "channel_message_updated": {
          if (!isValidChannelMessage(message.message)) {
            break;
          }
          if (replyTargetRef.current?.messageId === message.message.messageId) {
            clearReplyTarget();
          }
          if (message.message.deletedAt || message.message.recalledAt) {
            clearChannelHistory(message.channelId);
            bumpHistoryRevision();
            window.dispatchEvent(new CustomEvent("xmatrix:channel-catalog-change", {
              detail: { kind: "content", channelId: message.channelId },
            }));
            break;
          }
          mergeAndRememberChannelHistory(message.channelId, [message.message]);
          break;
        }
      }
    }

    function connect() {
      if (cancelled) return;
      const live = new WebSocket(relayUrl());
      socket = live;
      relaySocketRef.current = live;
      live.addEventListener("open", () => {
        if (cancelled || socket !== live) {
          live.close();
          return;
        }
        relayPushConnectedRef.current = false;
        live.send(JSON.stringify({
          type: "human_connect",
          token,
          requestId: "web-subscribe",
          // Presence for conversations not on screen may come as a once-a-second digest.
          device: { ...browserDevicePresence(desktopBridgeRef.current), capabilities: [HUMAN_CLIENT_PRESENCE_DIGEST] },
        }));
        heartbeat.start();
      });
      live.addEventListener("message", (event) => {
        if (socket !== live) return;
        heartbeat.noteInbound();
        try {
          const decoded = JSON.parse(String(event.data)) as unknown;
          const catalogChanged = parseHumanChannelCatalogChangedMessage(decoded);
          const workspaceChanged = parseHumanWorkspaceResourceChangedMessage(decoded);
          const claimedType = decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
            ? (decoded as { type?: unknown }).type : undefined;
          if ((claimedType === "space_channel_catalog_changed" && !catalogChanged) ||
              (claimedType === "workspace_resource_changed" && !workspaceChanged)) return;
          relayFrames.push(workspaceChanged ?? catalogChanged ?? decoded as HumanServerMessage);
        } catch {
          // Ignore malformed push payloads; REST refresh remains the fallback.
        }
      });
      live.addEventListener("close", (event) => {
        if (socket !== live) return;
        socket = null;
        relayPushConnectedRef.current = false;
        setHumanPushConnected(false);
        relaySocketGenerationRef.current += 1;
        if (relaySocketRef.current === live) {
          relaySocketRef.current = null;
        }
        heartbeat.stop();
        if (handleHumanSocketCompatibilityClose(event.code, scheduleReconnect)) return;
        // The renewed token re-runs this effect; the backed-off redial is only the fallback.
        if (event.code === HUMAN_AUTH_REQUIRED_CLOSE_CODE) window.dispatchEvent(new Event(AUTH_TOKEN_REJECTED_EVENT));
        scheduleReconnect();
      });
      live.addEventListener("error", () => {
        live.close();
      });
    }

    if (reconnectAttempt.current > 0) scheduleReconnect();
    else connect();
    const stopResume = listenForHumanSocketResume(resumeHumanSocket, suspension.markSuspended);
    return () => {
      cancelled = true;
      relayFrames.dispose();
      relayPushConnectedRef.current = false;
      setHumanPushConnected(false);
      heartbeat.stop();
      relaySocketProbeRef.current = null;
      stopResume();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (relaySocketRef.current === socket) {
        relaySocketRef.current = null;
      }
      if (socket?.readyState !== WebSocket.CONNECTING) {
        socket?.close();
      }
    };
  }, [
    applyChannelHistory,
    authorizeHistoryRender,
    bumpHistoryRevision,
    cancelAgentTraceHistoryBootstrap,
    clearReplyTarget,
    clearChannelHistory,
    invalidateAgentTraceChannels,
    commitChannelHistory,
    mergeAndRememberChannelHistory,
    observeChannelReadSequence,
    purgeProductTailCacheChannel,
    queueChannelTimelineScroll,
    recordHistoryTailBase,
    reconcileAgentTraceChannelAccess,
    humanHistoryFallback,
    relaySocketGenerationRef,
    historyTailBaseGenerationRef,
    queryClient,
    token,
    user, markNativeMessageNotified,
  ]);

  // Catch up when the socket connects, and restart the fallback polls when it drops.
  // TanStack reads refetchInterval only after a fetch.
  useEffect(() => {
    const onPush = () => invalidateWorkspaceResources(queryClient);
    const onResource = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceResourceChange>).detail;
      invalidateWorkspaceResources(queryClient, detail);
    };
    window.addEventListener("xmatrix:human-push", onPush);
    window.addEventListener("xmatrix:workspace-resource-changed", onResource);
    return () => {
      window.removeEventListener("xmatrix:human-push", onPush);
      window.removeEventListener("xmatrix:workspace-resource-changed", onResource);
    };
  }, [queryClient]);

  useEffect(() => {
    const focusedChannelId = conversationViewOpen(view) ? selectedChannelId : null;
    const timer = window.setTimeout(() => {
      const socket = relaySocketRef.current;
      const lastRequest = lastHumanFocusRequestRef.current;
      if (lastRequest?.socket === socket && lastRequest.channelId === focusedChannelId) return;
      sendHumanChannelFocus({
        channelId: focusedChannelId,
        socket,
        connected: relayPushConnectedRef.current,
        selectedChannelIdRef,
        historyChannelIdRef,
        lastHumanFocusRequestRef,
      });
    }, HUMAN_FOCUS_STABILITY_MS);
    return () => window.clearTimeout(timer);
  }, [selectedChannelId, view]);

  const workspaceQueriesEnabled = Boolean(token && authenticatedUserId && !mobileListFixture);
  const workspaceRefetchInterval = () => document.hidden ||
      (relayPushConnectedRef.current && workspaceErrorRef.current === null)
    ? false
    : HISTORY_REFRESH_INTERVAL_MS;
  const spacesQuery = useQuery({
    queryKey: xmatrixQueryKeys.spaces({ userId: authenticatedUserId || "anonymous" }),
    queryFn: ({ signal }) => fetchSpacesForLanding(token!, signal),
    enabled: workspaceQueriesEnabled,
    staleTime: 15_000,
    refetchInterval: workspaceRefetchInterval,
    refetchIntervalInBackground: false,
  });
  const projectsQuery = useQuery({
    queryKey: xmatrixQueryKeys.domain(
      { userId: authenticatedUserId || "anonymous" }, "workspace-projects",
    ),
    queryFn: ({ signal }) => fetchProjects(token!, signal),
    enabled: workspaceQueriesEnabled && startupBackgroundReady,
    staleTime: 15_000,
    refetchInterval: workspaceRefetchInterval,
    refetchIntervalInBackground: false,
  });
  const eventsQuery = useQuery({
    queryKey: xmatrixQueryKeys.domain(
      { userId: authenticatedUserId || "anonymous" }, "workspace-events", [EVENT_LIMIT],
    ),
    queryFn: ({ signal }) => fetchEvents(token!, EVENT_LIMIT, signal),
    enabled: workspaceQueriesEnabled && startupBackgroundReady,
    staleTime: 15_000,
    refetchInterval: workspaceRefetchInterval,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (mobileListFixture) {
      channelReadStateUserIdRef.current = authenticatedUserId;
      setChannels(mobileListFixture.channels);
      setSpaces(mobileListFixture.spaces);
      setSpacesLoadedUserId(authenticatedUserId);
      setChannelReadCounts(mobileListFixture.readCounts);
      setChannelReadCountsBaselineReady(true);
      setLoadingWorkspace(false);
      setError(null);
      setSpacesError(null);
      return;
    }
    if (!token) {
      setChannels([]);
      setSpaces([]);
      setSpacesLoadedUserId(null);
      setProjects([]);
      setAutomations([]);
      setAutomationExecutionEnabled(null);
      setEvents([]);
      setAgentTraceReplicas([]);
      setLoadingWorkspace(false);
      return;
    }
    // Project metadata is background work, not a prerequisite for Channels.
    setLoadingWorkspace(spacesQuery.isPending);
    const primaryError = spacesQuery.error ?? projectsQuery.error;
    if (primaryError) {
      const message = primaryError instanceof Error ? primaryError.message : "Workspace unavailable";
      setError(message);
      setSpacesError(message);
      return;
    }
    if (projectsQuery.data) setProjects(projectsQuery.data);
    if (eventsQuery.data) {
      setEvents(eventsQuery.data.filter((event) => !isLlmTraceEvent(event)));
    }
    const nextSpaces = spacesQuery.data;
    if (!nextSpaces) return;
    setSpaces(nextSpaces);
    setSpacesLoadedUserId(authenticatedUserId);
    setError(null);
    setSpacesError(null);
    channelReadStateUserIdRef.current = authenticatedUserId;
    const nextChannels = channelsRef.current;
    reconcileAgentTraceChannelAccess(nextChannels);
    const currentRoute = appRouteInfo(currentBrowserLocation());
    const currentRouteSpaceId = resolveSpaceRouteKey(nextSpaces, currentRoute.spaceKey);
    const requestedChannel = resolveChannelRouteKey(
      nextChannels,
      currentRoute.channelKey || currentRoute.legacyChannelId,
      currentRouteSpaceId,
    );
    setSelectedChannelId((current) => resolveSelectedChannelIdAfterChannelListChange({
      channels: nextChannels,
      current,
      requestedChannelId: requestedChannel?.id || null,
    }));
  }, [
    authenticatedUserId,
    eventsQuery.data,
    mobileListFixture,
    projectsQuery.data,
    projectsQuery.error,
    reconcileAgentTraceChannelAccess,
    spacesQuery.data,
    spacesQuery.error,
    spacesQuery.isPending,
    token,
  ]);

  useEffect(() => {
    const previousRouteSelection = previousRouteSelectionRef.current;
    const routeSelectionChanged =
      previousRouteSelection.routeChannelId !== routeChannelId ||
      previousRouteSelection.routeSpaceId !== routeSpaceId ||
      previousRouteSelection.view !== routeInfo.view;
    previousRouteSelectionRef.current = { routeChannelId, routeSpaceId, view: routeInfo.view };
    const routeNamesChannel = Boolean(routeInfo.channelKey || routeInfo.legacyChannelId || routeInfo.conversationKey);

    // Android versions that predate the native-to-Web Back bridge move through
    // WebView history directly. Route movement must still dismiss a details
    // overlay, otherwise its stale boolean reappears over the next Channel.
    if (routeSelectionChanged) setMobileChannelDetailsOpen(false);

    setSelectedChannelId((current) => selectedChannelIdAfterRouteChange({
      channels,
      current,
      routeChannelId,
      routeNamesChannel,
      routeSelectionChanged,
    }));
  }, [
    channels,
    routeChannelId,
    routeInfo.channelKey,
    routeInfo.conversationKey,
    routeInfo.legacyChannelId,
    routeInfo.view,
    routeSpaceId,
  ]);

  useEffect(() => {
    if (!user || channels.length === 0) return;
    if (channelReadStateUserIdRef.current !== user.id) return;

    updateChannelReadCounts((current) => {
      let changed = false;
      const next = { ...current };
      for (const channel of channels) {
        const hubReadSequence = channel.readSequence;
        if (hubReadSequence !== undefined) {
          observeChannelReadSequence(channel.id, hubReadSequence);
          if (next[channel.id] === hubReadSequence) continue;
          next[channel.id] = hubReadSequence;
          changed = true;
          continue;
        }
        if (channel.messageCount === undefined || next[channel.id] !== undefined) continue;
        // Legacy/single-channel payloads can omit the user-scoped hydration.
        // Keep the local first-sight baseline until an authoritative list or
        // realtime read update supplies readSequence.
        next[channel.id] = channel.messageCount;
        changed = true;
      }
      return changed ? next : current;
    });
    setChannelReadCountsBaselineReady(true);
  }, [channels, observeChannelReadSequence, updateChannelReadCounts, user]);

  // Who may read the selected Channel's history; a change re-reads it. The
  // Channel object itself changes on every message, so it is not a dependency.
  const selectedChannelAudience = selectedChannel
    ? `${selectedChannel.spaceId}:${selectedChannel.mode}`
    : null;

  // Rows render only for the user, Channel and history revision they were read for.
  const historyRenderAuthorized = Boolean(
    mobileListFixture ||
    (historyRenderAuthority && user?.id && selectedChannelId &&
      historyRenderAuthority.userId === user.id &&
      historyRenderAuthority.channelId === selectedChannelId &&
      historyRenderAuthority.historyRevision === historyRevision)
  );

  const renderableHistory = historyRenderAuthorized ? history : EMPTY_CHANNEL_HISTORY;

  const automationsQuery = useQuery({
    queryKey: xmatrixQueryKeys.domain(
      { userId: authenticatedUserId || "anonymous" }, "automations",
      [resolvedSpaceId ?? null],
    ),
    queryFn: ({ signal }) => fetchAutomations(token!, {
      spaceId: resolvedSpaceId!,
      signal,
    }),
    enabled: Boolean(token && authenticatedUserId && resolvedSpaceId && startupBackgroundReady),
    staleTime: 15_000,
    refetchInterval: () => refetchUnlessHumanPush(AUTOMATION_REFRESH_INTERVAL_MS),
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (!token || !resolvedSpaceId) {
      setAutomations([]);
      setAutomationExecutionEnabled(null);
      setAutomationLoadError(null);
      setLoadingAutomations(false);
      return;
    }
    setLoadingAutomations(automationsQuery.isPending);
    setAutomations(automationsQuery.data?.automations ?? []);
    if (automationsQuery.error) {
      // TanStack Query retains the last successful data during a failed
      // background refetch. Keep painting it, but revoke mutation capability
      // until a fresh authoritative response succeeds.
      setAutomationExecutionEnabled(null);
      setAutomationLoadError(errorMessage(
        automationsQuery.error, "Could not load Automations.",
      ));
    } else if (automationsQuery.data) {
      setAutomationExecutionEnabled(automationsQuery.data.executionEnabled);
      setAutomationLoadError(null);
    }
  }, [
    resolvedSpaceId,
    automationsQuery.data,
    automationsQuery.error,
    automationsQuery.isPending,
    token,
  ]);

  useMachineDaemonLoad({
    token,
    backgroundReady: startupBackgroundReady,
    relayPushConnectedRef,
    machinesViewOpen: view === "machines",
    setMachineDaemons,
  });

  // Channel selection first renders with the previous history state. Resolve
  // the target cache and its scoped render authority before the browser paints
  // that intermediate frame, otherwise cached channel switches visibly flash
  // an empty timeline between the click and this effect.
  const adoptIncrementalHistory = useCallback((channelId: string, messages: ChannelMessage[],
    renderAuthority: HistoryRenderAuthority | null) => {
    applyChannelHistory(channelId, messages, false);
    productTailCacheGapRef.current.delete(channelId);
    // A network-authoritative tail no longer needs its disk hydration stamp.
    productTailCacheHydratedStampsRef.current.delete(channelId);
    recordHistoryTailBase(channelId);
    if (renderAuthority) authorizeHistoryRender(renderAuthority);
  }, [applyChannelHistory, authorizeHistoryRender, productTailCacheGapRef,
    productTailCacheHydratedStampsRef, recordHistoryTailBase]);

  // Whether the catalog knows the selected channel; the read below needs only
  // that, not every catalog update to the channel's row.
  const selectedChannelKnown = Boolean(selectedChannel);
  useLayoutEffect(() => {
    if (mobileListFixture && selectedChannelId) {
      const fixtureHistory = mobileListFixture.history[selectedChannelId];
      if (fixtureHistory) {
        historyChannelIdRef.current = selectedChannelId;
        historyRef.current = fixtureHistory;
        hasOlderMessagesRef.current = false;
        latestHistorySequenceRef.current = latestSequence(fixtureHistory);
        historyCacheRef.current.set(selectedChannelId, {
          messages: fixtureHistory,
          hasOlderMessages: false,
          cachedAt: Date.now(),
        });
        setHistory(fixtureHistory);
        setHistoryError(null);
        setHasOlderMessages(false);
        setLoadingHistory(false);
        return;
      }
    }

    if (!token || !selectedChannelId) {
      deactivateHistoryRenderAuthority();
      historyChannelIdRef.current = null;
      historyRef.current = [];
      hasOlderMessagesRef.current = false;
      latestHistorySequenceRef.current = 0;
      if (!token) {
        historyCacheRef.current.clear();
        historyRenderAuthoritiesRef.current.clear();
        historyTailBaseGenerationRef.current.clear();
        // The durable per-user store is NOT purged here: a transient token
        // refresh dip must not destroy restart bytes. Real sign-out clears it
        // in logout; user switches clear it on boot.
      }
      setHistory([]);
      setHistoryError(null);
      setHasOlderMessages(false);
      setLoadingHistory(false);
      return;
    }
    if (!selectedChannelKnown) {
      clearChannelHistory(selectedChannelId);
      setHistoryError(null);
      setLoadingHistory(false);
      return;
    }

    let cancelled = false;
    const accessToken = token;
    const channelId = selectedChannelId;
    const readStillCurrent = (): boolean =>
      !cancelled && historyRevisionRef.current === historyRevision &&
      selectedChannelIdRef.current === channelId;
    const renderAuthority: HistoryRenderAuthority | null = user?.id
      ? { userId: user.id, channelId, historyRevision }
      : null;
    const cachedHistory = historyCacheRef.current.get(channelId);
    // sendHumanChannelFocus stamps historyChannelIdRef before the socket
    // send, so "ref !== id" is no longer a reliable enter signal. Hydrate
    // from cache only when the presented rows are not already this channel —
    // otherwise a late setHistory([]) clobbers the socket page that just landed.
    const presentedBelongsToChannel = historyRef.current.length > 0 &&
      historyRef.current.every((entry) => entry.channelId === channelId);
    const enteringChannel = !presentedBelongsToChannel;
    if (historyChannelIdRef.current !== channelId) {
      historyChannelIdRef.current = channelId;
    }
    if (enteringChannel) {
      queueChannelTimelineScroll(channelId);
      const liveFocus = lastHumanFocusRequestRef.current;
      const liveResponse = lastHumanHistoryResponseRef.current;
      const waitingForFocusPage = Boolean(
        liveFocus &&
        liveFocus.channelId === channelId &&
        liveFocus.socket.readyState === WebSocket.OPEN &&
        (!liveResponse ||
          liveResponse.channelId !== channelId ||
          liveResponse.receivedAt < liveFocus.sentAt)
      );
      const initialMessages = cachedHistory?.messages || [];
      const initialHasOlderMessages = cachedHistory?.hasOlderMessages || false;
      if (initialMessages.length === 0 && waitingForFocusPage) {
        // A focus page is already in flight. Do not paint an empty window
        // that can flush after that page and look like "No messages yet."
        setLoadingHistory(true);
      } else {
        historyRef.current = initialMessages;
        hasOlderMessagesRef.current = initialHasOlderMessages;
        latestHistorySequenceRef.current = latestSequence(initialMessages);
        setHistory(initialMessages);
        setHasOlderMessages(initialHasOlderMessages);
        setHistoryError(null);
        setLoadingHistory(false);
        // Previously-opened channels keep an authenticated in-memory page. Authorize
        // it before the async refresh so reopen does not sit on a skeleton for a
        // full Hub RTT (~1–2s).
        if (cachedHistory && renderAuthority && cachedHistory.messages.length > 0) {
          authorizeHistoryRender(renderAuthority);
        }
      }
    } else {
      latestHistorySequenceRef.current = latestSequence(historyRef.current);
    }
    // Read the latest window from the Hub. Any failure keeps the presented
    // rows and the loading state; the periodic and foreground reads retry.
    async function bridgeLatestHistoryOnline(forceRefresh = false): Promise<boolean> {
      const focusAnswered = (): boolean => {
        const focusRequest = lastHumanFocusRequestRef.current;
        const response = lastHumanHistoryResponseRef.current;
        const presented = historyChannelIdRef.current === channelId &&
          (historyRef.current.length > 0 || Boolean(historyCacheRef.current.get(channelId)?.messages.length));
        return (
          focusRequest?.channelId === channelId &&
          focusRequest.socket.readyState === WebSocket.OPEN &&
          response?.channelId === channelId &&
          response.receivedAt >= focusRequest.sentAt &&
          performance.now() - response.receivedAt < HISTORY_REFRESH_INTERVAL_MS &&
          presented
        );
      };
      // The live socket is the primary source for this page: the debounced
      // focus effect makes the Hub push it. On channel entry that request may
      // not have been sent yet, so wait on the connected socket itself rather
      // than only on an already-sent request; the HTTP fetch below is the
      // fallback, not a parallel duplicate.
      const socketWillServe = (): boolean =>
        relaySocketLive() &&
        conversationViewOpen(viewRef.current) &&
        selectedChannelIdRef.current === channelId;
      // A hydrated tail-cache window is revision-proven up to its tail; fill
      // anything after it deterministically over HTTP (empty when fresh)
      // instead of waiting on a socket push that only covers the newest page.
      const manifestGap = productTailCacheGapRef.current.get(channelId);
      if (!forceRefresh && manifestGap === undefined && focusAnswered()) return true;
      if (!forceRefresh && manifestGap === undefined && socketWillServe() &&
          !historyPreloadRef.current.has(historyPreloadKey(accessToken, channelId))) {
        const deadline = performance.now() + (
          historyRef.current.length > 0
            ? HUMAN_SOCKET_HISTORY_PAINTED_GRACE_MS
            : HUMAN_SOCKET_HISTORY_GRACE_MS
        );
        while (readStillCurrent() && performance.now() < deadline && socketWillServe()) {
          if (focusAnswered()) return true;
          await new Promise((resolve) => window.setTimeout(resolve, 8));
        }
        if (focusAnswered()) return true;
        if (!readStillCurrent()) return false;
      }
      try {
        // A tail-contiguous painted window only needs rows after its latest
        // sequence; anything else re-pulls a full latest page.
        const contiguousAfter =
          historyTailContiguous(channelId) &&
          historyRef.current.length > 0 &&
          latestHistorySequenceRef.current > 0
            ? latestHistorySequenceRef.current
            : undefined;
        const afterSequence = forceRefresh ? undefined : manifestGap !== undefined
          ? Math.max(manifestGap, latestHistorySequenceRef.current)
          : contiguousAfter;
        if (afterSequence !== undefined && afterSequence > 0) {
          const newerPage = await fetchChannelHistoryQuery(accessToken, channelId, {
            limit: OLDER_HISTORY_LIMIT,
            afterSequence,
          });
          if (!readStillCurrent()) return false;
          if (!newerPage.hasMore) {
            // Merging never shrinks the window, and passing false keeps the
            // current hasOlderMessages untouched.
            adoptIncrementalHistory(channelId, newerPage.messages, renderAuthority);
            return true;
          }
          // A full incremental page can hide more rows beyond it; the tail is
          // no longer provably contiguous, so resync with a full latest page.
          historyTailBaseGenerationRef.current.delete(channelId);
        }
        const onlinePage = await fetchChannelHistoryQuery(accessToken, channelId, {
          limit: INITIAL_HISTORY_LIMIT,
        });
        if (!readStillCurrent()) return false;
        applyChannelHistory(
          channelId,
          onlinePage.messages,
          onlinePage.hasMore,
        );
        productTailCacheGapRef.current.delete(channelId);
        // This window is now network-authoritative; the hydration stamp
        // barrier only guards windows still made of disk bytes.
        productTailCacheHydratedStampsRef.current.delete(channelId);
        recordHistoryTailBase(channelId);
        if (renderAuthority) authorizeHistoryRender(renderAuthority);
        return true;
      } catch {
        return false;
      }
    }

    async function readLatestHistory(): Promise<void> {
      historyRefreshInFlightRef.current = true;
      try {
        const bridged = await bridgeLatestHistoryOnline();
        if (!readStillCurrent()) return;
        setHistoryError(null);
        setLoadingHistory(!bridged);
      } finally {
        historyRefreshInFlightRef.current = false;
      }
    }

    let foregroundRefreshRunning = false;
    const stopForegroundRefresh = listenForForegroundRefresh(() => {
      if (foregroundRefreshRunning || !readStillCurrent()) return;
      foregroundRefreshRunning = true;
      // A prior focus response cannot prove that nothing was missed during
      // suspension. Fetch an authorized latest page without waiting for ping
      // timeout or the periodic history read.
      void bridgeLatestHistoryOnline(true).then((refreshed) => {
        if (refreshed && readStillCurrent()) {
          setHistoryError(null);
          setLoadingHistory(false);
        }
      }).finally(() => { foregroundRefreshRunning = false; });
    });
    if (!cachedHistory) {
      setLoadingHistory(true);
      // Read the Hub now rather than waiting out the socket's grace period.
      preloadChannelHistory(channelId);
    }
    void readLatestHistory();
    const interval = window.setInterval(() => {
      if (!document.hidden && !historyRefreshInFlightRef.current) void readLatestHistory();
    }, HISTORY_REFRESH_INTERVAL_MS);
    // historyHeadSequence / readSequence intentionally omitted from deps: realtime
    // sends and WS echoes advance those fields on every message. Live watermarks are
    // read from channelsRef; the 30s interval refreshes without canceling painted
    // history on each outbound/inbound message.
    return () => {
      cancelled = true;
      stopForegroundRefresh();
      window.clearInterval(interval);
    };
  }, [
    adoptIncrementalHistory,
    applyChannelHistory,
    authorizeHistoryRender,
    bumpHistoryCacheRevision,
    queueChannelTimelineScroll,
    clearChannelHistory,
    deactivateHistoryRenderAuthority,
    historyTailContiguous,
    productTailCacheHydrationTick,
    purgeProductTailCacheChannel,
    recordHistoryTailBase,
    relaySocketLive,
    historyRevision,
    rememberChannelHistory,
    selectedChannelId,
    selectedChannelAudience,
    syncChannelSummaryFromHistory,
    token,
    user?.id,
    fetchChannelHistoryQuery,
    historyPreloadKey,
    preloadChannelHistory,
    mobileListFixture,
    selectedChannelKnown,
    historyTailBaseGenerationRef,
    productTailCacheGapRef,
    productTailCacheHydratedStampsRef,
  ]);

  const presentedHead = selectedChannelId && history.at(-1)?.channelId === selectedChannelId
    ? latestSequence(history)
    : 0;
  useSelectedChannelHeadCatchUp({
    channelId: token ? selectedChannelId : null,
    knownHead: selectedChannel?.historyHeadSequence,
    presentedHead,
    catchUp: async (channelId, afterSequence) => {
      const accessToken = token;
      const stillOpen = () => selectedChannelIdRef.current === channelId &&
        historyChannelIdRef.current === channelId;
      if (!accessToken || !stillOpen()) return { ok: false, found: 0 };
      const newerPage = await fetchChannelHistoryQuery(accessToken, channelId, {
        limit: OLDER_HISTORY_LIMIT,
        afterSequence,
      });
      if (!stillOpen()) return { ok: false, found: 0 };
      if (newerPage.hasMore) {
        // More rows than one page are missing: replace the tail with the latest page.
        historyTailBaseGenerationRef.current.delete(channelId);
        const latestPage = await fetchChannelHistoryQuery(accessToken, channelId, {
          limit: INITIAL_HISTORY_LIMIT,
        });
        if (!stillOpen()) return { ok: false, found: 0 };
        applyChannelHistory(channelId, latestPage.messages, latestPage.hasMore);
      } else {
        applyChannelHistory(channelId, newerPage.messages, false);
      }
      productTailCacheGapRef.current.delete(channelId);
      productTailCacheHydratedStampsRef.current.delete(channelId);
      recordHistoryTailBase(channelId);
      if (user?.id) {
        authorizeHistoryRender({ userId: user.id, channelId, historyRevision: historyRevisionRef.current });
      }
      return { ok: true, found: newerPage.messages.length };
    },
    onSocketMissedRows: () => relaySocketProbeRef.current?.(),
  });

  const currentSpaceId = resolvedSpaceId;
  const { channelPinState, toggleChannelPinned } = useChannelPins({
    token,
    userId: user?.id,
    spaceId: currentSpaceId,
  });
  const currentSpace = useMemo(
    () => spaces.find((space) => space.id === currentSpaceId) || null,
    [currentSpaceId, spaces]
  );
  /* On a bare entry (no space in the URL), land in the working workspace
     instead of spaces[0]. Explicit deep links (route already carries a space)
     are respected. Wait for the cloud read unless the local mirror already
     gave an answer, so a fresh device doesn't flash the wrong space. */
  useEffect(() => {
    if (workingSpaceRedirectedRef.current) return;
    if (spaces.length === 0) return;
    if (routeSpaceId) {
      workingSpaceRedirectedRef.current = true;
      return;
    }
    if (!workingSpaceId && !workingSpaceLoaded) return;
    workingSpaceRedirectedRef.current = true;
    const target =
      workingSpaceId && spaces.some((space) => space.id === workingSpaceId)
        ? workingSpaceId
        : null;
    if (!target) return;
    setView("messages");
    setSelectedChannelId(null);
    const nextPath = `${spaceAppPath(target, spaces)}/channels`;
    replaceBrowserPath(nextPath);
    setBrowserPath(nextPath);
  }, [routeSpaceId, spaces, workingSpaceId, workingSpaceLoaded]);

  /* Persist the working workspace whenever the user settles in a space
     (explicit switch or channel deep-link), write-through to local + cloud. */
  useEffect(() => {
    if (!currentSpaceId || !user?.id || !token) return;
    if (persistedWorkingSpaceRef.current === currentSpaceId) return;
    persistedWorkingSpaceRef.current = currentSpaceId;
    setWorkingSpaceId(currentSpaceId);
    writeWorkingSpaceCache(user.id, currentSpaceId);
    void persistWorkingSpace(token, currentSpaceId, fetch);
  }, [currentSpaceId, fetch, token, user?.id]);

  useEffect(() => {
    if (!selectedChannel || view !== "messages") return;
    // Browser navigation wins over metadata hydration for the old selection.
    const locationRoute = appRouteInfo(currentBrowserLocation());
    const locationChannel = resolveChannelRouteKey([selectedChannel],
      locationRoute.channelKey || locationRoute.legacyChannelId,
      resolveSpaceRouteKey(spaces, locationRoute.spaceKey));
    if (locationRoute.view !== "messages" || locationChannel?.id !== selectedChannel.id) return;
    const canonicalPath = channelAppPath(selectedChannel, spaces);
    if (currentBrowserLocation() !== canonicalPath) {
      replaceBrowserPath(canonicalPath);
      setBrowserPath(canonicalPath);
    }
  }, [selectedChannel, spaces, view]);

  useEffect(() => {
    if (view === "messages" || !currentSpaceId) return;
    // The Pages view's URL also names the open page and the conversation open
    // beside it, so the pair can be shared.
    const viewPath = appViewPath(selectedChannel, view, currentSpaceId, spaces);
    // Beside a page, the address is what names the conversation: opening and
    // closing one change it, and the selection follows it (also on Back).
    // A list destination's address names its open item the same way.
    const canonicalPath = view === "pages"
      ? pagesViewPath(viewPath, selectedPageId, routeInfo.conversationKey)
      : view === "admin" ? adminViewPath(viewPath, currentBrowserLocation())
      : SPLIT_TOOL_VIEWS.includes(view) ? toolItemPath(viewPath, toolItemSelection(currentBrowserLocation())) : viewPath;
    if (currentBrowserLocation() !== canonicalPath) {
      replaceBrowserPath(canonicalPath);
      setBrowserPath(canonicalPath);
    }
  }, [currentSpaceId, routeInfo.conversationKey, selectedChannel, selectedPageId, spaces, view]);

  useEffect(() => {
    if (
      !desktopBridge ||
      !token ||
      !desktopSetupStatus ||
      desktopSetupStatus.completedAt ||
      desktopSetupAutoOpenRef.current ||
      !currentSpaceId
    ) {
      return;
    }

    desktopSetupAutoOpenRef.current = true;
    setView("local");
    const nextPath = appViewPath(selectedChannel, "local", currentSpaceId, spaces);
    replaceBrowserPath(nextPath);
    setBrowserPath(nextPath);
  }, [currentSpaceId, desktopBridge, desktopSetupStatus, selectedChannel, spaces, token]);

  const humanMemberId = user ? `user:${user.id}` : "";
  // Authority rejects writes on archived channels; keep the composer non-writable.
  const canUseSelectedChannel = Boolean(selectedChannel);
  const agentStatusEvents = useMemo(
    () => [...events, ...agentTraceReplicas.flatMap((replica) => replica.events)],
    [agentTraceReplicas, events]
  );

  const logoutAndClearDeviceData = useCallback(async () => {
    setCachedCatalogChannels([]);
    await productTailCacheStoreRef.current?.clearAll();
    await clearProductMessageAttachmentMediaCache();
    clearChannelHistory();
    await logout();
    router.push("/login");
  }, [clearChannelHistory, logout, productTailCacheStoreRef, router, setCachedCatalogChannels]);

  useEffect(() => {
    void removeRetiredBrowserReplica();
  }, []);

  // Only assemble the search corpus while the dialog is open. Closed search must
  // not flatMap every channel history cache entry on unrelated shell re-renders.
  const workspaceSearchMessages = useMemo(() => {
    // Mobile channel-list has no selected channel; still scan cached tails so
    // message search is not empty while the Hub search is unavailable.
    const assembled = assembleWorkspaceSearchMessages({
      open: workspaceSearchOpen,
      channelIds: channels.map((channel) => channel.id),
      authorizedHistory: renderableHistory,
      historyAuthorized: historyRenderAuthorized,
      historyCache: historyCacheRef.current,
    });
    return assembled.length > 0 ? assembled : EMPTY_CHANNEL_HISTORY;
    // historyCacheRevision versions the mutable historyCacheRef this reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    channels,
    historyCacheRevision,
    historyRenderAuthorized,
    renderableHistory,
    workspaceSearchOpen,
  ]);

  // Message search runs on the Hub over every Channel the reader may read.
  const messageSearch = useMemo<WorkspaceMessageSearch | undefined>(() => {
    if (!token || !currentSpaceId) return undefined;
    return (query, resumeToken) => searchWorkspaceMessages({
      token, spaceId: currentSpaceId, query, resumeToken,
    });
  }, [currentSpaceId, token]);

  const persistComposerDraftSnapshot = useCallback((text: string, invocationDraft?: ComposerInvocationDraft) => {
    draftRef.current = text;
    writeChannelComposerDraft(channelComposerDraftsRef.current, draftChannelIdRef.current, {
      text,
      invocationDraft,
      workspaceTarget: draftWorkspaceTargetValueRef.current,
      attachments: draftAttachmentsRef.current,
    });
  }, []);

  return {
    children,
    fetchChannelHistoryQuery,
    user,
    loading,
    token,
    authenticatedUserId,
    mobileListFixture,
    setBrowserPath,
    routeInfo,
    desktopBridge,
    desktopUpdateBridgeAvailable,
    knownDesktopEventIdsRef,
    nativeNotifiedMessageIdsRef,
    latestHistorySequenceRef,
    historyCacheRef,
    relayPushConnectedRef,
    relaySocketRef,
    reconcileUnconfirmedOnReconnectRef,
    lastHumanFocusRequestRef,
    selectedChannelIdRef,
    historyChannelIdRef,
    viewRef,
    historyRef,
    hasOlderMessagesRef,
    agentTraceHistoryBootstrapRef,
    accessTokenRef,
    channelsRef,
    spacesRef,
    historyRefreshInFlightRef,
    timelineScrollRef,
    messagesEndRef,
    timelineActiveRef,
    timelinePinnedToBottomRef,
    timelineScrollTopRef,
    timelineBottomStickUntilRef,
    timelineBottomStickCleanupRef,
    previousTimelineLengthRef,
    lastTimelineScrollTargetRef,
    pendingChannelScrollRef,
    pendingMessageJumpRef,
    messageJumpSeekInFlightRef,
    messageJumpSeekAttemptedRef,
    messageJumpRevision,
    bumpMessageJumpRevision,
    desktopCliSessionSyncTokenRef,
    channelComposerDraftsRef,
    draftChannelIdRef,
    draftWorkspaceTargetValueRef,
    view,
    setView,
    browserHash,
    setBrowserHash,
    timelineJumpRef,
    landMessageJump,
    settleMessageJump,
    highlightedMessageId,
    armMessageJumpHighlight,
    queueMessageJump,
    channels,
    setChannels,
    spaces,
    setSpaces,
    projects,
    setProjects,
    automations,
    setAutomations,
    automationExecutionEnabled,
    scheduleFocusId,
    setScheduleFocusId,
    events,
    setEvents,
    agentTraceReplicas,
    setAgentTraceReplicas,
    agents,
    machineDaemons,
    channelReadCounts,
    setChannelReadCounts,
    channelMentionClearedAt,
    channelPinState,
    channelReadCountsBaselineReady,
    setChannelReadCountsBaselineReady,
    selectedChannelId,
    setSelectedChannelId,
    selectedPageId,
    setSelectedPageId,
    setPendingExplicitSpaceId,
    isMobileViewportRef,
    toggleChannelPinned,
    runMobileScreenTransition,
    setWorkingSpaceId,
    history,
    historyCacheRevision,
    historyRevision,
    loadingWorkspace,
    setLoadingWorkspace,
    loadingHistory,
    setLoadingHistory,
    olderLoading,
    setOlderLoading,
    hasOlderMessages,
    stoppingAgentInstanceId,
    setStoppingAgentInstanceId,
    reborningAgentInstanceId,
    setReborningAgentInstanceId,
    handingOffAgentInstanceId,
    setHandingOffAgentInstanceId,
    agentInstanceStopRequest,
    setAgentInstanceStopRequest,
    renamingChannelId,
    setRenamingChannelId,
    updatingChannelVisibilityId,
    setUpdatingChannelVisibilityId,
    outgoingMessages,
    setOutgoingMessages,
    outboundClientIdsByMessageIdRef,
    outboundPreviewByClientIdRef,
    outgoingMessagesRef,
    error,
    setError,
    historyError,
    setHistoryError,
    agentsError,
    setAgentsError,
    spacesError,
    setSpacesError,
    mobileChannelDetailsOpen,
    setMobileChannelDetailsOpen,
    desktopContext,
    setDesktopContext,
    desktopDaemonStatus,
    setDesktopDaemonStatus,
    desktopUpdateStatus,
    setDesktopUpdateStatus,
    desktopSetupStatus,
    setDesktopSetupStatus,
    agentPresetDiscoveries,
    setAgentPresetDiscoveries,
    loadingAgentPresetDiscoveries,
    setLoadingAgentPresetDiscoveries,
    localActionBusy,
    setLocalActionBusy,
    localActionError,
    setLocalActionError,
    automationBusy,
    setAutomationBusy,
    automationError,
    setAutomationError,
    automationLoadError,
    loadingAutomations,
    runtimeCheck,
    setRuntimeCheck,
    checkingDesktopUpdates,
    setCheckingDesktopUpdates,
    draft,
    composerDraftSeedRevision,
    mentionInsertRequest,
    setMentionInsertRequest,
    composerAutoFocusRequest,
    setComposerAutoFocusRequest,
    draftWorkspaceTarget,
    setDraftWorkspaceTarget,
    draftAttachments,
    setDraftAttachments,
    replyTarget,
    setReplyTarget,
    draftRef,
    draftAttachmentsRef,
    replyTargetRef,
    replyTargetHistoryRevisionRef,
    seedComposerDraftText,
    agentTraceTarget,
    setAgentTraceTarget,
    agentTraceHistoryPanelState,
    setAgentTraceHistoryPanelState,
    agentTraceHistoryBootstrapRevision,
    cancelAgentTraceHistoryBootstrap,
    reconcileAgentTraceChannelAccess,
    agentConfigDialog,
    setAgentConfigDialog,
    agentConfigForm,
    setAgentConfigForm,
    savingAgentConfig,
    setSavingAgentConfig,
    deletingAgentId,
    setDeletingAgentId,
    composingConversation,
    setComposingConversation,
    channelMoveOpen,
    setChannelMoveOpen,
    channelMoveTargetSpaceId,
    setChannelMoveTargetSpaceId,
    movingChannelId,
    setMovingChannelId,
    channelMoveError,
    setChannelMoveError,
    channelQuickOpen,
    setChannelQuickOpen,
    workspaceSearchOpen,
    setWorkspaceSearchOpen,
    isMobileViewport,
    renamingSpaceId,
    setRenamingSpaceId,
    newSpaceName,
    setNewSpaceName,
    creatingSpace,
    setCreatingSpace,
    desktopSidebarWidth,
    resizingDesktopSidebar,
    startDesktopSidebarResize,
    handleDesktopSidebarResizeKey,
    authorizeHistoryRender,
    mergeAndRememberChannelHistory,
    queueChannelTimelineScroll,
    markChannelReadToSequence,
    handleTimelineMessageExposed,
    applyChannelHistory,
    cachedCatalogChannels,
    recordHistoryTailBase,
    routeSpaceId,
    routeChannelId,
    markNativeMessageNotified,
    openWorkspaceSearch,
    selectedChannel,
    historyRenderAuthorized,
    startupBackgroundReady,
    startupCatalogKey,
    setSettledStartupCatalogKey,
    renderableHistory,
    currentSpaceId,
    currentSpace,
    humanMemberId,
    canUseSelectedChannel,
    agentStatusEvents,
    logoutAndClearDeviceData,
    workspaceSearchMessages,
    messageSearch,
    persistComposerDraftSnapshot,
  };
}
export type WorkspaceShellState = ReturnType<typeof useWorkspaceShellState>;
