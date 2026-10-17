"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { AnimationActivityScope } from "@/components/ui/decoration-animation";
import { ChannelTransferQueue } from "./channel-transfer-queue";
import { spaceRoleFor as transferSpaceRole } from "./workspace-shell-recovered";

import type {
} from "@/lib/desktop/bridge";

import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties,
} from "react";
import { useStableCallback } from "./workspace-shell-helpers";
import { CrossSpaceReadCard, useChannelPendingCrossSpaceReads } from "./cross-space-read-card";
import { useQueries } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

import { AttachmentDropZoneProvider } from "./composer-attachment-drop-zone";
import { realtimeCollectionAny } from "./realtime-collection";
import { RealtimeChannelsContext, RealtimeEventsContext } from "./realtime-channels";
import { PresentedChannelTailContext } from "./presented-channel-tail";
import { channelReferences, MessageReferenceCatalogProvider, type ChannelReference, type MessageReferenceCatalog } from "./message-reference-catalog";
import { MachineLinkProvider, type MachineLinks } from "./machine-link";
import { sameValue } from "../../lib/same-value";
import { ManageSecretsProvider } from "./secret-request-card";
import { machinesInSpace, spaceChannelIdSet } from "./space-scoped-tool-content";
import { channelHasWorkInHand } from "./workspace-shell-chrome";
import { useAndroidBackHandler } from "./use-android-back";
import { Loader2, Maximize2, X } from "lucide-react";
import { LiquidGlassFilter } from "@/components/ui/liquid-glass-filter";
import { writeChannelComposerDraft } from "@/components/dashboard/channel-composer-drafts";
import {
  decideSpaceJoinRequest,
  spaceJoinRequestsQueryOptions,
} from "@/components/dashboard/space-join-requests";
import { canInviteToSpace } from "@/components/dashboard/workspace-shell-recovered";
import { issueReportUrl } from "@/lib/issue-report";
import { channelSidebarError } from "@/components/dashboard/workspace-sidebar-error";
import { ConnectorActionApproval, useConnectorActionApprovals } from "./connector-action-approval";
import { ChannelApprovalsDock } from "./channel-approvals-dock";
import { humanProfileFromSpaceMember } from "@/components/dashboard/human-profile-summary";

import {
  AgentConfigPage,
  AgentInstanceDetailWindow,
  AgentWorkDetailsDock,
  ChannelDetails,
  ChannelHeader,
  ChannelMoveDialog,
  ChannelSidebar,
  Composer,
  GlobalSearchBar,
  DesktopUpdateRailButton,
  DesktopUpdateRestartDialog,
  MessageTimeline,
  MobileChannelChatList,
  CreateFab,
  MobileTabDock,
  ToolSurface,
  MobileChannelSummaryPlaque,
  TopWorkspaceBar,
  WorkspaceRail,
  channelHasAgentMembers,
  latestChannelConnectorStateMessageId,
  replaceChannel,
  replaceWorkspace,
  registerWorkspace,
  sortProjects,
  usePendingChannelNavigation,
  CONVERSATION_QUERY,
  useChannelCatalogPaging,
  ColdStartChannelCatalog,
} from "./workspace-shell-modules";
import { userErrorMessage } from "@/lib/user-facing-error";
import { usePlatformAdminCapability } from "./use-platform-admin-capability";
import { spaceAgentSetupState } from "./space-agent-setup";
import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { registrationListed } from "./my-agents-registrations";
import { registrationTupleId } from "./use-registration-command";
import { AGENT_PRESETS, WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { harnessSpaceKey } from "./harness-space-switch";
import { useInstalledHarnesses } from "./use-installed-harnesses";
import { SpaceAgentSetupCard } from "./space-agent-setup-card";
import { composeFirstTaskMessage, spaceFirstTaskState } from "./space-first-task";
import {
  reviewChosenWorkspace,
  type ChosenWorkspace,
} from "./space-first-task-choose-workspace";
import { SpaceFirstTaskCard } from "./space-first-task-card";
import { ListCreate, type CreateAction } from "./list-create";
import { NewConversation } from "./new-conversation";
import { startConversation } from "./start-conversation";
import type { WorkspaceShellModel } from "./use-workspace-shell-actions";
import { ListColumnResizeHandle, ListColumnResizeProvider } from "./list-column-resize";
import { mobileBackState, DOCK_TAB_VIEWS, MORE_TAB_VIEWS, SPLIT_TOOL_VIEWS, viewForRouteSegment, type AppView } from "./workspace-shell-navigation";
import { PageTreePanel, PagesView, usePageTree } from "@/components/pages/pages-view";
import { NEW_PAGE_ID, NEW_PAGE_TITLE, usePageCreation } from "@/components/pages/page-creation";
import { PageDraft } from "@/components/pages/page-draft";
import { searchWorkspacePages } from "./workspace-message-search";
import { channelTitle } from "@/components/dashboard/channel-links";
import { WorkspaceSearchDialog, WorkspaceSearchView } from "./workspace-search";
import { searchRequestFromParams, searchRequestParams, type SearchFilters } from "./workspace-search-model";
import { parseAppLocation } from "./workspace-shell-navigation";
import { ConversationPageCards } from "@/components/pages/conversation-page-cards";

/**
 * The dock tab that owns a view. Pages, Channels and Status own themselves;
 * every other tool view lives behind More. A phone keeps one mounted pane per
 * dock tab, chosen with this, so the panes stay orthogonal to one another
 * instead of sharing a single screen and swapping their contents.
 */
function dockTabOf(view: AppView): AppView {
  return view === "pages" || view === "messages" || view === "status" ? view : "more";
}

/** The search dialog's pages while the tree has not been read: one array, so the dialog keeps its memo. */
const NO_PAGES: NonNullable<ReturnType<typeof usePageTree>["data"]> = [];

export function WorkspaceShellView({ model }: { model: WorkspaceShellModel }) {
  const [desktopUpdateConfirmOpen, setDesktopUpdateConfirmOpen] = useState(false);
  const [pageConversationDocked, setPageConversationDocked] = useState(false);
  const {
    children,
    user,
    loading,
    token,
    routeInfo,
    browserPath,
    desktopBridge,
    desktopUpdateBridgeAvailable,
    channelsRef,
    timelineScrollRef,
    timelineJumpRef,
    bumpMessageJumpRevision,
    messagesEndRef,
    channelComposerDraftsRef,
    draftChannelIdRef,
    draftWorkspaceTargetValueRef,
    view,
    highlightedMessageId,
    channels,
    setChannels,
    spaces,
    projects,
    setProjects,
    automations,
    automationExecutionEnabled,
    scheduleFocusId,
    events,
    agentTraceReplicas,
    agents,
    machineDaemons,
    channelReadCounts,
    channelMentionClearedAt,
    channelPinState,
    channelReadCountsBaselineReady,
    selectedChannelId,
    setSelectedChannelId,
    selectedPageId,
    toggleChannelPinned,
    markChannelResponded,
    historyRevision,
    loadingWorkspace,
    startupBackgroundReady,
    startupCatalogKey,
    setSettledStartupCatalogKey,
    loadingHistory,
    olderLoading,
    hasOlderMessages,
    stoppingAgentInstanceId,
    reborningAgentInstanceId,
    handingOffAgentInstanceId,
    renamingChannelId,
    updatingChannelVisibilityId,
    error,
    historyError,
    agentsError,
    spacesError,
    mobileChannelDetailsOpen,
    desktopContext,
    desktopDaemonStatus,
    desktopUpdateStatus,
    desktopSetupStatus,
    agentPresetDiscoveries,
    loadingAgentPresetDiscoveries,
    localActionBusy,
    localActionError,
    automationBusy,
    automationError,
    automationLoadError,
    loadingAutomations,
    runtimeCheck,
    checkingDesktopUpdates,
    draft,
    composerDraftSeedRevision,
    mentionInsertRequest,
    composerAutoFocusRequest,
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
    agentTraceTarget,
    agentTraceHistoryPanelState,
    agentConfigDialog,
    setAgentConfigDialog,
    agentConfigForm,
    setAgentConfigForm,
    savingAgentConfig,
    composingConversation,
    setComposingConversation,
    channelMoveOpen,
    setChannelMoveOpen,
    channelMoveTargetSpaceId,
    setChannelMoveTargetSpaceId,
    movingChannelId,
    channelMoveError,
    setChannelMoveError,
    workspaceSearchOpen,
    workspaceSearchHere,
    setWorkspaceSearchOpen,
    isMobileViewport,
    renamingSpaceId,
    creatingSpace,
    desktopSidebarWidth,
    resizingDesktopSidebar,
    startDesktopSidebarResize,
    handleDesktopSidebarResizeKey,
    handleTimelineMessageExposed,
    routeChannelId,
    openWorkspaceSearch,
    selectedChannel,
    historyRenderAuthorized,
    renderableHistory,
    currentSpaceId,
    currentSpace,
    humanMemberId,
    canUseSelectedChannel,
    logoutAndClearDeviceData,
    messageSearch,
    persistComposerDraftSnapshot,
    handleTimelineScrollPositionChange,
    handleTimelineScrollGesture,
    handleTimelineNearTop,
    handleTimelineReact,
    handleTimelineEdit,
    handleTimelineRecall,
    handleTimelineUnsentAction,
    handleTimelineReply,
    handleTimelineJumpToMessage,
    handleTimelineOpenThread,
    handleTimelineDiscussPassage,
    handleTimelineMentionSender,
    handleTimelineRebornSender,
    handleTimelineQuestionnaireAnswer,
    handleTimelineOpenInternalAppLink,
    timeline,
    selectedThreadRootContext,
    openAgentTrace,
    openHumanProfile,
    profileUserId,
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
    runAutomation,
    updateAutomation,
    deleteAutomation,
    openLocalAgentDiscovery,
    changeAppView,
    openSearchResults,
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
    sendChannelMessage,
    desktopFrameClass,
    cachedCatalogChannels,
  } = model;
  // A downloaded update restarts the app, so it is confirmed first; an
  // "available" one from older shells only starts a download.
  const requestDesktopUpdateInstall = () => {
    if (desktopUpdateStatus?.state === "downloaded") setDesktopUpdateConfirmOpen(true);
    else void installDesktopUpdate();
  };

  // One Space today; the seam is plural so a second Space is another entry
  // here rather than another shell.
  const loadedSpaceIds = useMemo(
    () => (currentSpaceId ? [currentSpaceId] : []),
    [currentSpaceId],
  );
  const channelCatalogPaging = useChannelCatalogPaging({
    token,
    backgroundReady: startupBackgroundReady,
    spaceIds: loadedSpaceIds,
    routeSpaceId: currentSpaceId,
    routeChannelId,
    routeChannelKey: routeInfo.channelKey || routeInfo.legacyChannelId || routeInfo.conversationKey,
    channels,
    setChannels,
    liveChannel: model.realtimeChannels.get,
    promoteCatalog: model.realtimeChannels.promote,
    viewerReads: model.viewerReadsOf,
    setSelectedChannelId,
  });
  const currentSpaceCatalog = channelCatalogPaging.forSpace(currentSpaceId);
  const startupRootPage = currentSpaceCatalog.page(CONVERSATION_QUERY);
  useEffect(() => {
    // Explicit list loads remain foreground work while catalog counts, branch
    // speculation and other domains wait. Empty/error results must also release.
    if (currentSpaceId && (startupRootPage.loaded || startupRootPage.error)) {
      setSettledStartupCatalogKey(startupCatalogKey);
    }
  }, [currentSpaceId, startupCatalogKey, startupRootPage.loaded, startupRootPage.error,
    setSettledStartupCatalogKey]);

  // Provisional catalog rows are tappable, so a tap on one is queued until the
  // complete catalog authorizes the channel instead of being dropped.
  const { requestChannelNavigation, pendingChannelNavigationId } =
    usePendingChannelNavigation(channels, channelsRef, navigateToChannel);

  // Scoped and disk catalog rows are presentation-only until the complete
  // authenticated network catalog arrives. Authority-sensitive state and
  // actions continue to use `channels`; only the list surfaces receive these
  // fallbacks. The scoped response wins over disk because it is fresh for the
  // current Space, but it still cannot prove another Space's channel is absent.
  const onboardingCatalog = currentSpaceCatalog.page(CONVERSATION_QUERY);
  const channelsLoaded = Boolean(token && currentSpaceId) && !loadingWorkspace &&
    onboardingCatalog.loaded && !onboardingCatalog.loading && !onboardingCatalog.error;
  const registrationCatalog = useAgentRegistrationCatalog(currentSpaceId ?? "", token ?? "",
    Boolean(token && currentSpaceId));
  const spaceAgents = useMemo(
    () => (registrationCatalog.data?.registrations ?? []).filter(registrationListed)
      .map((registration) => ({ id: registrationTupleId(registration.key), name: registration.displayName,
        spaceId: registration.key.spaceId })),
    [registrationCatalog.data],
  );
  const installedFleet = useInstalledHarnesses(currentSpaceId, token, user?.id, channelsLoaded && !selectedChannel);
  const [bringingLocal, setBringingLocal] = useState(false);
  const bringingLocalLock = useRef(false);
  async function enableLocalHarnesses(presetIds: string[]) {
    if (bringingLocalLock.current || !currentSpaceId || !user || !desktopContext?.machineId) return;
    bringingLocalLock.current = true;
    setBringingLocal(true);
    try {
      for (const presetId of presetIds) {
        const preset = AGENT_PRESETS.find((candidate) => candidate.id === presetId);
        if (preset && !(await installedFleet.set(harnessSpaceKey(currentSpaceId, user.id, desktopContext.machineId, presetId), preset, true))) break;
      }
    } finally { bringingLocalLock.current = false; setBringingLocal(false); }
  }
  const keepHarnessSetup = installedFleet.enablingAll || bringingLocal ||
    Boolean(installedFleet.error && installedFleet.candidates.length > 0);
  const agentsLoaded = Boolean(token) && !loadingWorkspace && registrationCatalog.isSuccess;
  const spaceAgentsUnreachable = registrationCatalog.isError;
  // A Space's agents are its registrations, so a Space with none cannot do
  // anything yet - that is the screen a new account lands on, and the same one
  // every newly created Space starts from. It replaces the bare "No conversations yet"
  // empty state with what this machine already has.
  const spaceAgentSetup = useMemo(
    () => spaceAgentSetupState({
      channelsLoaded,
      agentsLoaded,
      spaceAgentsUnreachable,
      spaceAgentCount: keepHarnessSetup ? 0 : (registrationCatalog.data?.registrations ?? []).filter((registration) => registration.state === "enabled").length,
      desktopAvailable: Boolean(desktopBridge),
      discoveryAvailable: Boolean(desktopBridge?.discoverAgentPresets),
      loadingDiscoveries: loadingAgentPresetDiscoveries,
      daemonStatus: desktopDaemonStatus,
      discoveries: agentPresetDiscoveries,
    }),
    [
      agentPresetDiscoveries,
      registrationCatalog.data,
      keepHarnessSetup,
      desktopBridge,
      desktopDaemonStatus,
      loadingAgentPresetDiscoveries,
      channelsLoaded,
      agentsLoaded,
      spaceAgentsUnreachable,
    ]
  );
  const spaceChannelCount = currentSpaceId
    ? Math.max(onboardingCatalog.rows.length,
      channels.filter((channel) => channel.spaceId === currentSpaceId).length)
    : channels.length;
  // Once an agent is bound the shell would fall back to "No conversations yet",
  // which can only point at New conversation. Sending the first task is what
  // creates the first one.
  const spaceFirstTask = useMemo(
    () => spaceFirstTaskState({
      channelsLoaded,
      agentsLoaded,
      spaceAgents,
      spaceChannelCount,
      spaceId: currentSpaceId,
      folderPickerAvailable: Boolean(desktopBridge?.chooseWorkspaceDirectory),
    }),
    [spaceAgents, spaceChannelCount, currentSpaceId, desktopBridge, channelsLoaded, agentsLoaded]
  );
  /* A new person's personal Space opens with the conversation in which
     xMatrix tells them how to bring their agents in (index-routes-welcome.ts).
     The Hub decides whether this Space gets one; while it answers, the empty
     Space shows nothing rather than a screen about to be replaced. */
  const [welcomeRequest, setWelcomeRequest] = useState<{ spaceId: string; pending: boolean } | null>(null);
  const welcomeSpaceId = token && channelsLoaded && agentsLoaded && spaceChannelCount === 0 ? currentSpaceId : null;
  useEffect(() => {
    if (!welcomeSpaceId || !token || welcomeRequest?.spaceId === welcomeSpaceId) return;
    setWelcomeRequest({ spaceId: welcomeSpaceId, pending: true });
    void xmatrixApiRequest<{ channelId: string | null }>({
      url: WEB_PROXY_ROUTES.space_welcome(welcomeSpaceId), token, method: "POST",
    }).then(({ channelId }) => {
      if (!channelId) return;
      void currentSpaceCatalog.load(CONVERSATION_QUERY, { force: true });
      // A phone lists it; a wider screen opens it.
      if (!isMobileViewport) requestChannelNavigation(channelId);
    }).catch((error: unknown) => {
      console.warn("[xmatrix] welcome conversation unavailable", error);
    }).finally(() => setWelcomeRequest({ spaceId: welcomeSpaceId, pending: false }));
  }, [welcomeSpaceId, token, welcomeRequest?.spaceId, currentSpaceCatalog, isMobileViewport, requestChannelNavigation]);
  const welcomePending = Boolean(welcomeRequest?.pending && welcomeRequest.spaceId === currentSpaceId);
  // Only on the empty first screen: an open conversation is never covered.
  const showSpaceAgentSetup = (spaceAgentSetup.kind !== "hidden" || keepHarnessSetup) && !selectedChannel && !welcomePending;
  /* A failed read is not onboarding: it reads on the tool pages' paper, since
     wood carries only liquid glass and this screen has none. */
  const showSpaceFirstTask =
    !showSpaceAgentSetup && spaceFirstTask.kind !== "hidden" && !selectedChannel;
  const [firstTaskBusy, setFirstTaskBusy] = useState(false);
  const [firstTaskError, setFirstTaskError] = useState<string | null>(null);
  const [firstTaskWorkspace, setFirstTaskWorkspace] = useState<ChosenWorkspace | null>(null);

  async function chooseFirstTaskWorkspace() {
    if (!token || !desktopBridge?.chooseWorkspaceDirectory) return;
    setFirstTaskBusy(true);
    setFirstTaskError(null);
    try {
      const outcome = reviewChosenWorkspace(await desktopBridge.chooseWorkspaceDirectory());
      if (outcome.kind === "cancelled") return;
      if (outcome.kind === "rejected") {
        setFirstTaskError(outcome.reason);
        return;
      }
      // Registering is what authorises the daemon to launch there at all.
      const registered = await registerWorkspace(token, outcome.workspace);
      setProjects((current) => sortProjects(replaceWorkspace(current, registered)));
      setFirstTaskWorkspace(outcome.workspace);
    } catch (err) {
      setFirstTaskError(userErrorMessage(err, "Couldn't use that folder"));
    } finally {
      setFirstTaskBusy(false);
    }
  }

  async function startFirstTask(message: string) {
    if (!token || !user || !currentSpaceId) return;
    if (spaceFirstTask.kind !== "needs-workspace" || !firstTaskWorkspace) return;
    const composed = composeFirstTaskMessage({
      workspacePath: firstTaskWorkspace.canonicalCwd,
      message,
    });
    if (!composed.ok) {
      setFirstTaskError(composed.reason);
      return;
    }
    setFirstTaskBusy(true);
    setFirstTaskError(null);
    try {
      const channel = await startConversation({
        token,
        spaceId: currentSpaceId,
        memberName: user.name || user.email || "Human",
        body: composed.body,
      });
      setChannels((current) => replaceChannel(current, channel));
      navigateToChannel(channel.id);
    } catch (err) {
      setFirstTaskError(userErrorMessage(err, "Couldn't start the conversation"));
    } finally {
      setFirstTaskBusy(false);
    }
  }
  // Operator surface is offered only to the Hub allowlist; the admin route
  // re-checks the same allowlist on every read.
  const platformAdmin = usePlatformAdminCapability(token);
  const isIOSNativeShell = desktopBridge?.client === "ios" || desktopBridge?.platform === "ios";
  // Every phone keeps its dock roots mounted, so tapping a tab slides between
  // pages that are already painted. The phone app had this and mobile web did
  // not, which made the two clients behave differently on the same screen size;
  // the app is the reference, so the browser follows it.
  const mobileDockPager = isMobileViewport
    || isIOSNativeShell
    || desktopBridge?.client === "android"
    || desktopBridge?.platform === "android";
  // A phone keeps one mounted pane per dock tab, so switching tabs is
  // orthogonal: each tab's screen stays as it was instead of being rebuilt. A
  // tab's pane mounts the first time it is shown and then stays. Pages is not
  // mounted at startup because its tree prefetches page documents.
  const [mountedDockTabs, setMountedDockTabs] = useState<AppView[]>(() => [dockTabOf(view)]);
  useEffect(() => {
    const tab = dockTabOf(view);
    setMountedDockTabs((current) => current.includes(tab) ? current : [...current, tab]);
  }, [view]);
  const dockTabMounted = (tab: AppView) => tab === dockTabOf(view) || mountedDockTabs.includes(tab);
  const mobileDockSlot = DOCK_TAB_VIEWS.indexOf(dockTabOf(view));
  const isMobileDockView = view === "messages" || view === "more";
  // A conversation and a new one are pushed screens over the dock track.
  const mobileDockCovered = view === "messages" && (Boolean(selectedChannel) || composingConversation);
  // What the shell holds live about a conversation linked to a page (pages-live-document.md §4.4).
  const pageConversation = useCallback(
    (conversationId: string) => channels.find((channel) => channel.id === conversationId) ?? null,
    [channels],
  );
  // A phone's page is a pushed screen like a conversation: its back bar
  // replaces the dock, and its details are one more screen.
  const phonePageOpen = isMobileViewport && view === "pages" && Boolean(selectedPageId);
  // On a phone, a conversation opened from a page is a screen pushed over it; the page stays where it was.
  const phonePageConversation = phonePageOpen && Boolean(selectedChannel);
  const pageTree = usePageTree(currentSpaceId, token ?? "");
  const searchPages = useMemo(() => {
    if (!token || !currentSpaceId) return undefined;
    return (query: string) => searchWorkspacePages({ token, spaceId: currentSpaceId, query });
  }, [currentSpaceId, token]);
  const searchRequest = useMemo(() => searchRequestFromParams(parseAppLocation(browserPath).searchParams), [browserPath]);
  // ⌘F searches where the reader is: inside a conversation, only that conversation.
  const searchHereFilters = useMemo<SearchFilters>(() => workspaceSearchHere && view === "messages" && selectedChannel
    ? { channel: { id: selectedChannel.id, label: channelTitle(selectedChannel) } }
    : {}, [selectedChannel, view, workspaceSearchHere]);
  const pageCreation = usePageCreation(currentSpaceId, token ?? "", openPage);
  // A `page:<id>#<section>` chip opens the page at that section; a new seq scrolls there again.
  const [pageSectionRequest, setPageSectionRequest] =
    useState<{ pageId: string; blockId: string; seq: number } | null>(null);
  const openPageAt = useStableCallback((pageId: string, blockId?: string | null) => {
    openPage(pageId);
    setPageSectionRequest((current) => blockId ? { pageId, blockId, seq: (current?.seq ?? 0) + 1 } : null);
  });
  // `#` completion and `channel:<id>` chips read the channels this reader can see.
  const navigateToChannelRef = useRef(navigateToChannel);
  navigateToChannelRef.current = navigateToChannel;
  // One catalog while what references show of the channels is the same (channelReferences).
  const channelReferencesRef = useRef<readonly ChannelReference[]>([]);
  const referenceChannels = useMemo(
    () => (channelReferencesRef.current = channelReferences(channelReferencesRef.current, channels)),
    [channels],
  );
  const messageReferenceCatalog = useMemo<MessageReferenceCatalog>(() => ({
    channels: referenceChannels,
    onOpenChannel: (channelId) => navigateToChannelRef.current(channelId),
  }), [referenceChannels]);
  const changeAppViewRef = useRef(changeAppView);
  changeAppViewRef.current = changeAppView;
  // The Machines the Machines view lists for this Space, scoped the same way, so
  // a Machine tag only links where that view has the Machine's page.
  // One value while the Machines are the same: a message changes `channels`, not them.
  const machineTargetsRef = useRef<MachineLinks["machines"]>([]);
  const machineTargets = useMemo(() => {
    const targets = machinesInSpace(machines, spaceChannelIdSet(channels, currentSpaceId), { ownerUserId: user?.id })
      .flatMap((machine) => machine.machineId ? [{ machineId: machine.machineId, ownerUserId: machine.daemon?.userId }] : []);
    if (!sameValue(machineTargetsRef.current, targets)) machineTargetsRef.current = targets;
    return machineTargetsRef.current;
  }, [channels, currentSpaceId, machines, user?.id]);
  const machineLinks = useMemo<MachineLinks>(() => ({
    machines: machineTargets,
    onOpenMachine: (machineId) => changeAppViewRef.current("machines", machineId),
  }), [machineTargets]);
  const manageSecrets = useCallback(() => changeAppViewRef.current("settings", "secrets"), []);
  // The route owns whether a page is open; its tree entry may arrive later.
  // Keep the back bar and its content spacing while the title is loading.
  const openedPage = phonePageOpen
    ? selectedPageId === NEW_PAGE_ID ? { title: NEW_PAGE_TITLE }
      : pageTree.data?.find((page) => page.pageId === selectedPageId) ?? { title: "Page" }
    : null;
  // A conversation, a new one and an open page are pushed screens: their back bar replaces the dock.
  const nativeMobileTabVisible = !loading && Boolean(user) &&
    !(view === "messages" && (Boolean(selectedChannelId) || composingConversation)) && !phonePageOpen;
  /* Someone waiting for approval is invisible until an admin opens the Team
     page, so the count rides the rail. Only the current Space is asked, and
     only when this person administers it: the Hub refuses the rest, and
     counting refusals as zero would be indistinguishable from nobody waiting. */
  const administeredSpaceIds = useMemo(
    () => [...new Set(spaces
      .filter((space) =>
        space.id === currentSpaceId &&
        user &&
        canInviteToSpace(space, user.id)
      )
      .map((space) => space.id))]
      .sort(),
    [currentSpaceId, spaces, user],
  );
  const joinRequestQueries = useQueries({
    queries: administeredSpaceIds.map((spaceId) => spaceJoinRequestsQueryOptions({
      token,
      userId: user?.id ?? "",
      spaceId,
      enabled: view === "team",
    })),
  });
  const joinRequestsBySpace = Object.fromEntries(joinRequestQueries.flatMap((query, index) =>
    query.data ? [[administeredSpaceIds[index]!, query.data]] : [],
  ));
  const pendingJoinRequestCount = administeredSpaceIds.reduce((total, spaceId, index) => {
    const loadedRequests = joinRequestQueries[index]?.data;
    const count = view === "team" && loadedRequests
      ? loadedRequests.length
      : spaces.find((space) => space.id === spaceId)?.pendingJoinRequestCount ?? 0;
    return total + count;
  }, 0);
  // Status pulses while any conversation in this Space has an Agent at work.
  const workIndicator = useMemo(() => {
    const eventViews = model.realtimeEventViews;
    const eventSnapshot = eventViews.getSnapshot();
    const indicator = realtimeCollectionAny(model.realtimeChannels,
      channel => (!currentSpaceId || channel.spaceId === currentSpaceId) &&
        channelHasWorkInHand(channel, eventViews.get(channel.id)?.events ?? eventViews.get("")?.events ?? []));
    return { ...indicator, subscribe: (notify: () => void) => {
      const channels = indicator.subscribe(notify);
      const events = eventViews.subscribeChanges(keys => indicator.invalidate(keys.includes("")
        ? model.realtimeChannels.getSnapshot().map(channel => channel.id) : keys));
      if (eventSnapshot !== eventViews.getSnapshot()) indicator.invalidate(model.realtimeChannels.getSnapshot().map(channel => channel.id));
      return () => { channels(); events(); };
    } };
  }, [model.realtimeChannels, model.realtimeEventViews, currentSpaceId]);
  const statusLive = useSyncExternalStore(workIndicator.subscribe, workIndicator.getSnapshot, workIndicator.getSnapshot);

  /* Stable identities. These are handed down through memoised subtrees, so a
     fresh closure on every render would re-render them for changes that have
     nothing to do with join requests. */
  const resolveSpaceJoinRequest = useCallback(
    (spaceId: string, requestId: string, approve: boolean) =>
      decideSpaceJoinRequest({ token, spaceId, requestId, approve }),
    [token],
  );


  /* Feedback is a public GitHub issue; the form's Environment field says
     which client and version it came from. */
  function openIssueReport() {
    const client = desktopBridge
      ? `${desktopBridge.client || "desktop"} ${desktopContext?.platform || desktopBridge.platform || ""} ${desktopContext?.version || ""}`
      : `web ${process.env.NEXT_PUBLIC_XMATRIX_WEB_BUILD_ID?.trim() || ""}`;
    const url = issueReportUrl(client.replace(/\s+/g, " ").trim());
    if (desktopBridge?.openExternal) void desktopBridge.openExternal(url);
    else window.open(url, "_blank", "noopener");
  }

  /* The mobile list has no Space membership of its own to derive this from. */
  const canCreateChannel = Boolean(user && currentSpace);
  const canMovePages = Boolean(currentSpace && user &&
    ["owner", "admin"].includes(transferSpaceRole(currentSpace, user.id) || ""));
  // Both clients lead to the same action; each controls where it is visible.
  const startNewConversation = useStableCallback(() => openNewConversation());
  const createNewPage = useStableCallback(() => void pageCreation.create(null));
  const manageMachines = useStableCallback(() => changeAppView("machines"));
  // One object while what it offers is the same: the list column that shows it is memoized.
  const listCreate = useMemo<CreateAction | null>(() => view === "messages" && canCreateChannel
    ? { label: "New conversation", onCreate: startNewConversation, active: composingConversation }
    : view === "pages"
      ? { label: "New page", onCreate: createNewPage, disabled: pageCreation.creating || !currentSpaceId }
      : view === "agents" && user
        ? { label: "Manage machines", onCreate: manageMachines }
        : null,
  [canCreateChannel, composingConversation, createNewPage, currentSpaceId, manageMachines, pageCreation.creating,
    startNewConversation, user, view]);
  const mobileCreate = !nativeMobileTabVisible || agentConfigDialog ? null : listCreate;
  const desktopCreate = isMobileViewport || agentConfigDialog ? null : listCreate;
  // Elsewhere Ctrl/⌘+N starts a new conversation (browsers that reserve it for a new window keep it).
  const shortcutCreate = desktopCreate && !desktopCreate.disabled ? desktopCreate.onCreate
    : canCreateChannel ? openNewConversation : null;
  const shortcutCreateRef = useRef(shortcutCreate);
  useEffect(() => { shortcutCreateRef.current = shortcutCreate; });
  const shortcutEnabled = Boolean(shortcutCreate);
  useEffect(() => {
    if (!shortcutEnabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        shortcutCreateRef.current?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcutEnabled]);

  useEffect(() => {
    if (!isIOSNativeShell || !desktopBridge?.setMobileTabState) return;
    void desktopBridge
      .setMobileTabState({
        visible: nativeMobileTabVisible,
        activeView: view,
        spaceId: currentSpaceId,
        statusLive,
        // Omit identity while auth is unresolved; null explicitly means signed out.
        ...(!loading ? { userId: user?.id ?? null } : {}),
      })
      .catch(() => undefined);
  }, [desktopBridge, isIOSNativeShell, nativeMobileTabVisible, view, currentSpaceId, statusLive, loading, user?.id]);

  useEffect(() => {
    if (!isIOSNativeShell || !desktopBridge?.onMobileTabChange) return;
    return desktopBridge.onMobileTabChange(({ view: nextView, spaceId }) => {
      // The app is one page and a tab tap only switches its dock pane. App
      // builds that kept a page per tab also name the Space the user is in.
      if (spaceId && spaceId !== currentSpaceId) selectSpace(spaceId);
      // The native tab bar is the only input here, so resolve through the
      // same rename map the URL parser uses. A hand-written list silently
      // drops any tab added to the Swift side later — that is how the
      // Follow-ups tab shipped inert on iOS, and how an Agents tab that
      // posted the retired `agents` segment did nothing.
      const resolved = viewForRouteSegment(nextView);
      if (resolved) changeAppView(resolved);
    });
  }, [changeAppView, currentSpaceId, desktopBridge, isIOSNativeShell, selectSpace]);

  useAndroidBackHandler(true, () => {
    if (mobileChannelDetailsOpen) {
      closeMobileChannelDetails();
      return true;
    }
    if (view === "messages" && selectedChannel) {
      backToChannelList();
      return true;
    }
    if (view !== "messages" && view !== "more" && MORE_TAB_VIEWS.includes(view)) {
      backToMore();
      return true;
    }
    return false;
  });

  // A decision made from the Agents page or the review dialog changes the Space
  // list; that change is the signal to re-read this Channel's pending cards.
  const pendingCrossSpaceReadRequests = useChannelPendingCrossSpaceReads(model.authenticatedUserId ?? "",
    selectedChannel?.id, token, canUseSelectedChannel);
  const pendingConnectorActions = useConnectorActionApprovals(model.authenticatedUserId ?? "", selectedChannel?.id,
    token, canUseSelectedChannel && Boolean(selectedChannel && spaces.some(space => space.id === selectedChannel.spaceId &&
      ["owner", "admin"].includes(transferSpaceRole(space, model.authenticatedUserId ?? "") || ""))));

  /* The timeline, the work dock and the composer are memoized, and this shell
     renders for every message and read: handlers that stay the same let those
     renders pass them by. */
  const openTimelineHumanProfile = useStableCallback((userId: string) => openHumanProfile(userId));
  const stopDockInstance = useStableCallback((...args: Parameters<typeof stopAgentInstance>) =>
    void stopAgentInstance(...args));
  const rebornDockInstance = useStableCallback((...args: Parameters<typeof rebornAgentInstance>) =>
    void rebornAgentInstance(...args));
  const handoffDockInstance = useStableCallback((...args: Parameters<typeof handoffAgentInstance>) =>
    void handoffAgentInstance(...args));
  const cancelComposerReply = useStableCallback(() => {
    replyTargetRef.current = null;
    replyTargetHistoryRevisionRef.current = -1;
    setReplyTarget(null);
  });
  const changeDraftAttachments = useStableCallback((updater: Parameters<ComponentProps<typeof Composer>["onAttachmentsChange"]>[0]) =>
    setDraftAttachments((current) => {
      const next =
        typeof updater === "function" ? updater(current) : updater;
      draftAttachmentsRef.current = next;
      writeChannelComposerDraft(channelComposerDraftsRef.current, draftChannelIdRef.current, {
        text: draftRef.current,
        workspaceTarget: draftWorkspaceTargetValueRef.current,
        attachments: next,
      });
      return next;
    }));
  const sendComposerMessage = useStableCallback((snapshot: Parameters<ComponentProps<typeof Composer>["onSend"]>[0]) =>
    void sendChannelMessage(undefined, snapshot));
  const openComposerApps = useStableCallback((spaceId: string) => openAppsForSpace(spaceId));
  /* The same holds for the header, the details, the rail and the search
     dialog: each is memoized, and a shell render that changes nothing of
     theirs gives them the same handlers, so it passes them by. */
  const renameSelectedChannel = useStableCallback((name: string) => {
    if (selectedChannel) void renameChannel(selectedChannel.id, name);
  });
  const changeSelectedVisibility = useStableCallback((mode: Parameters<typeof updateChannelVisibility>[1]) => {
    if (selectedChannel) void updateChannelVisibility(selectedChannel, mode);
  });
  const moveSelectedChannel = useStableCallback(() => {
    if (selectedChannel) openChannelMove(selectedChannel);
  });
  const toggleSelectedMembers = useStableCallback(() => {
    if (mobileChannelDetailsOpen) closeMobileChannelDetails();
    else openMobileChannelDetails();
  });
  const runSelectedChannelCommand = useStableCallback((body: string) => {
    void sendChannelMessage({ body });
  });
  const manageSelectedApps = useStableCallback(() => {
    if (selectedChannel) openAppsForSpace(selectedChannel.spaceId);
  });
  const toggleDetailsAutomation = useStableCallback(toggleAutomation);
  const updateDetailsAutomation = useStableCallback(updateAutomation);
  const deleteDetailsAutomation = useStableCallback(deleteAutomation);
  const openDetailsSchedule = useStableCallback(openSchedule);
  const closeDetailsOverlay = useStableCallback(closeMobileChannelDetails);
  const openSearchResultsFor = useStableCallback((request: Parameters<typeof searchRequestParams>[0]) =>
    openSearchResults(searchRequestParams(request).toString()));
  const selectSearchChannel = useStableCallback((channelId: string) => navigateToChannel(channelId));
  const selectSearchMessage = useStableCallback((channelId: string, messageId: string) =>
    navigateToChannel(channelId, messageId));
  const selectSearchPage = useStableCallback((pageId: string, blockId?: string | null) => {
    openPageAt(pageId, blockId);
    setWorkspaceSearchOpen(false);
  });
  const selectSearchMember = useStableCallback((userId: string, spaceId?: string) => {
    openHumanProfile(userId, spaceId);
    setWorkspaceSearchOpen(false);
  });
  const changeSearchView = useStableCallback((nextView: Parameters<typeof changeAppView>[0]) => {
    changeAppView(nextView);
    setWorkspaceSearchOpen(false);
  });
  const cancelSearch = useStableCallback(() => setWorkspaceSearchOpen(false));
  const changeRailView = useStableCallback(changeAppView);
  const openOwnProfile = useStableCallback(() => openHumanProfile());
  const logOut = useStableCallback(() => void logoutAndClearDeviceData().catch(() => undefined));
  const reportIssue = useStableCallback(openIssueReport);
  const installUpdateFromRail = useStableCallback(() => requestDesktopUpdateInstall());
  /* The conversation list is memoized: its handlers stay the same object and
     act on what the shell holds when they are called. */
  const renameSidebarSpace = useStableCallback((spaceId: string, name: string) => void renameSpace(spaceId, name));
  const manageSidebarSpaces = useStableCallback(() => changeAppView("team"));
  const toggleSidebarPin = useStableCallback((channelId: string) => toggleChannelPinned(channelId));
  const markSidebarDone = useStableCallback((channelId: string) => void markChannelResponded(channelId));
  const selectSidebarSpace = useStableCallback(selectSpace);
  const copySidebarChannelLink = useStableCallback((channel: Parameters<typeof copyChannelLink>[0]) => copyChannelLink(channel));
  const selectSidebarChannel = useStableCallback((channelId: string, messageId?: string) =>
    requestChannelNavigation(channelId, messageId));
  const cancelDesktopUpdate = useStableCallback(() => setDesktopUpdateConfirmOpen(false));
  const confirmDesktopUpdate = useStableCallback(() => {
    setDesktopUpdateConfirmOpen(false);
    void installDesktopUpdate();
  });
  // The resize handle's context: one value while the width and the drag are the same.
  const listColumnResize = useMemo(() => ({
    width: desktopSidebarWidth,
    resizing: resizingDesktopSidebar,
    startResize: startDesktopSidebarResize,
    onKeyDown: handleDesktopSidebarResizeKey,
  }), [desktopSidebarWidth, handleDesktopSidebarResizeKey, resizingDesktopSidebar, startDesktopSidebarResize]);
  const submitChannelMove = useStableCallback(() => {
    if (selectedChannel) void moveChannel(selectedChannel);
  });
  const cancelChannelMove = useStableCallback(() => {
    setChannelMoveOpen(false);
    setChannelMoveError(null);
  });
  const ownMember = user ? currentSpace?.members.find((member) => member.userId === user.id) : undefined;
  const railProfile = useMemo(() => user ? humanProfileFromSpaceMember(user, ownMember) : null, [ownMember, user]);
  const railUpdateControl = useMemo(() => desktopBridge ? (
    <DesktopUpdateRailButton status={desktopUpdateStatus} onInstall={installUpdateFromRail} />
  ) : undefined, [desktopBridge, desktopUpdateStatus, installUpdateFromRail]);

  if (loading || !user) {
    if (cachedCatalogChannels.length > 0) {
      return (
        <ColdStartChannelCatalog
          channels={cachedCatalogChannels}
          desktopFrameClass={desktopFrameClass}
          showMobileTabDock={!isIOSNativeShell}
        />
      );
    }
    return (
      <div
        className={cn(
          "xmatrix-app xmatrix-app-shell flex h-dvh w-screen max-w-[100dvw] items-center justify-center overflow-hidden bg-background text-foreground",
          desktopFrameClass
        )}
      >
        <LiquidGlassFilter />
        <div className="app-ambient pointer-events-none fixed inset-0" />
        <AnimatedIcon icon={Loader2} className="size-6 animate-spin" />
      </div>
    );
  }

  // A phone has no room beside its list, so the setup takes the list's place
  // when a machine reports agents to turn on, or when a Space with no agent has
  // no conversation either and the list would only say "No conversations yet".
  const showMobileAgentSetup = isMobileViewport && showSpaceAgentSetup && (
    (installedFleet.ready && installedFleet.candidates.length > 0) ||
    (spaceAgentSetup.kind === "no-local-machine" && spaceChannelCount === 0));
  const renderSpaceAgentSetup = (phone: boolean) => (
        <div className="app-tool-paper app-tool-detail min-h-0 flex-1 overflow-y-auto">
          <SpaceAgentSetupCard
            phone={phone}
            state={spaceAgentSetup}
            spaceId={currentSpaceId ?? null}
            token={token ?? undefined}
            userId={user?.id}
            hostLabel={desktopContext?.hostname || desktopContext?.hostName || desktopContext?.hostId || "this machine"}
            busy={bringingLocal ? "enabling" : localActionBusy}
            error={installedFleet.error ?? localActionError}
            fleet={installedFleet}
            onManageMachines={() => changeAppView("machines")}
            onBringAll={() => installedFleet.candidates.length > 0 ? void installedFleet.enableAll() :
              void enableLocalHarnesses(agentPresetDiscoveries.filter((candidate) => candidate.runtimeAvailable).map((candidate) => candidate.presetId))}
            onStartDaemon={() => void startDesktopDaemon()}
            onRefresh={() => void refreshAgentPresetDiscoveries()}
            // Re-reads the registrations, not the local runtime discovery:
            // the failure this retries is the registration read.
            onRetryAgents={() => void registrationCatalog.refetch()}
            onBindAgent={(candidate) => void enableLocalHarnesses([candidate.presetId])}
          />
        </div>
  );

  const mobileChannelListPane = (
    /* The outer slab clips the fixed edge lighting. The texture lives
       on the full-height content wrapper inside the scroll viewport,
       so browser-native scrolling moves content and material with the
       exact same compositor transform. Both dock panes share the chat-pane
       material class, so each also carries a class that says which one it
       is — otherwise "the channel list" and "Follow-ups" are the same
       selector now that both stay mounted. */
    <div className="app-mobile-chat-pane app-mobile-channel-list-pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:hidden">
      {showMobileAgentSetup ? renderSpaceAgentSetup(true) : <MobileChannelChatList
            currentSpaceId={currentSpaceId}
            catalogPaging={currentSpaceCatalog}
            fallbackChannels={cachedCatalogChannels}
            pinState={channelPinState}
            selectedChannelId={selectedChannelId}
            readCounts={channelReadCounts}
            mentionClearedAt={channelMentionClearedAt}
            readCountsBaselineReady={channelReadCountsBaselineReady}
            events={events}
            canCreateChannel={canCreateChannel}
            onTogglePinned={(channelId) => toggleChannelPinned(channelId)}
            onMarkDone={(channelId) => void markChannelResponded(channelId)}
            onCopyChannelLink={(channel) => copyChannelLink(channel)}
            pendingChannelId={pendingChannelNavigationId}
            onSelect={(channelId, messageId) => requestChannelNavigation(channelId, messageId)}
          />}
    </div>
  );
  const pendingCrossSpaceReads = canUseSelectedChannel ? pendingCrossSpaceReadRequests : [];
  const channelHasPendingApprovals = pendingCrossSpaceReads.length > 0 || pendingConnectorActions.length > 0;
  const newConversationSurface = (
    <NewConversation
      space={currentSpace}
      token={token ?? null}
      workspaces={projects}
      localContext={localMentionContext}
      // As an opened conversation: a phone raises the keyboard when the field is tapped.
      autoFocus={!isMobileViewport}
      onCreate={createNewConversation}
      onSend={sendNewConversationMessage}
      onCancel={() => setComposingConversation(false)}
      onOpenAppsForSpace={openAppsForSpace}
    />
  );

  // One conversation surface, shown as the Conversations view or docked beside
  // the page it is about (pages-live-document.md §4.4).
  // A page's conversation opens in the page's margin at what it is about, docks beside the page when
  // the margin has no room, and on a phone is a screen pushed over the page (pages-live-document.md §4.4).
  const renderConversationSurface = (placement: "main" | "beside-page" | "page-margin") => (
  <div
    className={cn(
      "flex min-h-0 min-w-0 overflow-hidden",
      placement === "main" ? "flex-1"
        : placement === "page-margin" ? "app-page-conversation flex-1"
        : "app-page-conversation flex-1 md:w-[min(30rem,50%)] md:flex-none md:border-l md:border-border",
      !selectedChannel && "hidden md:flex"
    )}
    data-testid={placement === "main" ? undefined : "page-conversation"}
  >
    <section
      className="app-message-surface relative flex min-w-0 flex-1 flex-col overflow-hidden"
    >
      {selectedChannel && <ChannelTransferQueue token={token} userId={user.id}
        spaceId={selectedChannel.spaceId} channelId={selectedChannel.id}
        enabled={spaces.some((space) => space.id === selectedChannel.spaceId &&
          ["owner", "admin"].includes(transferSpaceRole(space, user.id) || ""))} />}
      {/* In a page's margin the card is the header: the page draws its title, passage and actions. */}
      {selectedChannel && placement !== "page-margin" && (
        <ChannelHeader
          channel={selectedChannel}
          spaces={spaces}
          currentUserId={user.id}
          onOpenSearch={openWorkspaceSearch}
          onRename={renameSelectedChannel}
          onVisibilityChange={changeSelectedVisibility}
          onMove={moveSelectedChannel}
          renaming={renamingChannelId === selectedChannel.id}
          updatingVisibility={updatingChannelVisibilityId === selectedChannel.id}
          moving={movingChannelId === selectedChannel.id}
          onToggleMembers={toggleSelectedMembers}
          actions={placement === "beside-page" ? (
            <>
              <button type="button" title="Open in Conversations" aria-label="Open in Conversations"
                onClick={() => navigateToChannel(selectedChannel.id)}
                className="hidden size-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground md:flex">
                <Maximize2 className="size-4" />
              </button>
              <button type="button" title="Close" aria-label="Close the conversation"
                onClick={closePageConversation}
                className="hidden size-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground md:flex">
                <X className="size-4" />
              </button>
            </>
          ) : undefined}
        />
      )}
      {selectedChannel && token && placement !== "page-margin" && (
        <ConversationPageCards spaceId={selectedChannel.spaceId} conversationId={selectedChannel.id} token={token}
          onOpenPage={openPage} excludePageId={placement === "beside-page" ? selectedPageId : null} />
      )}
      {showSpaceAgentSetup && !showMobileAgentSetup && renderSpaceAgentSetup(false)}
      {showSpaceFirstTask && (
        <div className="app-tool-paper app-tool-detail min-h-0 flex-1 overflow-y-auto">
          <SpaceFirstTaskCard
            state={spaceFirstTask}
            spaceName={currentSpace?.name}
            workspace={firstTaskWorkspace}
            busy={firstTaskBusy}
            error={firstTaskError}
            onChooseWorkspace={() => void chooseFirstTaskWorkspace()}
            onLaunch={(task) => void startFirstTask(task)}
          />
        </div>
      )}
      {selectedChannel && !showSpaceAgentSetup && !showSpaceFirstTask && placement !== "page-margin" && (
        <MobileChannelSummaryPlaque
          summary={selectedChannel.summary}
          onOpen={openMobileChannelDetails}
          spaceId={selectedChannel.spaceId}
          conversationId={selectedChannel.id}
          token={token ?? null}
          onOpenPage={openPage}
        />
      )}
      {!showSpaceAgentSetup && !showSpaceFirstTask && (
      <MessageTimeline
        channel={selectedChannel}
        space={currentSpace}
        token={token ?? null}
        localContext={localMentionContext}
        isJoined={canUseSelectedChannel}
        loading={loadingWorkspace || Boolean(
          selectedChannel &&
          (loadingHistory || !historyRenderAuthorized) &&
          // Keep the last painted page while a refresh runs; only the
          // empty window may show a skeleton.
          timeline.length === 0
        )}
        highlightMessageId={highlightedMessageId ?? undefined}
        timeline={timeline}
        hasWorkDock={channelHasAgentMembers(selectedChannel) || channelHasPendingApprovals}
        hasChannels={channels.length > 0}
        hasOlderMessages={historyRenderAuthorized && hasOlderMessages}
        olderLoading={olderLoading}
        error={historyError}
        timelineScrollRef={timelineScrollRef}
        timelineJumpRef={timelineJumpRef}
        onJumpCanLand={bumpMessageJumpRevision}
        messagesEndRef={messagesEndRef}
        onScrollPositionChange={handleTimelineScrollPositionChange}
        onScrollGesture={handleTimelineScrollGesture}
        onNearTop={handleTimelineNearTop}
        onOpenAgentTrace={openAgentTrace}
        onOpenHumanProfile={openTimelineHumanProfile}
        currentUserIdentityId={`user:${user.id}`}
        onReact={handleTimelineReact}
        onEdit={handleTimelineEdit}
        onRecall={handleTimelineRecall}
        onUnsentAction={handleTimelineUnsentAction}
        onReply={handleTimelineReply}
        onOpenThread={handleTimelineOpenThread}
        onDiscussPassage={handleTimelineDiscussPassage}
        onMentionSender={handleTimelineMentionSender}
        onRebornSender={handleTimelineRebornSender}
        reborningSenderKey={reborningAgentInstanceId}
        onQuestionnaireAnswer={handleTimelineQuestionnaireAnswer}
        onSendMessage={runSelectedChannelCommand}
        onOpenInternalAppLink={handleTimelineOpenInternalAppLink}
        onOpenPage={openPageAt}
        onJumpToMessage={handleTimelineJumpToMessage}
        onMessageExposed={handleTimelineMessageExposed}
        threadRootMessage={selectedThreadRootContext?.message}
        threadRootChannel={selectedThreadRootContext?.channel}
      />
      )}
      <AgentWorkDetailsDock
        approvals={channelHasPendingApprovals ? (
          <ChannelApprovalsDock
            summaries={[...pendingCrossSpaceReads.map((request) => ({ key: `read:${request.grantId}`,
                agent: request.agentName || "Agent", what: "read another Space" })),
              ...pendingConnectorActions.map(request => ({ key: request.requestId, agent: request.providerId, what: request.actionId }))]}
          >
            {pendingConnectorActions.map(request => <ConnectorActionApproval key={request.requestId} request={request}
              token={token} userId={model.authenticatedUserId ?? ""} />)}
            {pendingCrossSpaceReads.map((request) => (
              <CrossSpaceReadCard key={request.grantId} request={request} token={token}
                userId={model.authenticatedUserId ?? ""} />
            ))}
          </ChannelApprovalsDock>
        ) : null}
        channel={selectedChannel}
        token={token ?? null}
        timeline={timeline}
        events={events}
        stoppingAgentInstanceId={stoppingAgentInstanceId}
        reborningAgentInstanceId={reborningAgentInstanceId}
        handingOffAgentInstanceId={handingOffAgentInstanceId}
        onStopAgentInstance={stopDockInstance}
        onRebornAgentInstance={rebornDockInstance}
        onHandoffAgentInstance={handoffDockInstance}
        onOpenAgentTrace={openAgentTrace}
      />
      {/* The composer sits in the reserved bottom gutter; the work dock stays
          anchored to --app-composer-height. */}
      {selectedChannel && (
        <Composer
          channel={selectedChannel}
          space={currentSpace}
          token={token ?? null}
          workspaces={projects}
          localContext={localMentionContext}
          isJoined={canUseSelectedChannel}
          draft={draft}
          draftSeedRevision={composerDraftSeedRevision}
          invocationDraft={channelComposerDraftsRef.current.get(selectedChannel.id)?.invocationDraft}
          selectedWorkspaceId={draftWorkspaceTarget}
          replyTarget={
            historyRenderAuthorized &&
            replyTargetHistoryRevisionRef.current === historyRevision
              ? replyTarget
              : null
          }
          attachments={draftAttachments}
          mentionInsertRequest={mentionInsertRequest}
          autoFocusRequest={composerAutoFocusRequest}
          error={historyError}
          onDraftChange={persistComposerDraftSnapshot}
          onWorkspaceSelect={setDraftWorkspaceTarget}
          onCancelReply={cancelComposerReply}
          onAttachmentsChange={changeDraftAttachments}
          onSend={sendComposerMessage}
          onOpenAppsForSpace={openComposerApps}
        />
      )}
    </section>

    {(placement === "main" || mobileChannelDetailsOpen) && <ChannelDetails
      channel={selectedChannel}
      space={currentSpace}
      workspaces={projects}
      token={token}
      connectorRevision={latestChannelConnectorStateMessageId(renderableHistory)}
      currentUserMemberId={humanMemberId}
      currentUserId={user.id}
      onOpenAgentTrace={openAgentTrace}
      onRunChannelCommand={canUseSelectedChannel ? runSelectedChannelCommand : undefined}
      onManageApps={manageSelectedApps}
      automations={automations}
      automationExecutionEnabled={automationExecutionEnabled}
      automationBusy={automationBusy}
      onToggleAutomation={toggleDetailsAutomation}
      onUpdateAutomation={updateDetailsAutomation}
      onDeleteAutomation={deleteDetailsAutomation}
      onOpenSchedule={openDetailsSchedule}
      mobileOverlayOpen={mobileChannelDetailsOpen}
      onCloseMobileOverlay={closeDetailsOverlay}
    />}
  </div>
  );
  const channelConversationSurface = renderConversationSurface("main");

  // The Pages dock root on a phone: the same list the desktop sidebar shows,
  // in the dock's own pane so switching tabs does not rebuild it. It mounts on
  // first visit, not at startup, so its document prefetch runs only for someone
  // who opens Pages.
  const pagesDockPane = dockTabMounted("pages") ? (
    <PageTreePanel spaceId={currentSpaceId} token={token ?? ""} selectedPageId={null}
      onSelectPage={openPage} onOpenSection={openPageAt} creation={pageCreation} layout="phone" />
  ) : null;

  // One Pages document surface, whether read on the desktop, pushed over the
  // phone's Pages list, or shown while the Space is being moved to pages.
  const pagesViewSurface = selectedPageId === NEW_PAGE_ID ? (
    <PageDraft key={currentSpaceId} creation={pageCreation} layout={isMobileViewport ? "phone" : "desktop"} />
  ) : (
    <PagesView spaceId={currentSpaceId} token={token ?? ""} selectedPageId={selectedPageId}
      onSelectPage={openPage} onOpenSection={openPageAt} onPageDeleted={closePage} conversation={pageConversation} focusSection={pageSectionRequest}
      activeConversationId={selectedPageId ? selectedChannelId : null}
      {...(selectedChannel && selectedPageId ? { renderConversation: (placement: "margin" | "dock") =>
        renderConversationSurface(placement === "margin" ? "page-margin" : "beside-page") } : {})}
      onConversationDockChange={setPageConversationDocked}
      onCloseConversation={closePageConversation}
      onExpandConversation={(conversationId) => navigateToChannel(conversationId)}
      onOpenConversation={(conversationId) => openPageConversation(conversationId)}
      onDiscuss={({ firstMessage, draft, open, coWrite, ...input }) => startPageConversation(input,
        { ...(firstMessage ? { firstMessage } : {}), ...(draft ? { draft } : {}), ...(open === false ? { open } : {}),
          ...(coWrite ? { coWrite } : {}) })}
      onConnectGitHub={async (input) => {
        // The repository's issues and pull requests arrive in a conversation linked to the page.
        await startPageConversation({ spaceId: input.spaceId, pageId: input.pageId, blockId: input.blockId,
          restricted: input.restricted, name: `GitHub · ${input.repository}` },
        { open: false, firstMessage: `@github:subscribe:${input.repository} issues pulls` });
      }}
      canMigrate={canMovePages}
      layout={isMobileViewport ? "phone" : "desktop"} />
  );

  // One tool surface per dock tab that needs one: Status has its own, and the
  // More tab holds the current tool view. Building it from a function keeps
  // the prop list in one place while letting each pane mount independently.
  const renderToolSurface = (surfaceView: Exclude<AppView, "messages">) => (
    <ToolSurface
      // ToolSurface has no "messages" or "pages" surface. Only the offscreen
      // fallback below uses a non-tool view, so it is never displayed.
      view={surfaceView}
      profileUserId={profileUserId}
      platformAdmin={platformAdmin}
      onChangeView={changeAppView}
      onReportIssue={openIssueReport}
      user={{
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      }}
      channels={channels}
      machines={machines}
      localWorkspaces={localWorkspaces}
      localManagedAgents={localManagedAgents}
      agentPresetDiscoveries={agentPresetDiscoveries}
      loadingAgentPresetDiscoveries={loadingAgentPresetDiscoveries}
      automations={automations}
      automationExecutionEnabled={automationExecutionEnabled}
      spaces={spaces}
      events={events}
      currentSpace={currentSpace}
      token={token}
      agentsError={agentsError}
      spacesError={spacesError}
      desktopAvailable={Boolean(desktopBridge)}
      desktopUpdateBridgeAvailable={desktopUpdateBridgeAvailable}
      desktopContext={desktopContext}
      desktopDaemonStatus={desktopDaemonStatus}
      desktopSetupStatus={desktopSetupStatus}
      desktopUpdateStatus={desktopUpdateStatus}
      localActionBusy={localActionBusy}
      localActionError={localActionError}
      automationBusy={automationBusy}
      automationError={automationError}
      automationLoadError={automationLoadError}
      loadingAutomations={loadingAutomations}
      scheduleFocusId={scheduleFocusId}
      onScheduleFocusConsumed={clearScheduleFocus}
      onOpenPage={openPage}
      onOpenConversation={(channelId) => navigateToChannel(channelId)}
      runtimeCheck={runtimeCheck}
      localSetupReady={localSetupReady}
      localMachineName={localMachineName}
      onNameLocalMachine={(name) => void nameLocalMachine(name)}
      onStartDesktopDaemon={() => void startDesktopDaemon()}
      onStopDesktopDaemon={() => void stopDesktopDaemon()}
      onRestartDesktopDaemon={() => void restartDesktopDaemon()}
      checkingDesktopUpdates={checkingDesktopUpdates}
      onCheckDesktopUpdates={() => void checkDesktopUpdates()}
      onInstallDesktopUpdate={requestDesktopUpdateInstall}
      onOpenCliInstall={() => void installDesktopCli()}
      onAddLocalWorkspace={() => void addLocalWorkspace()}
      onRefreshAgentPresetDiscoveries={() => void refreshAgentPresetDiscoveries()}
      onImportDiscoveredAgent={(discovery) => void importDiscoveredAgent(discovery)}
      onImportDiscoveredWorkspace={(candidate) => void importDiscoveredWorkspace(candidate)}
      onRemoveLocalWorkspace={(workspace) => void removeLocalWorkspace(workspace)}
      onRevealLocalWorkspace={(workspace) => void revealLocalWorkspace(workspace)}
      onCheckLocalRuntime={(runtime) => void checkLocalRuntime(runtime)}
      onCompleteDesktopSetup={() => void completeDesktopSetup()}
      onUpdateAutomation={(automationId, input) => void updateAutomation(automationId, input)}
      onToggleAutomation={(automation) => void toggleAutomation(automation)}
      onRunAutomation={(automation) => void runAutomation(automation)}
      onDeleteAutomation={(automation) => void deleteAutomation(automation)}
      joinRequestsBySpace={joinRequestsBySpace}
      onDecideJoinRequest={resolveSpaceJoinRequest}
      onCreateSpaceInviteCode={createSpaceInviteCode}
      onInviteSpaceMembers={inviteSpaceMembers}
      onUpdateSpaceMemberRole={updateSpaceMemberRole}
      onRemoveSpaceMember={removeSpaceMember}
      onUpdateSpaceMemberPermissions={updateSpaceMemberPermissions}
      onUpdateSpacePreferredLanguage={updateSpacePreferredLanguage}
      onDeleteSpace={deleteSpace}
      onRestoreSpace={restoreSpace}
      creatingSpace={creatingSpace}
      onCreateSpace={(name) => createSpace(name, { select: true })}
      onSelectSpace={selectSpace}
      onLogout={() => void logoutAndClearDeviceData().catch(() => undefined)}
      onOpenAgentCreate={openAgentCreate}
      onOpenLocalManagedAgentEdit={openLocalManagedAgentEdit}
      onDeleteAgent={(agent) => void deleteAgent(agent)}
    />
  );
  const searchSurface = view === "search" ? (
    <WorkspaceSearchView
      request={searchRequest}
      spaceName={currentSpace?.name ?? "this Space"}
      channels={channels}
      pages={pageTree.data ?? []}
      searchMessages={messageSearch}
      searchPages={searchPages}
      onChangeRequest={(request) => openSearchResults(searchRequestParams(request).toString())}
      onEditSearch={openWorkspaceSearch}
      onSelectChannel={(channelId) => navigateToChannel(channelId)}
      onSelectMessage={(channelId, messageId) => navigateToChannel(channelId, messageId)}
      onSelectPage={(pageId, blockId) => openPageAt(pageId, blockId)}
    />
  ) : null;
  const toolSurface = view === "search" ? searchSurface
    : renderToolSurface(view === "messages" || view === "pages" ? "more" : view as Exclude<AppView, "messages" | "search">);
  const statusSurface = dockTabMounted("status") ? renderToolSurface("status") : null;
  const moreSurface = dockTabMounted("more")
    ? view === "search" ? searchSurface
      : renderToolSurface(dockTabOf(view) === "more" && view !== "pages" && view !== "messages" ? view : "more")
    : null;

  return (
    // Files are accepted by the whole window, not by the composer element, so
    // the drop surface has to sit above the app's isolate stacking context.
    <AttachmentDropZoneProvider>
    <RealtimeChannelsContext.Provider value={model.realtimeChannels}>
    <RealtimeEventsContext.Provider value={model.realtimeEventViews}>
    <PresentedChannelTailContext.Provider value={model.presentedChannelTail}>
    <MessageReferenceCatalogProvider catalog={messageReferenceCatalog}>
    <MachineLinkProvider links={machineLinks}>
    <ManageSecretsProvider value={manageSecrets}>
      {/* One live root subscription per loaded Space. Renders nothing. */}
      {channelCatalogPaging.roots}
      {children}
      <WorkspaceSearchDialog
        open={workspaceSearchOpen}
        initialFilters={searchHereFilters}
        spaceId={currentSpaceId}
        // Match the channel-list surface: when live catalog is still empty the
        // durable presentation cache is what the user can already see and type.
        channels={channels}
        spaces={spaces}
        agents={agents}
        realtimeAgents={model.realtimeAgents}
        projects={projects}
        machineDaemons={machineDaemons}
        pages={pageTree.data ?? NO_PAGES}
        searchMessages={messageSearch}
        searchPages={searchPages}
        catalogPaging={currentSpaceCatalog}
        onOpenResults={openSearchResultsFor}
        onSelectChannel={selectSearchChannel}
        onSelectMessage={selectSearchMessage}
        onSelectPage={selectSearchPage}
        onSelectMember={selectSearchMember}
        onChangeView={changeSearchView}
        onCancel={cancelSearch}
      />
      <ChannelMoveDialog
        open={channelMoveOpen}
        channel={selectedChannel}
        spaces={spaces}
        targetSpaceId={channelMoveTargetSpaceId}
        busy={Boolean(movingChannelId)}
        error={channelMoveError}
        onTargetSpaceChange={setChannelMoveTargetSpaceId}
        onSubmit={submitChannelMove}
        onCancel={cancelChannelMove}
      />
      <div
        className={cn(
          "xmatrix-app xmatrix-app-shell relative isolate m-0 flex w-screen max-w-[100dvw] justify-start bg-background text-foreground",
          desktopFrameClass,
          workspaceSearchOpen && "app-search-open",
          view === "pages" && selectedPageId && selectedChannel && (isMobileViewport || pageConversationDocked) && "app-page-conversation-open",
          mobileBackState(view, { channel: Boolean(!composingConversation && selectedChannel), page: Boolean(openedPage),
            composing: composingConversation, conversationOverPage: phonePageConversation }).showBack && "app-mobile-back-open",
          // Exactly the clients that get no web dock draw their own bottom
          // bar, so the same condition decides which one occludes the bottom
          // of every mobile surface. Keeping one condition for both keeps the
          // reserved band from drifting away from the bar that is really there.
          isIOSNativeShell && "xmatrix-app-native-dock",
          // On a phone, Pages is a list and pushed screens like Channels, in
          // the same chrome.
          view === "messages" || (isMobileViewport && view === "pages")
            ? "h-dvh overflow-hidden"
            : "app-tool-layout h-dvh overflow-hidden"
        )}
      >
        {desktopFrameClass === "xmatrix-desktop-windows" && (
          <div className="app-windows-caption-band" aria-hidden="true" />
        )}
        <LiquidGlassFilter />
        <div className="app-ambient pointer-events-none fixed inset-0" />
        <WorkspaceRail
          activeView={view}
          profile={railProfile!}
          platformAdmin={platformAdmin}
          onChangeView={changeRailView}
          onOpenProfile={openOwnProfile}
          onLogout={logOut}
          onReportIssue={reportIssue}
          pendingJoinRequestCount={pendingJoinRequestCount}
          statusLive={statusLive}
          updateControl={railUpdateControl}
        />
        {!(view === "messages" && selectedChannel && !composingConversation) && <GlobalSearchBar
          searching={workspaceSearchOpen}
          onOpenSearch={openWorkspaceSearch}
        />}
        <CreateFab action={mobileCreate} />
        {!isIOSNativeShell && (
          <MobileTabDock
            activeView={view}
            hidden={!nativeMobileTabVisible}
            statusLive={statusLive}
            onChangeView={changeRailView}
          />
        )}

      {/* One workspace panel beside the rail: the conversation list, the
          conversation and its details share its paper and its single shadow.
          On phones it is layout-transparent (display: contents). */}
      <div className="app-workspace-panel"
        style={{ "--app-desktop-sidebar-width": `${desktopSidebarWidth}px` } as CSSProperties}>
      <ListColumnResizeProvider value={listColumnResize}>
        {/* A destination with a list of its own draws it in this column's place. */}
        <aside
          className={cn("app-sidebar hidden w-[var(--app-desktop-sidebar-width)] flex-col bg-sidebar text-sidebar-foreground",
            !SPLIT_TOOL_VIEWS.includes(view) && "md:flex")}
        >
          {view === "pages" ? (
            <PageTreePanel spaceId={currentSpaceId} token={token ?? ""} selectedPageId={selectedPageId}
              onSelectPage={openPage} onOpenSection={openPageAt} creation={pageCreation}
              create={<ListCreate action={desktopCreate} />} />
          ) : <ChannelSidebar
            events={events}
            spaces={spaces}
            currentSpaceId={currentSpaceId}
            selectedChannelId={selectedChannelId}
            loading={loadingWorkspace}
            error={channelSidebarError(error)}
            catalogPaging={currentSpaceCatalog}
            fallbackChannels={cachedCatalogChannels}
            view={view}
            readCounts={channelReadCounts}
            mentionClearedAt={channelMentionClearedAt}
            pinState={channelPinState}
            readCountsBaselineReady={channelReadCountsBaselineReady}
            currentUserId={user.id}
            renamingSpaceId={renamingSpaceId}
            spacesError={spacesError}
            onRenameSpace={renameSidebarSpace}
            onManageSpaces={manageSidebarSpaces}
            onTogglePinned={toggleSidebarPin}
            onMarkDone={markSidebarDone}
            onSelectSpace={selectSidebarSpace}
            onCopyChannelLink={copySidebarChannelLink}
            onSelect={selectSidebarChannel}
            create={desktopCreate}
          />}
        </aside>

        <ListColumnResizeHandle className={cn(!SPLIT_TOOL_VIEWS.includes(view) && "md:flex")} />

        <main
          className="app-main relative flex min-w-0 max-w-full flex-1 flex-col overflow-hidden bg-card/80"
        >
          <TopWorkspaceBar
            page={openedPage}
            onClosePage={closePage}
            onClosePageConversation={phonePageConversation ? closePageConversation : undefined}
            composing={composingConversation}
            onCloseComposing={() => setComposingConversation(false)}
            channel={composingConversation ? null : selectedChannel}
            spaces={spaces}
            currentSpaceId={currentSpaceId}
            view={view}
            onBack={backToChannelList}
            onOpenMore={backToMore}
            onOpenSearch={openWorkspaceSearch}
            onShareChannel={
              selectedChannel
                ? () => copyChannelLink(selectedChannel)
                : undefined
            }
            onOpenChannelDetails={openMobileChannelDetails}
            onSelectSpace={selectSpace}
          />

          {agentConfigDialog ? (
            <AgentConfigPage
              state={agentConfigDialog}
              form={agentConfigForm}
              spaces={spaces}
              token={token}
              busy={savingAgentConfig}
              error={agentsError}
              onFormChange={(patch) => setAgentConfigForm((current) => ({ ...current, ...patch }))}
              onCancel={() => {
                if (!savingAgentConfig) setAgentConfigDialog(null);
              }}
              onSubmit={() => void saveAgentConfig()}
              onFindLocalAgents={desktopBridge?.discoverAgentPresets ? () => {
                setAgentConfigDialog(null);
                openLocalAgentDiscovery();
              } : undefined}
            />
          ) : view === "pages" && selectedPageId && mobileDockPager ? (
            // On a phone an open page is a pushed screen over the Pages list.
            // Desktop lets PagesView draw the margin/dock conversation itself.
            <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
              <div className={cn("flex min-h-0 min-w-0 flex-1", phonePageConversation && "hidden")}>
                {pagesViewSurface}
              </div>
              {selectedChannel && selectedPageId && renderConversationSurface("beside-page")}
            </div>
          ) : view === "pages" && isMobileViewport && !selectedPageId
              && pageTree.data?.length === 0 && canMovePages ? (
            // Moving the Space to pages replaces the list while it is still empty.
            <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row"
              style={{ paddingTop: "var(--mobile-topbar-space)" }}>
              <div className="flex min-h-0 min-w-0 flex-1">{pagesViewSurface}</div>
            </div>
          ) : composingConversation && view === "messages" && !mobileDockPager ? (
            // A new conversation replaces the one that is open; closing it brings that one back.
            // Only in Messages: another rail destination shows its own view, not the draft.
            newConversationSurface
          ) : (view === "messages" && selectedChannel) || mobileDockPager ? (
            // The conversation stays at a fixed position, so a viewport change
            // keeps it mounted instead of rebuilding it.
            <>
              {/* A phone's main content. Each dock root stays mounted in one track,
                  so switching tabs slides between screens that are already painted.
                  A conversation or a new one is pushed over the track, which stays
                  mounted and scrolled underneath: rebuilding it on Back painted the
                  list empty for a frame while its rows measured. */}
              {mobileDockPager && (
                <div
                  className={cn(
                    "app-mobile-dock-pager relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                    mobileDockCovered && "invisible absolute inset-0"
                  )}
                  inert={mobileDockCovered}
                >
                  <AnimationActivityScope active={!mobileDockCovered}>
                  <div
                    className="app-mobile-dock-track"
                    style={{ "--app-mobile-dock-slot": mobileDockSlot } as CSSProperties}
                  >
                    {/* One pane per dock tab, in DOCK_TAB_VIEWS order: Pages,
                        Channels, Status, More. Each is independent; nothing is
                        swapped in place, so a tab's screen never rebuilds. */}
                    <div className="app-mobile-dock-page" inert={mobileDockSlot !== 0}>
                      <AnimationActivityScope active={mobileDockSlot === 0}>{pagesDockPane}</AnimationActivityScope>
                    </div>
                    <div className="app-mobile-dock-page" inert={mobileDockSlot !== 1}>
                      <AnimationActivityScope active={mobileDockSlot === 1}>{mobileChannelListPane}</AnimationActivityScope>
                    </div>
                    <div className="app-mobile-dock-page" inert={mobileDockSlot !== 2}>
                      <AnimationActivityScope active={mobileDockSlot === 2}>{statusSurface}</AnimationActivityScope>
                    </div>
                    <div className="app-mobile-dock-page" inert={mobileDockSlot !== 3}>
                      <AnimationActivityScope active={mobileDockSlot === 3}>{moreSurface}</AnimationActivityScope>
                    </div>
                  </div>
                  </AnimationActivityScope>
                </div>
              )}
              {view === "messages" && composingConversation && newConversationSurface}
              {/* The conversation surface stays mounted while no channel is
                  open, as it was before the panes: the Space setup card lives
                  here even when the surface is hidden on a phone. */}
              {view === "messages" && !composingConversation && channelConversationSurface}
            </>
          ) : view === "pages" ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
              <div className="flex min-h-0 min-w-0 flex-1">{pagesViewSurface}</div>
              {selectedChannel && selectedPageId && isMobileViewport && renderConversationSurface("beside-page")}
            </div>
          ) : isMobileDockView ? (
            <>
            {/* Desktop renders just the active destination. */}
            {view === "messages" && !selectedChannel && mobileChannelListPane}
            {view === "more" && toolSurface}
            {view === "messages" && channelConversationSurface}
            </>
          ) : (
            toolSurface
          )}
        </main>
      </ListColumnResizeProvider>
      </div>
      {agentTraceTarget && (
        <AgentInstanceDetailWindow
          target={agentTraceTarget}
          traceReplicas={agentTraceReplicas}
          traceHistoryState={
            agentTraceHistoryPanelState?.targetKey === agentTraceHistoryTargetKey
              ? agentTraceHistoryPanelState
              : null
          }
          history={renderableHistory}
          channelId={selectedChannelId}
          onLoadOlder={loadOlderAgentTrace}
          onClose={closeAgentTrace}
        />
      )}
      <DesktopUpdateRestartDialog
        status={desktopUpdateStatus}
        open={desktopUpdateConfirmOpen}
        onCancel={cancelDesktopUpdate}
        onConfirm={confirmDesktopUpdate}
      />
    </div>
    </ManageSecretsProvider>
    </MachineLinkProvider>
    </MessageReferenceCatalogProvider>
    </PresentedChannelTailContext.Provider>
    </RealtimeEventsContext.Provider>
    </RealtimeChannelsContext.Provider>
    </AttachmentDropZoneProvider>
  );
}
