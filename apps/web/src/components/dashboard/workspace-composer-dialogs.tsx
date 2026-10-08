"use client";
import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { registrationMachineBusy, registrationMachineName } from "./machine-name-presentation";
import { ZoomableAttachmentImage } from "./zoomable-attachment-image";
import { useAndroidBackHandler } from "./use-android-back";
import { useComposerHint } from "./composer-hints";
import { updateComposerInvocationDraft, selectComposerInvocation, selectComposerReference, composerSendDraft,
  isAgentBinding, type ComposerInvocationDraft, type ComposerReferenceBinding } from "./composer-invocation-bindings";
import {
  AUTOMATION_MAX_INTERVAL_MINUTES,
  AUTOMATION_MIN_INTERVAL_MINUTES,
  digestCanonicalCloneCborV1,
  isAutomationIntervalMinutes,
  parseAgentInvocationSelections,
  type AgentInvocationSelection,
} from "@xmatrix/protocol";

import { AgentIdentityLabels } from "./agent-identity-labels";

import type { SpaceJoinRequest } from "@/components/dashboard/space-join-requests";

import { MESSAGE_SURFACE_METRICS_EVENT, messageSurfaceOf } from "./message-surface-metrics";
import {
  AutomationExpressionGuidance,
  DetailBlock,
  type SpaceMemberActions,
  automationExpressionFromText,
  SettingsView,
  TeamView,
} from "./workspace-admin-views";
import { SchedulesView } from "./schedules-view";
import { formatAutomationCadence } from "@/components/pages/page-automation-format";
import { ToolPaper } from "./tool-split";

import {
  ActivityView,
  AppsView,
  LocalMacView,
  MachinesView,
  THIS_MACHINE_ITEM,
  MoreView,
} from "./workspace-fleet-views";
import { MyAgentsView } from "./my-agents-view";
import { StatusView } from "./status-view";
import { MachineHarnessPanel } from "./machine-harness-panel";

import { noticeClass, statusChipClass } from "@/components/ui/status-tone";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { PlatformAdminTabs } from "./workspace-platform-admin-tabs";
import { humanProfileFromSpaceMember } from "./human-profile-summary";
import { ProfileView } from "./human-profile-view";
import {
  channelsInSpace,
  eventsInSpace,
  localManagedAgentsInSpace,
  machinesInSpace,
  automationsInSpace,
  spaceChannelIdSet,
  workspacesInSpace,
} from "./space-scoped-tool-content";

import type { TimelineItem } from "./workspace-shell-message-model";

import {
  IMAGE_ATTACHMENT_TYPES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  COUNT_CHIP_MATERIAL_CLASS,
} from "./workspace-shell-constants";

import {
  agentAvatarUrl,
  agentInstanceUsageLimit,
  channelAgentInstanceWorkspaceTag,
  formatPercent,
  Tag,
  tagsFromUsage,
  UsageLimitSummary,
} from "./workspace-shell-formatters";

import {
  LocalManagedAgent,
  MachineSummary,
} from "./workspace-shell-helpers";

import {
  insertMentionIntoDraft,
} from "./workspace-shell-helpers-extra";

import {
  AppView,
} from "./workspace-shell-navigation";

import {
  ATTACHMENT_UPLOAD_CONCURRENCY,
  boundedConcurrency,
  createAttachmentSlotLedger,
  createAttachmentUploadRegistry,
  planAttachmentIntake,
} from "./composer-attachment-intake";
import type { AttachmentIntakeEntry } from "./composer-attachment-intake";
import { useAttachmentDropSink } from "./composer-attachment-drop-zone";
import type { AttachmentDropCandidate } from "./composer-attachment-drop-zone";

import {
  PendingAttachment,
  PendingAttachmentCard,
  attachVideoMetadata,
  avatarInitials,
  channelAttachmentKindForFile,
  channelOnlineAgentAvatarItems,
  cleanStatusChips,
  clipboardHasTextPayload,
  defaultAttachmentName,
  evaluationBindingLabel,
  formatDateTime,
  formatFileSize,
  formatMember,
  latestEventTimestampMs,
  memberDeviceLine,
  memberPresence,
  pastedImageFiles,
  prepareImageAttachmentFile,
  presenceAvatarUrl,
  agentInstancePresenceLabel,
  presenceStatusLabel,
  relativeTime,
  shortId,
  spaceMemberForChannelIdentity,
  GoalStatusBadge,
  traceEventChannelInstanceLabel,
  uploadChannelAttachment,
  visibleHumanChannelMembers,
} from "./workspace-shell-recovered";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";

import { createPortal, flushSync } from "react-dom";

export { DialogPanelFooter, DialogPanelHeader } from "./centered-dialog-shell";

import { AgentInstanceTagChips } from "./agent-instance-tag-chips";
import { ListSkeleton, LoadingImage } from "./content-skeleton";
import { BranchBadge } from "./status-tag";

import { ChannelSubscriptionsBlock } from "./channel-subscriptions-block";

import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  Paperclip,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Reply,
  Trash2,
  Video,
  X,
} from "lucide-react";

import { Textarea } from "@/components/ui/textarea";

import { Input } from "@/components/ui/input";

import { IdentityAvatar } from "@/components/dashboard/identity-avatar";

import {
  type MentionInstanceTargetScope,
  type MentionLocalContext,
} from "@/components/dashboard/mention-complete";

import {
  type ComposerCompletionApi,
} from "@/components/dashboard/composer-completion";

import {
  ComposerInputAuthority,
} from "@/components/dashboard/composer-input";

import {
  type AgentTraceReplica,
} from "@/components/dashboard/agent-trace-replica";

import {
  type AgentTraceHistoryReadState,
} from "@/components/dashboard/agent-trace-on-demand";

import {
  agentTraceExactInstanceIds,
  agentTraceInstanceIds,
  agentTraceScopeMatchesTarget,
} from "@/components/dashboard/agent-trace-target";

import {
  EMPTY_COMPOSER_PASTE_SENTINEL,
  composerDraftCursor,
  composerPointerFocusSelection,
  emptyPasteAnchorSelection,
  isComposerImeBeforeInput,
  scheduleTextareaSelection,
  stripEmptyPasteSentinel,
} from "@/components/dashboard/composer-caret";

import {
  requestChannelAboutReview,
} from "@/components/dashboard/channel-about-review-request";

import {
  channelTitle,
} from "@/components/dashboard/channel-links";

import {
  getDesktopBridge,
  type DesktopAgentPresetDiscovery,
  type DesktopClipboardImage,
  type DesktopContext,
  type DesktopDaemonStatus,
  type DesktopRuntimeCheckResult,
  type DesktopSetupStatus,
  type DesktopUpdateStatus,
  type DesktopWorkspaceCandidate,
} from "@/lib/desktop/bridge";

import { APP_CONNECTORS } from "@/lib/app-connectors";

import { spaceMemberCanCreate } from "./space-member-permissions";

import { xmatrixApiRequest, xmatrixRawResponse } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

import { cn } from "@/lib/utils";

import { spaceVisibilityScope, WEB_PROXY_ROUTES } from "@xmatrix/protocol";

import type {
  ChannelAttachment,
  ChannelSummarySource,
  ObservabilityEvent,
  SerializedAgent,
  SerializedAgentInstance,
  SerializedAppConnectorConnection,
  SerializedChannel,
  SerializedAutomation,
  AutomationUpdateRequest,
  SerializedSpace,
  SerializedWorkspace,
} from "@xmatrix/protocol";

// Semantic module extracted from workspace-app-shell (AST-safe)

export type { ComposerChannelAttachment } from "./workspace-shell-message-model";

export type ComposerMentionInsertRequest =
  { id: number; kind: "mention"; mention: string };

export type { AgentTraceTarget } from "./workspace-shell-message-model";
import type { AgentTraceTarget, ComposerSendSnapshot } from "./workspace-shell-message-model";

export type AgentTraceHistoryPanelState = {
  targetKey: string;
  reads: AgentTraceHistoryReadState[];
  complete: boolean;
  omittedCount: number;
  missingExactInstance: boolean;
  /** "Load earlier" progress; its failure never clears loaded history. */
  older?: { loading: boolean; error?: string };
};

export type AgentInstanceStopRequest = {
  instance: SerializedAgentInstance;
  target: AgentTraceTarget;
  body: string;
};

export type {
  AgentConfigForm,
} from "./workspace-shell-agent-config-types";

export type { AgentConfigDialogState } from "./agent-config-page";

export type { ComposerSendSnapshot } from "./workspace-shell-message-model";

export { agentInstanceStopBody } from "./agent-instance-stop";

export type AgentTraceGroup = {
  key: string;
  label: string;
  events: ObservabilityEvent[];
};

export {
  agentInstanceDisplayStatus,
  agentTraceEventPhase,
} from "./workspace-shell-presence";

export function Composer({
  compact = false,
  channel,
  attachmentsEnabled = true,
  draftIdentity,
  startsConversation = false,
  space,
  token,
  workspaces,
  localContext,
  isJoined,
  instanceTargetScope,
  draft,
  draftSeedRevision,
  invocationDraft,
  selectedWorkspaceId,
  replyTarget,
  attachments,
  mentionInsertRequest,
  autoFocusRequest,
  sending = false,
  error,
  onDraftChange,
  onWorkspaceSelect,
  onCancelReply,
  onAttachmentsChange,
  onOpenAppsForSpace,
  onSend,
  onEscape,
  placeholder,
  ariaLabel,
  sendTitle,
  inlineActions,
  afterSend,
}: {
  compact?: boolean;
  channel: SerializedChannel | null;
  attachmentsEnabled?: boolean;
  /** Identifies the draft when `channel` is not its own, e.g. a conversation that does not exist yet. */
  draftIdentity?: string;
  /**
   * The Channel does not exist yet: this is a new conversation, which its
   * first message creates. The composer is writable without one; files upload
   * to the Space as they arrive, as they do everywhere.
   */
  startsConversation?: boolean;
  space: SerializedSpace | null;
  token: string | null;
  workspaces: SerializedWorkspace[];
  localContext?: MentionLocalContext | null;
  isJoined: boolean;
  /**
   * "none" when the composer has no Channel of its own yet — a new
   * conversation — so no live instance is addressable from here.
   */
  instanceTargetScope?: MentionInstanceTargetScope;
  draft: string;
  /** Bumped by parent on every external seed so empty→empty / same-text channel switches still apply. */
  draftSeedRevision: number;
  invocationDraft?: ComposerInvocationDraft;
  selectedWorkspaceId: string | null;
  replyTarget: TimelineItem | null;
  attachments: ChannelAttachment[];
  mentionInsertRequest: ComposerMentionInsertRequest | null;
  autoFocusRequest: number;
  sending?: boolean;
  error: string | null;
  onDraftChange: (value: string, invocationDraft?: ComposerInvocationDraft) => void;
  onWorkspaceSelect: (workspaceTarget: string | null) => void;
  onCancelReply: () => void;
  onAttachmentsChange: (
    value: ChannelAttachment[] | ((current: ChannelAttachment[]) => ChannelAttachment[])
  ) => void;
  onOpenAppsForSpace: (spaceId: string) => void;
  onSend: (snapshot: ComposerSendSnapshot) => void | Promise<void>;
  onEscape?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  sendTitle?: string;
  /** Extra controls inside the input box, before Send. */
  inlineActions?: ReactNode;
  afterSend?: ReactNode;
}) {
  const writable = isJoined && (Boolean(channel) || startsConversation);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Local draft text so keystrokes re-render only Composer, not the message shell.
  // Parent `draft` is an external seed (channel restore / send clear / role inject).
  const [localDraft, setLocalDraft] = useState(draft);
  const invocationDraftRef = useRef<ComposerInvocationDraft | undefined>(invocationDraft);
  const invocationSeedRef = useRef(invocationDraft);
  invocationSeedRef.current = invocationDraft;
  const invocationScope = draftIdentity ?? channel?.id;
  const invocationScopeRef = useRef(invocationScope);
  useEffect(() => {
    setLocalDraft(draft);
    const previous = invocationScopeRef.current === invocationScope ? invocationDraftRef.current : undefined;
    invocationDraftRef.current = updateComposerInvocationDraft(invocationSeedRef.current ?? previous, draft);
    invocationScopeRef.current = invocationScope;
  }, [invocationScope, draft, draftSeedRevision]);
  const setDraftText = useCallback(
    (value: string) => {
      setLocalDraft(value);
      invocationDraftRef.current = updateComposerInvocationDraft(invocationDraftRef.current, value);
      onDraftChange(value, invocationDraftRef.current);
    },
    [onDraftChange]
  );
  const selectInvocation = (value: string, selected: AgentInvocationSelection, label?: string) => {
    invocationDraftRef.current = selectComposerInvocation(invocationDraftRef.current, value, selected, label);
    setLocalDraft(value);
    onDraftChange(value, invocationDraftRef.current);
  };
  const selectReference = (value: string, selected: ComposerReferenceBinding) => {
    invocationDraftRef.current = selectComposerReference(invocationDraftRef.current, value, selected);
    setLocalDraft(value);
    onDraftChange(value, invocationDraftRef.current);
  };
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [openComposerImageId, setOpenComposerImageId] = useState<string | null>(null);
  // Object URLs behind pending image previews, revoked when their card goes.
  const pendingPreviewUrlsRef = useRef(new Map<string, string>());
  const [preparingSend, setPreparingSend] = useState(false);
  const preparingSendRef = useRef(false);
  const [emptyPasteAnchorActive, setEmptyPasteAnchorActive] = useState(false);
  const uploadRegistryRef = useRef(createAttachmentUploadRegistry());
  const slotLedgerRef = useRef(createAttachmentSlotLedger());
  const handledMentionInsertRequestIdRef = useRef<number | null>(null);
  const handledAutoFocusRequestRef = useRef(0);
  // Set for the whole of an intake, including the reads that happen before any
  // row exists (the desktop clipboard bridge, a new conversation's round-trip).
  // Every source goes through beginAttachmentIntake, so no source can forget it.
  const [intakeBusy, setIntakeBusy] = useState(false);
  const intakeDepthRef = useRef(0);
  const uploadGateRef = useRef(boundedConcurrency(ATTACHMENT_UPLOAD_CONCURRENCY));
  const composerIdentity = draftIdentity ?? channel?.id ?? null;
  useLayoutEffect(() => setOpenComposerImageId(null), [composerIdentity]);
  const channelIdRef = useRef<string | null>(composerIdentity);
  const composerDropSinkId = useId();
  const readingAttachment =
    intakeBusy ||
    pendingAttachments.some((attachment) => attachment.status === "reading" || attachment.status === "uploading");
  const canSend =
    writable &&
    (localDraft.trim().length > 0 || attachments.length > 0) &&
    !readingAttachment &&
    !preparingSend &&
    !sending;
  const composerHint = useComposerHint(writable && !placeholder && localDraft.length === 0);
  const completionApiRef = useRef<ComposerCompletionApi | null>(null);
  const setCursor = useCallback((value: number) => {
    completionApiRef.current?.setCursor(value);
  }, []);
  const dismissCompletion = useCallback(() => {
    completionApiRef.current?.dismissCompletion();
  }, []);
  const cursor = completionApiRef.current?.cursor ?? 0;
  // An image can be opened as soon as it is in the composer, uploaded or not:
  // a new conversation keeps its files local until the message is sent.
  // Listed in the order the cards are drawn: pending first, then uploaded.
  const composerImages = useMemo(() => [
    ...pendingAttachments.flatMap((attachment) => attachment.kind === "image" && attachment.previewUrl
      ? [{ id: attachment.id, name: attachment.name, src: attachment.previewUrl }] : []),
    ...attachments.flatMap((attachment) => attachment.kind === "image"
      ? [{ id: attachment.id, name: attachment.name, src: attachment.url ?? attachment.dataUrl ?? "" }] : []),
  ], [attachments, pendingAttachments]);
  const openComposerImage = composerImages.find((image) => image.id === openComposerImageId) ?? null;
  useAndroidBackHandler(Boolean(openComposerImage), () => {
    setOpenComposerImageId(null);
    return true;
  });

  const navigateComposerImage = useCallback((direction: -1 | 1) => {
    if (!openComposerImageId) return;
    if (composerImages.length < 2) return;
    const currentIndex = composerImages.findIndex((image) => image.id === openComposerImageId);
    const nextIndex = (Math.max(0, currentIndex) + direction + composerImages.length) % composerImages.length;
    setOpenComposerImageId(composerImages[nextIndex].id);
  }, [composerImages, openComposerImageId]);

  useEffect(() => {
    if (!openComposerImageId) return;
    if (!composerImages.some((image) => image.id === openComposerImageId)) {
      setOpenComposerImageId(null);
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenComposerImageId(null);
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        navigateComposerImage(event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [composerImages, navigateComposerImage, openComposerImageId]);

  useLayoutEffect(() => {
    if (!writable || autoFocusRequest <= 0) return;
    if (handledAutoFocusRequestRef.current === autoFocusRequest) return;
    handledAutoFocusRequestRef.current = autoFocusRequest;

    focusComposerTextarea();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per focus request, not per draft edit
  }, [autoFocusRequest, writable]);

  useLayoutEffect(() => {
    if (!emptyPasteAnchorActive || localDraft.length > 0) return;
    const textarea = textareaRef.current;
    if (!textarea || document.activeElement !== textarea) return;
    if (stripEmptyPasteSentinel(textarea.value).length > 0) return;

    const selection = emptyPasteAnchorSelection(localDraft.length);
    textarea.setSelectionRange(selection.start, selection.end);
    const frame = window.requestAnimationFrame(() => {
      if (stripEmptyPasteSentinel(textarea.value).length > 0) return;
      textarea.setSelectionRange(selection.start, selection.end);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [localDraft.length, emptyPasteAnchorActive]);

  useLayoutEffect(() => {
    // Only the main floating channel composer owns timeline clearance. The
    // compact thread draft lives inside a message row and must not overwrite
    // --app-composer-height (or clear it on unmount), or padding/scroll
    // metrics jump while a reply is open.
    if (compact) return;

    const composer = composerRef.current;
    const surface = messageSurfaceOf(composer);
    if (!composer || !surface) return;
    const composerElement = composer;
    const surfaceElement = surface;

    function updateComposerMetrics() {
      surfaceElement.style.setProperty("--app-composer-height", `${composerElement.offsetHeight}px`);
      // Overlays anchored to this variable only move, so nothing resizes and no
      // observer of theirs is delivered. Announce the write; see
      // MESSAGE_SURFACE_METRICS_EVENT for why the writer has to be the one to.
      surfaceElement.dispatchEvent(new Event(MESSAGE_SURFACE_METRICS_EVENT));
    }

    // Mount once and let ResizeObserver react to real size changes (growing
    // field-sizing textarea, attachments, reply chrome). Do not depend on
    // `draft`: each keystroke would force layout of the whole message surface.
    updateComposerMetrics();
    const observer = new ResizeObserver(updateComposerMetrics);
    observer.observe(composerElement);
    observer.observe(surfaceElement);
    window.addEventListener("resize", updateComposerMetrics);
    window.visualViewport?.addEventListener("resize", updateComposerMetrics);
    window.visualViewport?.addEventListener("scroll", updateComposerMetrics);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateComposerMetrics);
      window.visualViewport?.removeEventListener("resize", updateComposerMetrics);
      window.visualViewport?.removeEventListener("scroll", updateComposerMetrics);
      surfaceElement.style.removeProperty("--app-composer-height");
    };
  }, [compact]);

  useEffect(() => {
    const uploadRegistry = uploadRegistryRef.current;
    const previewUrls = pendingPreviewUrlsRef.current;
    return () => {
      uploadRegistry.cancelAll();
      for (const url of previewUrls.values()) URL.revokeObjectURL(url);
      previewUrls.clear();
    };
  }, []);

  // The composer is reused across channels while `attachments` follows the
  // selected channel's draft, so an upload that outlives the switch would
  // commit into a draft it was never meant for. Leaving a channel bumps the
  // registry generation, which is why coming back to it (A→B→A) cannot revive
  // the work that belonged to the previous visit.
  useEffect(() => {
    const nextChannelId = composerIdentity;
    if (channelIdRef.current === nextChannelId) return;
    channelIdRef.current = nextChannelId;
    uploadRegistryRef.current.cancelAll();
    for (const url of pendingPreviewUrlsRef.current.values()) URL.revokeObjectURL(url);
    pendingPreviewUrlsRef.current.clear();
    slotLedgerRef.current.clear();
    setPendingAttachments([]);
    setAttachmentError(null);
  }, [composerIdentity]);

  useEffect(() => {
    if (!mentionInsertRequest || handledMentionInsertRequestIdRef.current === mentionInsertRequest.id) {
      return;
    }
    handledMentionInsertRequestIdRef.current = mentionInsertRequest.id;
    if (!writable) return;

    const target = textareaRef.current;
    const nextCursor = target
      ? target.selectionStart || 0
      : cursor;
    const next = insertMentionIntoDraft(localDraft, nextCursor, mentionInsertRequest.mention);
    setDraftText(next.value);
    setCursor(next.cursor);
    dismissCompletion();
    onWorkspaceSelect(null);
    scheduleTextareaSelection(
      () => textareaRef.current,
      next.value,
      { start: next.cursor, end: next.cursor }
    );
  }, [dismissCompletion, cursor, writable, localDraft, mentionInsertRequest, onWorkspaceSelect, setCursor, setDraftText]);

  function syncCursor(target: HTMLTextAreaElement) {
    setCursor(composerDraftCursor(target.value, target.selectionStart));
  }

  function primeEmptyPasteAnchor(target?: HTMLTextAreaElement | null) {
    if (localDraft.length > 0 || emptyPasteAnchorActive) return;
    setEmptyPasteAnchorActive(true);
    window.requestAnimationFrame(() => {
      const textarea = target || textareaRef.current;
      if (!textarea || stripEmptyPasteSentinel(textarea.value).length > 0) return;
      const selection = emptyPasteAnchorSelection(localDraft.length);
      textarea.focus();
      textarea.setSelectionRange(selection.start, selection.end);
    });
  }

  function clearEmptyPasteAnchor() {
    setEmptyPasteAnchorActive(false);
  }

  function clearEmptyPasteAnchorForIme(target: HTMLTextAreaElement) {
    if (!emptyPasteAnchorActive || localDraft.length > 0) return;
    flushSync(() => setEmptyPasteAnchorActive(false));
    target.value = "";
    target.setSelectionRange(0, 0);
    setCursor(0);
  }

  function focusComposerTextarea() {
    const textarea = textareaRef.current;
    if (!textarea || textarea.disabled) return;
    if (localDraft.length === 0) {
      setEmptyPasteAnchorActive(true);
    }

    const selection = composerPointerFocusSelection({
      draftLength: localDraft.length,
      textareaValueLength: textarea.value.length,
    });
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(selection.start, selection.end);
    if (localDraft.length === 0) {
      const scheduledTextarea = textarea;
      window.requestAnimationFrame(() => {
        const currentTextarea = textareaRef.current;
        if (
          currentTextarea !== scheduledTextarea ||
          currentTextarea.disabled ||
          stripEmptyPasteSentinel(currentTextarea.value).length > 0
        ) {
          return;
        }
        currentTextarea.focus({ preventScroll: true });
        currentTextarea.setSelectionRange(selection.start, selection.end);
      });
      return;
    }
    scheduleTextareaSelection(
      () => textareaRef.current,
      textarea.value,
      selection,
      { preventScroll: true }
    );
  }

  function insertClipboardText(text: string, selectionStart: number, selectionEnd: number) {
    if (!text) return;
    const start = Math.max(0, Math.min(selectionStart, localDraft.length));
    const end = Math.max(start, Math.min(selectionEnd, localDraft.length));
    const value = `${localDraft.slice(0, start)}${text}${localDraft.slice(end)}`;
    const nextCursor = start + text.length;
    clearEmptyPasteAnchor();
    setDraftText(value);
    setCursor(nextCursor);
    scheduleTextareaSelection(
      () => textareaRef.current,
      value,
      { start: nextCursor, end: nextCursor }
    );
  }

  /**
   * The one door into the composer for files, whatever produced them. `load`
   * covers the reads that have to happen before the files are even known (the
   * desktop clipboard bridge); the composer counts as busy for that too, so
   * there is no window where files are inbound and Enter still sends.
   */
  async function beginAttachmentIntake(
    load: () => AttachmentDropCandidate[] | Promise<AttachmentDropCandidate[]>
  ): Promise<number> {
    intakeDepthRef.current += 1;
    setIntakeBusy(true);
    setAttachmentError(null);
    try {
      const candidates = await load();
      return await intakeAttachmentCandidates(candidates);
    } catch (error) {
      // Drop and the file picker call this fire-and-forget, so a rejection here
      // would surface as an unhandled rejection and nothing else. Whatever rows
      // exist have already been failed by the stage that threw.
      setAttachmentError((error as Error)?.message || "Could not attach the file.");
      return 0;
    } finally {
      intakeDepthRef.current -= 1;
      if (intakeDepthRef.current <= 0) {
        intakeDepthRef.current = 0;
        setIntakeBusy(false);
      }
    }
  }

  async function intakeAttachmentCandidates(candidates: AttachmentDropCandidate[]): Promise<number> {
    // Reservations the rendered rows already account for stop being
    // reservations; what is left is the intakes whose rows have not landed yet.
    const ledger = slotLedgerRef.current;
    ledger.reconcile(new Set(pendingAttachments.map((attachment) => attachment.id)));

    const plan = planAttachmentIntake({
      candidates,
      attachmentsEnabled,
      draftCount: attachments.length,
      pendingCount: pendingAttachments.length + ledger.reservedCount(),
      maxAttachments: MAX_ATTACHMENTS,
      maxBytes: MAX_ATTACHMENT_BYTES,
      maxBytesLabel: formatFileSize(MAX_ATTACHMENT_BYTES),
      kindOf: channelAttachmentKindForFile,
      nameOf: defaultAttachmentName,
      makeId: () => crypto.randomUUID(),
    });

    // Rows first, awaits after. Everything below this point can take a network
    // round-trip; nothing below it may be the first thing the user sees.
    if (plan.entries.length > 0) {
      ledger.reserve(plan.entries.map((entry) => entry.id));
      setPendingAttachments((current) => [
        ...current,
        ...plan.entries.map<PendingAttachment>((entry) => ({
          id: entry.id,
          name: entry.name,
          kind: entry.kind,
          size: entry.size,
          previewUrl: entry.kind === "image" && !entry.rejection ? pendingPreviewUrl(entry) : undefined,
          status: entry.rejection ? "failed" : "reading",
          progress: 0,
          error: entry.rejection ?? undefined,
        })),
      ]);
    }
    if (plan.error) setAttachmentError(plan.error);

    const uploadable = plan.entries.filter((entry) => !entry.rejection);
    if (uploadable.length > 0) await uploadAttachmentEntries(uploadable);
    return plan.entries.length;
  }

  async function uploadAttachmentEntries(
    entries: AttachmentIntakeEntry<File>[]
  ): Promise<void> {
    const registry = uploadRegistryRef.current;
    // Claimed before the first await, so a card removed meanwhile is already
    // dead when its task starts.
    const generation = registry.generation();
    for (const entry of entries) registry.begin(entry.id);

    function failEntries(message: string) {
      for (const entry of entries) {
        registry.settle(entry.id);
        updatePendingAttachment(entry.id, { status: "failed", error: message, progress: 0 });
      }
    }

    // An upload only makes the file exist in the Space; who can see it is set
    // when a message references it, from that message's Channel. So nothing
    // here waits for a Channel, including one a new conversation has not made.
    const spaceId = channel?.spaceId ?? space?.id;
    if (!spaceId || !token) {
      failEntries("Could not prepare the upload.");
      return;
    }

    const run = uploadGateRef.current;
    const uploadToken = token;
    // An open Channel's files are visible to its whole Space, so the scope exists before the Channel does.
    const scope = spaceVisibilityScope(spaceId);
    const uploads = entries.map((entry) =>
      run(() => uploadAttachmentEntry(entry, scope, uploadToken, generation)).then(
        (attachment) => ({ ok: true as const, attachment }),
        (error: unknown) => ({ ok: false as const, error })
      )
    );

    // Uploads overlap, but they are committed in the order the files arrived so
    // a dropped batch keeps the order it was dropped in.
    for (const [index, upload] of uploads.entries()) {
      const entry = entries[index];
      const result = await upload;
      // Checked here as well as inside the task: a card can be removed while an
      // upload that already finished waits its turn to commit.
      if (!registry.isLive(entry.id, generation)) {
        clearPendingAttachment(entry.id);
        continue;
      }
      if (!result.ok) {
        registry.settle(entry.id);
        updatePendingAttachment(entry.id, {
          status: "failed",
          error: (result.error as Error)?.message || "Upload failed",
          progress: 0,
        });
        continue;
      }
      if (!result.attachment) {
        clearPendingAttachment(entry.id);
        continue;
      }
      const uploaded = result.attachment;
      clearPendingAttachment(entry.id);
      appendDraftAttachment(uploaded);
      if (uploaded.kind === "video") {
        void attachVideoMetadata(entry.file, uploaded).then((withMetadata) => {
          updateDraftAttachment(uploaded.id, withMetadata);
        });
      }
    }
  }

  async function submitComposer() {
    // Enter reaches here without the Send button's gate: a file still being
    // read would otherwise be left behind while the text goes out.
    if (!canSend || preparingSendRef.current) return;
    preparingSendRef.current = true;
    setPreparingSend(true);
    setAttachmentError(null);
    try {
      // Picked channels and pages are shown by name and sent as their id tokens.
      const { body, selections } = composerSendDraft(invocationDraftRef.current, localDraft);
      const sourceBodyHash = selections.length ? await digestCanonicalCloneCborV1(body) : undefined;
      const invocationSelections = sourceBodyHash ? parseAgentInvocationSelections({ schemaVersion: 1,
        sourceRevision: 1, sourceBodyHash, selections }, {
        spaceId: space?.id ?? channel?.spaceId ?? "", body, bodyHash: sourceBodyHash, revision: 1,
      }) : undefined;
      await onSend({
        body,
        ...(invocationSelections ? { invocationSelections } : {}),
        attachments,
      });
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Could not prepare the message.");
    } finally {
      preparingSendRef.current = false;
      setPreparingSend(false);
    }
  }

  /** Resolves to null when the task was cancelled at one of the stage boundaries. */
  async function uploadAttachmentEntry(
    entry: AttachmentIntakeEntry<File>,
    uploadScope: string,
    uploadToken: string,
    generation: number
  ): Promise<ChannelAttachment | null> {
    const registry = uploadRegistryRef.current;
    // Queued behind the concurrency gate: nothing to abort, so the check is the
    // only thing standing between a removed card and an upload that still runs.
    if (!registry.isLive(entry.id, generation)) return null;

    let uploadFile = entry.file;
    if (entry.kind === "image") {
      const prepared = await prepareImageAttachmentFile(entry.file);
      if (!registry.isLive(entry.id, generation)) return null;
      if (!prepared) throw new Error("Image must be 1 MB or smaller.");
      uploadFile = prepared;
      if (uploadFile.size !== entry.file.size || uploadFile.name !== entry.file.name) {
        updatePendingAttachment(entry.id, {
          name: uploadFile.name || entry.name,
          size: uploadFile.size,
        });
      }
    }

    updatePendingAttachment(entry.id, { status: "uploading", progress: 4 });
    const uploaded = await uploadChannelAttachment(
      uploadScope,
      uploadToken,
      uploadFile,
      (progress) => updatePendingAttachment(entry.id, { progress }),
      (request) => registry.trackRequest(entry.id, request)
    );
    return registry.isLive(entry.id, generation) ? uploaded : null;
  }

  function fileCandidates(files: FileList | File[]): AttachmentDropCandidate[] {
    return Array.from(files).map((file) => ({ file }));
  }

  async function clipboardImageCandidates(
    images: DesktopClipboardImage[]
  ): Promise<AttachmentDropCandidate[]> {
    const candidates: AttachmentDropCandidate[] = [];
    for (const image of images) {
      if (!image.mimeType.startsWith("image/")) continue;
      if (!IMAGE_ATTACHMENT_TYPES.has(image.mimeType)) {
        setAttachmentError("Only PNG, JPEG, WebP, and GIF images are supported.");
        continue;
      }
      const blob = await xmatrixRawResponse(image.dataUrl).then((response) => response.blob()).catch(() => null);
      if (!blob || blob.size <= 0) {
        setAttachmentError("Failed to read the pasted image.");
        continue;
      }
      candidates.push({
        file: new File([blob], image.name || "pasted-image", { type: image.mimeType }),
      });
    }
    return candidates;
  }

  async function pasteNativeClipboardImages(): Promise<boolean> {
    const bridge = getDesktopBridge();
    if (!bridge?.getClipboardImages) return false;

    const accepted = await beginAttachmentIntake(async () => {
      const nativeClipboardImages = await bridge.getClipboardImages!();
      return nativeClipboardImages.length > 0 ? clipboardImageCandidates(nativeClipboardImages) : [];
    });
    return accepted > 0;
  }

  async function addPastedImages(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = pastedImageFiles(event.clipboardData);
    if (files.length > 0) {
      event.preventDefault();
      await beginAttachmentIntake(() => fileCandidates(files));
      return;
    }

    if (!event.clipboardData) {
      return;
    }

    const bridge = getDesktopBridge();
    if (!bridge?.getClipboardImages) {
      return;
    }

    const target = event.currentTarget;
    const text = stripEmptyPasteSentinel(event.clipboardData.getData("text/plain") || event.clipboardData.getData("text"));
    const selectionStart = emptyPasteAnchorActive ? 0 : target.selectionStart ?? localDraft.length;
    const selectionEnd = emptyPasteAnchorActive ? 0 : target.selectionEnd ?? selectionStart;
    const hasText = clipboardHasTextPayload(event.clipboardData);
    event.preventDefault();

    const addedImage = await pasteNativeClipboardImages();
    if (addedImage) {
      clearEmptyPasteAnchor();
    }
    if (!addedImage && hasText) {
      insertClipboardText(text, selectionStart, selectionEnd);
    }
  }

  function removeAttachment(id: string) {
    onAttachmentsChange((current) => current.filter((attachment) => attachment.id !== id));
  }

  function appendDraftAttachment(attachment: ChannelAttachment) {
    onAttachmentsChange((current) => [...current, attachment]);
  }

  function updateDraftAttachment(id: string, attachment: ChannelAttachment) {
    onAttachmentsChange((current) =>
      current.map((currentAttachment) =>
        currentAttachment.id === id ? { ...currentAttachment, ...attachment } : currentAttachment
      )
    );
  }

  function updatePendingAttachment(id: string, patch: Partial<PendingAttachment>) {
    setPendingAttachments((current) =>
      current.map((attachment) => (attachment.id === id ? { ...attachment, ...patch } : attachment))
    );
  }

  function removePendingAttachment(id: string) {
    // Tombstone rather than abort-only: at this moment the task may be queued or
    // compressing, with no request to abort and nothing else to stop it landing.
    uploadRegistryRef.current.cancel(id);
    clearPendingAttachment(id);
  }

  function pendingPreviewUrl(entry: AttachmentIntakeEntry<File>): string {
    const url = URL.createObjectURL(entry.file);
    pendingPreviewUrlsRef.current.set(entry.id, url);
    return url;
  }

  function clearPendingAttachment(id: string) {
    const previewUrl = pendingPreviewUrlsRef.current.get(id);
    if (previewUrl) {
      pendingPreviewUrlsRef.current.delete(id);
      URL.revokeObjectURL(previewUrl);
    }
    uploadRegistryRef.current.settle(id);
    slotLedgerRef.current.settle(id);
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  // Drops are collected by the window-wide drop surface; the composer only says
  // it is the place they should land. Owning listeners here is what used to make
  // the input strip the sole target in a full-screen window.
  const { isDropTarget } = useAttachmentDropSink({
    id: composerDropSinkId,
    active: attachmentsEnabled && writable,
    priority: compact ? 1 : 0,
    label: channel?.name ? `#${channel.name}` : null,
    onCandidates: (candidates) => {
      void beginAttachmentIntake(() => candidates);
    },
  });

  function focusComposerTextareaFromPointer(event: ReactPointerEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (
      target.closest(
        "a, button, input, textarea, select, [role='button'], [contenteditable='true'], .composer-image-attachment"
      )
    ) {
      return;
    }

    focusComposerTextarea();
  }

  return (
    <div
      ref={composerRef}
      className={cn(
        compact
          ? "app-thread-composer shrink-0 bg-transparent px-0 pb-0 pt-0"
          : "app-composer shrink-0 bg-card px-3 pb-2 pt-2 sm:px-5 sm:pb-5 sm:pt-3",
      )}
    >
      {error && <p className="mb-2 text-sm font-medium text-destructive">{error}</p>}
      {attachmentError && <p className="mb-2 text-sm font-medium text-destructive">{attachmentError}</p>}
      {Boolean(invocationDraftRef.current?.bindings.some(isAgentBinding)) && <div aria-label="Selected Agents" className="mb-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
        {invocationDraftRef.current?.bindings.filter(isAgentBinding).map(binding => <span key={`${binding.start}:${binding.end}`}>
          {binding.label ?? binding.text}
        </span>)}
      </div>}
      {!channel || isJoined ? null : (
        <div className="mb-2 flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <span>Join this channel before sending messages.</span>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const picked = event.target.files ? fileCandidates(event.target.files) : [];
          if (picked.length > 0) void beginAttachmentIntake(() => picked);
          event.target.value = "";
        }}
      />
              <ComposerInputAuthority
          density={compact ? "compact" : "default"}
          draft={localDraft}
          onDraftChange={setDraftText}
          onInvocationSelect={selectInvocation}
          onReferenceSelect={selectReference}
          referenceRanges={invocationDraftRef.current?.bindings.filter((binding) => !isAgentBinding(binding))}
          channel={channel}
          space={space}
          token={token}
          workspaces={workspaces}
          localContext={localContext}
          enabled={writable}
          instanceTargetScope={instanceTargetScope}
          disabled={!writable || sending || preparingSend}
          sending={sending || preparingSend}
          canSend={canSend}
          onSend={() => void submitComposer()}
          selectedWorkspaceId={selectedWorkspaceId}
          onWorkspaceSelect={onWorkspaceSelect}
          onConfigureAppConnector={() => {
            if (space) onOpenAppsForSpace(space.id);
          }}
          completionApiRef={completionApiRef}
          textareaRef={textareaRef}
          placeholder={placeholder || (channel && !isJoined ? "Join channel to send" : composerHint)}
          ariaLabel={ariaLabel || "Message composer"}
          sendTitle={sendTitle || "Send"}
          onEscape={onEscape}
          boxClassName={cn(isDropTarget && "border-primary ring-2 ring-primary/20")}
          onBoxPointerDown={focusComposerTextareaFromPointer}
          textareaValue={emptyPasteAnchorActive && localDraft.length === 0 ? EMPTY_COMPOSER_PASTE_SENTINEL : localDraft}
          onTextareaChange={(event) => {
            const value = stripEmptyPasteSentinel(event.target.value);
            if (value.length > 0) {
              clearEmptyPasteAnchor();
            }
            setDraftText(value);
            syncCursor(event.target);
          }}
          onTextareaBeforeInput={(event) => {
            if (isComposerImeBeforeInput(event.nativeEvent as InputEvent)) {
              clearEmptyPasteAnchorForIme(event.currentTarget);
            }
          }}
          onTextareaCompositionStart={(event) => {
            clearEmptyPasteAnchorForIme(event.currentTarget);
          }}
          onTextareaFocus={(event) => {
            primeEmptyPasteAnchor(event.currentTarget);
          }}
          onTextareaBlur={() => {
            if (localDraft.length === 0) {
              clearEmptyPasteAnchor();
            }
          }}
          onTextareaTouchStart={(event) => {
            primeEmptyPasteAnchor(event.currentTarget);
          }}
          onTextareaPointerDown={(event) => {
            if (event.pointerType === "touch" || event.pointerType === "pen") {
              primeEmptyPasteAnchor(event.currentTarget);
            }
          }}
          onTextareaPointerUp={(event) => {
            if (localDraft.length > 0) return;
            const selection = emptyPasteAnchorSelection(localDraft.length);
            event.currentTarget.setSelectionRange(selection.start, selection.end);
            setCursor(selection.start);
          }}
          onTextareaClick={(event) => {
            if (localDraft.length > 0) return;
            // Native touch selection may run after pointerup. Click is the last
            // event in that gesture, so enforce the empty-paste caret here too.
            const selection = emptyPasteAnchorSelection(localDraft.length);
            event.currentTarget.setSelectionRange(selection.start, selection.end);
            setCursor(selection.start);
          }}
          onTextareaPaste={(event) => {
            void addPastedImages(event);
          }}
          onKeyDownExtra={(event) => {
            if (
              (event.key === "Backspace" || event.key === "Delete") &&
              localDraft.length === 0 &&
              attachments.length > 0
            ) {
              event.preventDefault();
              onAttachmentsChange((current) => current.slice(0, -1));
            }
          }}
          inputLeading={
            <div className="composer-inline-actions composer-attach flex shrink-0 items-center text-muted-foreground">
              <ComposerIcon
                label="Attach file"
                icon={Paperclip}
                disabled={!attachmentsEnabled}
                onClick={() => fileInputRef.current?.click()}
              />
            </div>
          }
          boxHeader={
            <>
              {replyTarget && (
                <div className="flex items-start gap-2 border-b border-border/70 px-3 py-2 text-xs text-muted-foreground">
                  <Reply className="mt-0.5 size-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-bold text-foreground">
                      Replying to {replyTarget.author}
                    </div>
                    <div className="line-clamp-2 [overflow-wrap:anywhere]">
                      {replyTarget.body || "Attachment"}
                    </div>
                    {replyTarget.linkOrigin?.kind === "link" && (
                      <div className="mt-1 font-medium">
                        {replyTarget.linkOrigin.channelName
                          ? `Your reply will also be posted in #${replyTarget.linkOrigin.channelName}.`
                          : "Your reply will also be posted in the Channel this Agent works in."}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    title="Cancel reply"
                    aria-label="Cancel reply"
                    onClick={onCancelReply}
                    className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}
              {(attachments.length > 0 || pendingAttachments.length > 0) && (
                <div className="flex gap-2 overflow-x-auto px-3 py-3">
                  {pendingAttachments.map((attachment) => (
                    <PendingAttachmentCard
                      key={attachment.id}
                      attachment={attachment}
                      onOpen={() => setOpenComposerImageId(attachment.id)}
                      onRemove={() => removePendingAttachment(attachment.id)}
                    />
                  ))}
                  {attachments.map((attachment) =>
                    attachment.kind === "video" ? (
                      <div
                        key={attachment.id}
                        className="group relative flex h-20 w-44 shrink-0 overflow-hidden rounded-md border border-border bg-muted"
                      >
                        <div className="flex size-20 shrink-0 items-center justify-center bg-black text-white">
                          {attachment.thumbnailUrl ? (
                            <LoadingImage
                              src={attachment.thumbnailUrl}
                              alt={attachment.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <Video className="size-7" />
                          )}
                        </div>
                        <ReadyAttachmentDetails attachment={attachment} separator="·" onRemove={() => removeAttachment(attachment.id)} />
                      </div>
                    ) : attachment.kind === "markdown" || attachment.kind === "file" ? (
                      <div
                        key={attachment.id}
                        className="group relative flex h-20 w-44 shrink-0 overflow-hidden rounded-md border border-border bg-muted"
                      >
                        <div className="flex size-20 shrink-0 items-center justify-center bg-background text-muted-foreground">
                          {attachment.kind === "markdown" ? <FileText className="size-7" /> : <Paperclip className="size-7" />}
                        </div>
                        <ReadyAttachmentDetails attachment={attachment} separator="-" onRemove={() => removeAttachment(attachment.id)} />
                      </div>
                    ) : (
                      <div
                        key={attachment.id}
                        className="composer-image-attachment group relative h-20 w-20 shrink-0 overflow-visible rounded-md border border-border bg-muted"
                      >
                        <button
                          type="button"
                          aria-label={`Open ${attachment.name}`}
                          className="block h-full w-full cursor-zoom-in rounded-md"
                          onClick={() => setOpenComposerImageId(attachment.id)}
                        >
                          <LoadingImage
                            src={attachment.url ?? attachment.dataUrl ?? ""}
                            alt={attachment.name}
                            className="block h-full w-full rounded-md object-cover"
                          />
                        </button>
                        <button
                          type="button"
                          title="Remove attachment"
                          aria-label={`Remove ${attachment.name}`}
                          onClick={() => removeAttachment(attachment.id)}
                          className="composer-image-remove absolute -right-2 -top-2 z-20 flex size-7 items-center justify-center rounded-full bg-background text-foreground shadow-md ring-1 ring-border hover:bg-muted"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    )
                  )}
                </div>
              )}
              {openComposerImage && typeof document !== "undefined" && createPortal(
                <div
                  className="app-attachment-lightbox fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 text-white backdrop-blur-md sm:p-5"
                  role="presentation"
                  onMouseDown={(event) => {
                    if (event.target === event.currentTarget) setOpenComposerImageId(null);
                  }}
                >
                  <div
                    role="dialog"
                    aria-modal="true"
                    aria-label={openComposerImage.name}
                    className="app-attachment-lightbox-dialog relative flex h-full max-h-[94dvh] w-full max-w-[96vw] items-center justify-center"
                  >
                    <button
                      type="button"
                      title="Close attachment"
                      aria-label="Close attachment"
                      autoFocus
                      onClick={() => setOpenComposerImageId(null)}
                      className="app-attachment-lightbox-close absolute right-1 top-1 z-20 flex size-10 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition hover:bg-black/75"
                    >
                      <X className="size-5" />
                    </button>
                    <ZoomableAttachmentImage
                      src={openComposerImage.src}
                      alt={openComposerImage.name}
                      resetKey={openComposerImage.id}
                      onRequestClose={() => setOpenComposerImageId(null)}
                      onNavigate={navigateComposerImage}
                    />
                    {composerImages.length > 1 && (
                      <>
                        <button
                          type="button"
                          title="Previous image"
                          aria-label="Previous image"
                          onClick={() => navigateComposerImage(-1)}
                          className="app-attachment-lightbox-previous absolute left-1 top-1/2 z-20 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition hover:bg-black/75"
                        >
                          <ChevronLeft className="size-6" />
                        </button>
                        <button
                          type="button"
                          title="Next image"
                          aria-label="Next image"
                          onClick={() => navigateComposerImage(1)}
                          className="app-attachment-lightbox-next absolute right-1 top-1/2 z-20 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition hover:bg-black/75"
                        >
                          <ChevronRight className="size-6" />
                        </button>
                        <div className="absolute bottom-1 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-xs font-bold">
                          {composerImages.findIndex((attachment) => attachment.id === openComposerImage.id) + 1} / {composerImages.length}
                        </div>
                      </>
                    )}
                  </div>
                </div>,
                document.body
              )}
            </>
          }
          afterSend={afterSend}
          inputTrailing={
            inlineActions ? (
              <div className="composer-inline-actions flex shrink-0 items-center gap-1 text-muted-foreground">
                {inlineActions}
              </div>
            ) : null
          }
        />
    </div>
  );
}

export function ComposerIcon({
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="composer-icon app-composer-inline-icon flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <Icon className="size-[18px] stroke-[1.75]" />
    </button>
  );
}

/** Who wrote a summary, how far it reads, and how far the conversation has moved on since. */
function summarySourceLine(source: ChannelSummarySource, historyHeadSequence: number | undefined): string {
  const parts = [`By ${source.author.agentName}`];
  if (source.throughSequence) {
    parts.push(`through #${source.throughSequence}`);
    const behind = (historyHeadSequence ?? 0) - source.throughSequence;
    if (behind > 0) parts.push(`${behind} newer`);
  }
  parts.push(relativeTime(source.generatedAt));
  return parts.join(" · ");
}

export function ChannelDetails({
  channel,
  space,
  workspaces,
  token,
  connectorRevision,
  currentUserMemberId,
  currentUserId,
  onOpenAgentTrace,
  onRunChannelCommand,
  onManageApps,
  automations,
  automationExecutionEnabled,
  automationBusy,
  loadingAutomations,
  onToggleAutomation,
  onUpdateAutomation,
  onDeleteAutomation,
  onOpenSchedule,
  wideOnly = false,
  mobileOverlayOpen = false,
  onCloseMobileOverlay,
}: {
  channel: SerializedChannel | null;
  space: SerializedSpace | null;
  /** Registered working directories, the only record that knows a repository. */
  workspaces: SerializedWorkspace[];
  token?: string;
  connectorRevision?: string;
  currentUserMemberId: string;
  /** The reader's user id, as Space members and Automation authors name them (no `user:` prefix). */
  currentUserId: string;
  onOpenAgentTrace: (target: AgentTraceTarget) => void;
  /**
   * Post a command (`@github:subscribe:…`, `@agent:1 /model …`) as a message in
   * this channel. One decision is one message; a command that needs several
   * statements writes them as lines of that one message.
   */
  onRunChannelCommand?: (body: string) => void;
  onManageApps: () => void;
  automations: SerializedAutomation[];
  automationExecutionEnabled: boolean | null;
  automationBusy: string | null;
  loadingAutomations: boolean;
  onToggleAutomation: (automation: SerializedAutomation) => void;
  onUpdateAutomation: (automationId: string, input: Omit<AutomationUpdateRequest, "expectedVersion">) => void;
  onDeleteAutomation: (automation: SerializedAutomation) => void;
  /** Opens Schedules at one Automation, with its editor. */
  onOpenSchedule: (automationId: string) => void;
  wideOnly?: boolean;
  /** Mobile "More" entry: present this rail as a full-screen channel details sheet. */
  mobileOverlayOpen?: boolean;
  onCloseMobileOverlay?: () => void;
}) {
  const machineCatalog = useAgentRegistrationCatalog(space?.id ?? "", token ?? "", Boolean(space?.id && token));
  const [aboutSummaryBusy, setAboutSummaryBusy] = useState(false);
  const [aboutSummaryError, setAboutSummaryError] = useState<string | null>(null);
  const [editingAutomationId, setEditingAutomationId] = useState<string | null>(null);
  const [automationMessageDraft, setAutomationMessageDraft] = useState("");
  const [automationIntervalDraft, setAutomationIntervalDraft] = useState(AUTOMATION_MIN_INTERVAL_MINUTES);
  const channelId = channel?.id;
  const channelSpaceId = channel?.spaceId;
  useEffect(() => {
    setEditingAutomationId(null);
    setAboutSummaryError(null);
  }, [channelId]);

  const members = useMemo(() => (
    channel ? visibleHumanChannelMembers(channel, space) : []
  ), [channel, space]);
  const agentItems = useMemo(
    () => channelOnlineAgentAvatarItems(channel),
    [channel]
  );
  const connectorsQuery = useQuery({
    queryKey: xmatrixQueryKeys.domain(
      { userId: currentUserMemberId || "anonymous" },
      "channel-app-connections",
      [channelSpaceId ?? null, channelId ?? null, connectorRevision ?? null],
    ),
    queryFn: ({ signal }) => xmatrixApiRequest<{
      connections?: SerializedAppConnectorConnection[];
    }>({
      url: WEB_PROXY_ROUTES.space_app_connections(channelSpaceId!, channelId!),
      token,
      signal,
    }).then((payload) => payload.connections ?? []),
    enabled: Boolean(token && channelId && channelSpaceId),
  });
  const connectorConnections = connectorsQuery.data ?? [];
  const connectorsLoading = connectorsQuery.isPending && connectorsQuery.isEnabled;
  const connectorsError = connectorsQuery.error?.message ?? null;

  const requestAboutSummary = useCallback(async () => {
    if (!token || !channel || aboutSummaryBusy) return;
    setAboutSummaryBusy(true);
    setAboutSummaryError(null);
    try {
      await requestChannelAboutReview({ token, channel });
    } catch (error) {
      setAboutSummaryError(error instanceof Error ? error.message : String(error));
    } finally {
      setAboutSummaryBusy(false);
    }
  }, [aboutSummaryBusy, channel, token]);

  const channelAutomations = useMemo(
    () => automations.filter((automation) => automation.channelId === channelId),
    [automations, channelId]
  );
  const currentSpaceRole = space?.members.find(
    (member) => member.userId === currentUserId
  )?.role;
  const canCreateAutomation = Boolean(
    currentSpaceRole &&
    currentSpaceRole !== "viewer" &&
    spaceMemberCanCreate(space, currentUserId, "automationCreation")
  );
  // Any Channel member may rewrite a schedule; saving someone else's replaces it
  // with one that runs as you, which the Space's creation policy also governs.
  const authoredByCurrentUser = (automation: SerializedAutomation) =>
    automation.authorityRootUserId === currentUserId;
  const canEditAutomation = (automation: SerializedAutomation) =>
    automation.capabilities.update &&
    (authoredByCurrentUser(automation) || canCreateAutomation);
  const startEditingAutomation = (automation: SerializedAutomation) => {
    setEditingAutomationId(automation.id);
    setAutomationMessageDraft(automation.expression.text);
    setAutomationIntervalDraft(automation.intervalMinutes);
  };

  useEffect(() => {
    if (!mobileOverlayOpen || !onCloseMobileOverlay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseMobileOverlay();
    };
    // Desktop already has the permanent rail; dismiss the mobile sheet if the
    // viewport crosses into xl so we never stack both presentations.
    const media = window.matchMedia("(min-width: 1280px)");
    const onViewportChange = () => {
      if (media.matches) onCloseMobileOverlay();
    };
    window.addEventListener("keydown", onKeyDown);
    media.addEventListener("change", onViewportChange);
    onViewportChange();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      media.removeEventListener("change", onViewportChange);
    };
  }, [mobileOverlayOpen, onCloseMobileOverlay]);

  if (!channel) return null;

  const detailsBody = (
      <div className="app-material-scroll-viewport min-h-0 flex-1 overflow-y-auto">
        <div className="app-material-scroll-content min-h-full space-y-4 p-4">
          <DetailBlock
            title="Summary"
            action={
              <button
                type="button"
                title="Regenerate Summary"
                aria-label="Regenerate Summary"
                disabled={aboutSummaryBusy}
                onClick={() => void requestAboutSummary()}
                className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <RefreshCw className={aboutSummaryBusy ? "size-3.5 animate-spin" : "size-3.5"} />
              </button>
            }
          >
            <p className="text-sm text-foreground">{channel.summary || "No summary yet"}</p>
            {channel.summary && channel.summarySource && (
              <p className="mt-1 text-xs text-muted-foreground" title={channel.summarySource.generatedAt}>
                {summarySourceLine(channel.summarySource, channel.historyHeadSequence)}
              </p>
            )}
            {aboutSummaryError && (
              <p role="alert" className="mt-1 text-xs text-destructive">{aboutSummaryError}</p>
            )}
          </DetailBlock>

          <DetailBlock title="Members">
            <div className="space-y-2">
              {members.length === 0 ? (
                <p className="text-sm text-muted-foreground">No members with channel access</p>
              ) : (
                members.map((member) => {
                  const presence = memberPresence(channel, member);
                  const status = presence.kind === "user" ? presence.status : "offline";
                  const spaceMember = spaceMemberForChannelIdentity(space, member);
                  const label = spaceMember?.name || spaceMember?.email || formatMember(channel, member);
                  const kindLabel = member === currentUserMemberId ? "you" : "human";
                  const deviceLine = memberDeviceLine(presence);

                  return (
                    <div key={member} className="app-detail-member-row border-t border-border/60 py-2 text-sm first:border-t-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <IdentityAvatar
                            kind="human"
                            label={label}
                            status={status}
                            imageUrl={presenceAvatarUrl(presence) || spaceMember?.avatarUrl}
                            initials={avatarInitials(label)}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <p className="truncate">{label}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {presenceStatusLabel({ ...presence, status })}{presence.lastSeenAt ? ` - ${relativeTime(presence.lastSeenAt)}` : ""}
                            </p>
                            {deviceLine && (
                              <p className="truncate text-[11px] text-muted-foreground" title={deviceLine}>
                                {deviceLine}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <span className={cn("app-detail-member-badge px-1.5 py-0.5 text-[11px] text-muted-foreground", COUNT_CHIP_MATERIAL_CLASS)}>
                            {kindLabel}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </DetailBlock>

          <DetailBlock title="Agents">
            <div className="space-y-2">
              {agentItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active agent instances</p>
              ) : (
                <>
                  {agentItems.map((item) => {
                    const presence = memberPresence(channel, item.member);
                    if (presence.kind !== "agent") return null;
                    // The member's registration names its owner and machine.
                    const registration = presence.registration;
                    const label = formatMember(channel, item.member);
                    const instance = item.instance;
                    const owner = space?.members.find(member => member.userId === registration?.ownerUserId);
                    const ownerLabel = owner?.name || owner?.email || registration?.ownerUserId;
                    const machineId = instance.machineId ?? registration?.machineId;
                    const machineTarget = machineId ? { machineId, ownerUserId: registration?.ownerUserId } : undefined;
                    const machineLabel = registrationMachineName(machineCatalog.data?.registrations ?? [],
                      instance.machineId ?? registration?.machineId, registration?.ownerUserId) || "Unnamed machine";
                    const machineBusy = registrationMachineBusy(machineCatalog.data?.registrations ?? [],
                      instance.machineId ?? registration?.machineId, registration?.ownerUserId);
                    const displayLabel = instance.channelInstanceId
                      ? `@${label}:${instance.channelInstanceId}`
                      : `@${label}`;
                    const workspaceTag = channelAgentInstanceWorkspaceTag(instance, workspaces);
                    // The limit warning reads the reported numbers; the tags come
                    // from what the runtime declared about itself.
                    const usageLimit = agentInstanceUsageLimit(presence, instance);
                    return (
                      <div
                        key={item.key}
                        className="w-full border-t border-border/60 first:border-t-0"
                      >
                        <div className="flex w-full items-start gap-2">
                          <div className="flex min-w-0 flex-1 items-start gap-2.5 px-2 py-2.5 text-left text-sm">
                            <button
                              type="button"
                              title={`Open ${displayLabel} instance details`}
                              aria-label={`Open ${displayLabel} instance details`}
                              onClick={() => onOpenAgentTrace(
                                agentTraceTargetFromInstance(item.member, instance, channel.id)
                              )}
                              className="app-detail-agent-avatar-button shrink-0 rounded-full"
                            >
                              <IdentityAvatar
                                kind="agent"
                                label={label}
                                status={instance.status}
                                imageUrl={presence.avatarUrl}
                                initials={avatarInitials(label)}
                                size="sm"
                              />
                            </button>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-2">
                                <p className="min-w-0 shrink-0 whitespace-nowrap leading-5">{displayLabel}</p>
                                <span
                                  className={cn(
                                    "w-16 shrink-0 pt-0.5 text-left text-[11px] leading-4",
                                    usageLimit?.severity === "limit"
                                      ? "text-destructive"
                                      : "capitalize text-muted-foreground",
                                  )}
                                  title={usageLimit?.severity === "limit"
                                    ? usageLimit.title
                                    : agentInstancePresenceLabel(instance, usageLimit)}
                                >
                                  {agentInstancePresenceLabel(instance, usageLimit)}
                                </span>
                              </div>
                              <AgentIdentityLabels
                                owner={ownerLabel}
                                machine={machineLabel}
                                machineBusy={machineBusy}
                                machineTarget={machineTarget}
                                workspace={workspaceTag}
                                wrap
                              />
                              <div className="mt-0.5 flex min-w-0 overflow-hidden">
                              <LiveAgentPresentationChips
                                instance={instance}
                                usageLimit={usageLimit}
                                mention={`@${label}:${instance.channelInstanceId}`}
                                onRunCommand={onRunChannelCommand}
                              />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </DetailBlock>

          <ChannelSubscriptionsBlock
            connections={connectorConnections}
            loading={connectorsLoading}
            error={connectorsError}
            userId={currentUserMemberId || "anonymous"}
            spaceId={channelSpaceId}
            channelId={channelId}
            token={token}
            connectorRevision={connectorRevision}
            onRunConnectorCommand={onRunChannelCommand}
            onManageApps={onManageApps}
          />

          {/* Automations are made on a page, in the section they keep true; this lists the ones running here. */}
          <DetailBlock title="Schedules">
            <div className="space-y-2">
              {loadingAutomations && channelAutomations.length === 0 ? (
                <ListSkeleton label="Loading schedules" rows={3} />
              ) : channelAutomations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No schedules in this channel yet.</p>
              ) : (
                channelAutomations.map((automation) => (
                  <div key={automation.id} className="border-t border-border/60 py-2 text-sm first:border-t-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {canEditAutomation(automation) ? (
                              <button
                                type="button"
                                onClick={() => startEditingAutomation(automation)}
                                className="truncate text-left font-medium hover:underline"
                                title="Edit this schedule"
                              >
                                {automation.name}
                              </button>
                            ) : (
                              <span className="truncate font-medium">{automation.name}</span>
                            )}
                            <span
                              className={statusChipClass(
                                automation.enabled && automationExecutionEnabled !== false
                                  ? "settled"
                                  : automation.enabled
                                    ? "alert"
                                    : "secondary",
                                "app-automation-state shrink-0 px-1.5 py-0.5 text-[10px]"
                              )}
                            >
                              {automation.enabled && automationExecutionEnabled === false
                                ? "execution unavailable"
                                : automation.enabled
                                  ? "enabled"
                                  : "paused"}
                            </span>
                            {!automation.capabilities.update && !automation.capabilities.pause && !automation.capabilities.resume &&
                              !automation.capabilities.delete && (
                              <span className={cn("shrink-0 px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground", COUNT_CHIP_MATERIAL_CLASS)}>
                                read only
                              </span>
                            )}
                          </div>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {formatAutomationCadence(automation.intervalMinutes)} · next {formatDateTime(automation.nextRunAt)}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {evaluationBindingLabel(automation.input)}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-4 text-muted-foreground">
                            {automation.expression.text}
                          </p>
                        </div>
                        {canEditAutomation(automation) || (automation.enabled ? automation.capabilities.pause : automation.capabilities.resume) || automation.capabilities.delete ? (
                        <div className="flex shrink-0 items-center gap-1">
                          {canEditAutomation(automation) && <button
                            type="button"
                            title="Edit"
                            aria-label={`Edit ${automation.name}`}
                            aria-pressed={editingAutomationId === automation.id}
                            disabled={Boolean(automationBusy)}
                            onClick={() => editingAutomationId === automation.id
                              ? setEditingAutomationId(null)
                              : startEditingAutomation(automation)}
                            className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                          >
                            <Pencil className="size-3.5" />
                          </button>}
                          {(automation.enabled ? automation.capabilities.pause : automation.capabilities.resume) && <button
                            type="button"
                            title={automation.enabled ? "Pause" : "Resume"}
                            disabled={Boolean(automationBusy) || (!automation.enabled && automationExecutionEnabled !== true)}
                            onClick={() => onToggleAutomation(automation)}
                            className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                          >
                            {automationBusy === `toggle:${automation.id}` ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : automation.enabled ? (
                              <Pause className="size-3.5" />
                            ) : (
                              <Play className="size-3.5" />
                            )}
                          </button>}
                          {automation.capabilities.delete && <button
                            type="button"
                            title="Delete lineage"
                            disabled={Boolean(automationBusy)}
                            onClick={() => onDeleteAutomation(automation)}
                            className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
                          >
                            {automationBusy === `delete:${automation.id}` ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="size-3.5" />
                            )}
                          </button>}
                        </div>
                        ) : null}
                      </div>
                      {canEditAutomation(automation) && editingAutomationId === automation.id && (
                        <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
                          {!authoredByCurrentUser(automation) && (
                            <p className={noticeClass("attention", "p-2 text-[11px]")}>
                              Saving replaces this schedule with your own copy, which runs as you.
                            </p>
                          )}
                          <label className="block text-[11px] font-bold text-muted-foreground">
                            Resume every (minutes)
                            <Input
                              type="number"
                              min={AUTOMATION_MIN_INTERVAL_MINUTES}
                              max={AUTOMATION_MAX_INTERVAL_MINUTES}
                              step={15}
                              value={automationIntervalDraft}
                              onChange={(event) => setAutomationIntervalDraft(Number(event.target.value))}
                              className="mt-1 h-8"
                            />
                          </label>
                          <label className="block text-[11px] font-bold text-muted-foreground">
                            Expression data
                            <Textarea
                              value={automationMessageDraft}
                              onChange={(event) => setAutomationMessageDraft(event.target.value)}
                              className="mt-1 min-h-28 resize-y text-xs font-normal text-foreground"
                            />
                            <AutomationExpressionGuidance compact />
                          </label>
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => onOpenSchedule(automation.id)}
                              className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                            >
                              Open in Schedules
                            </button>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => setEditingAutomationId(null)}
                                className="rounded px-2 py-1 text-[11px] font-bold text-muted-foreground hover:bg-muted"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                disabled={
                                  Boolean(automationBusy) ||
                                  automationMessageDraft.trim().length === 0 ||
                                  !isAutomationIntervalMinutes(automationIntervalDraft)
                                }
                                onClick={() => {
                                  onUpdateAutomation(automation.id, {
                                    expression: automationExpressionFromText(automationMessageDraft),
                                    intervalMinutes: automationIntervalDraft,
                                  });
                                  setEditingAutomationId(null);
                                }}
                                className="rounded bg-primary px-2 py-1 text-[11px] font-bold text-primary-foreground disabled:opacity-50"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                )
              )}
              {automationExecutionEnabled === false && (
                <p className={noticeClass("alert", "text-[11px]")}>
                  Evaluation resume is unavailable. Existing suspended evaluations will not run.
                </p>
              )}
            </div>
          </DetailBlock>
        </div>
      </div>
  );

  if (mobileOverlayOpen && onCloseMobileOverlay) {
    // Precompute so the mobile sheet can show the channel name without the
    // desktop rail pattern that layout tests forbid (`#{channelTitle(...)}`).
    const mobileOverlayChannelLabel = `#${channelTitle(channel)}`;
    return createPortal(
      <div
        className="xmatrix-app fixed inset-0 z-[var(--z-overlay)] flex flex-col bg-background xl:hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Channel details"
      >
        <div className="app-details app-mobile-channel-details-surface flex min-h-0 flex-1 flex-col">
          <WoodPanel as="header" className="app-detail-plank app-mobile-channel-details-header flex shrink-0 items-center gap-2 p-3">
            <button
              type="button"
              title="Back to channel"
              aria-label="Back to channel"
              onClick={onCloseMobileOverlay}
              className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/30 hover:text-foreground"
            >
              <ChevronLeft className="size-5" />
            </button>
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold">Channel details</h2>
              <p className="truncate text-sm text-muted-foreground" title={mobileOverlayChannelLabel}>
                {mobileOverlayChannelLabel}
              </p>
            </div>
          </WoodPanel>
          <div className="app-mobile-channel-details-sheet flex min-h-0 flex-1 flex-col">
            {detailsBody}
          </div>
        </div>
      </div>,
      document.body
    );
  }

  return (
    <aside
      className={cn(
        "app-details hidden w-[21rem] shrink-0 flex-col bg-muted/40",
        wideOnly ? "2xl:flex" : "xl:flex"
      )}
    >
      {detailsBody}
    </aside>
  );
}

/**
 * Presentation metadata in the Details rail is deliberately read from the
 * connected instance. Message headers retain their send-time snapshots, but
 * this panel follows the current channel-presence update for the instance.
 *
 * Every element here is the element the message header uses, so one metric
 * looks the same wherever it appears.
 */
function LiveAgentPresentationChips({
  instance,
  usageLimit,
  mention,
  onRunCommand,
}: {
  instance: SerializedAgentInstance;
  /** Shown on the tag of the window it is about, not as a tag of its own. */
  usageLimit?: UsageLimitSummary;
  /** `@agent:<n>` — absent for an instance this channel cannot address. */
  mention?: string;
  onRunCommand?: (body: string) => void;
}) {
  const limitChipId = usageLimit?.window ? `quota:${usageLimit.window.toLowerCase()}` : undefined;
  const noteTone = usageLimit?.credits ? "yellow" as const : usageLimit?.severity === "limit" ? "red" as const : undefined;
  const verdict = { ...(usageLimit?.note ? { note: usageLimit.note } : {}), ...(noteTone ? { noteTone } : {}) };
  const withVerdict = (tag: Omit<Tag, "title">): Tag => ({ ...tag, title: usageLimit?.title ?? "", ...verdict });
  const statusChips = cleanStatusChips(instance.statusChips, instance.model, instance.effort)
    ?.map((chip) => chip.id === limitChipId ? { ...chip, ...verdict } : chip);
  const branch = instance.gitBranch?.trim();
  const statusChipIds = new Set(statusChips?.map((chip) => chip.id) || []);
  // A runtime normally promotes its quota/context metrics into status chips.
  // Preserve reported quota/context meters here too, so a partial presentation
  // update cannot make the live instance card look as if it has no usage.
  const usageMeterTags = instance.usage
    ? tagsFromUsage(instance.usage).filter((tag) => {
        if (tag.percent === undefined) return false;
        const statusChipId = tag.key === "ctx" ? "ctx" : `quota:${tag.label.toLowerCase()}`;
        return !statusChipIds.has(statusChipId);
      }).map((tag) => `quota:${tag.label.toLowerCase()}` === limitChipId ? withVerdict(tag) : tag)
    : [];
  // The verdict may come from the account's quota another instance reported;
  // this instance then has no tag for the window, so the verdict draws one.
  if (usageLimit?.window && limitChipId && !statusChipIds.has(limitChipId)
    && !usageMeterTags.some((tag) => `quota:${tag.label.toLowerCase()}` === limitChipId)) {
    usageMeterTags.push(withVerdict({ key: limitChipId, label: usageLimit.window, percent: usageLimit.percent }));
  }

  if (!instance.goal && !branch && !statusChips?.length && usageMeterTags.length === 0) return null;

  return (
    <div
      className="app-live-agent-header-chips mt-1.5 flex flex-wrap items-center gap-2"
      aria-label="Live agent status"
      data-live-agent-header-chips
    >
      {instance.goal ? <GoalStatusBadge goal={instance.goal} presentation="live" /> : null}
      {branch ? <BranchBadge branch={branch} live /> : null}
      {statusChips?.length ? (
        <AgentInstanceTagChips
          instance={instance}
          chips={statusChips}
          mention={mention}
          onRunCommand={onRunCommand}
        />
      ) : null}
      <TagRow tags={usageMeterTags} compact />
    </div>
  );
}

export { AgentConfigPage } from "./agent-config-page";

/** Lays out tags. It does not know or care what they describe. */
export function TagRow({
  tags,
  className,
  compact = false,
}: {
  tags: Tag[];
  className?: string;
  compact?: boolean;
}) {
  if (tags.length === 0) return null;

  return (
    <div data-tag-row className={cn("flex flex-wrap items-center gap-1", className)}>
      {tags.map((tag) =>
        tag.percent === undefined ? (
          <span
            key={tag.key}
            title={tag.title}
            className={cn(
              "inline-flex items-center font-medium tabular-nums text-muted-foreground",
              COUNT_CHIP_MATERIAL_CLASS,
              compact ? "h-5 px-1.5 text-[10px] leading-none" : "h-6 px-2 text-[11px] leading-none"
            )}
          >
            {tag.label}
          </span>
        ) : (
          <MeterTag
            key={tag.key}
            label={tag.label}
            percent={tag.percent}
            resetLabel={tag.resetLabel}
            note={tag.note}
            noteTone={tag.noteTone}
            title={tag.title}
            compact={compact}
          />
        )
      )}
    </div>
  );
}

export function MeterTag({
  label,
  percent,
  resetLabel,
  note,
  noteTone,
  title,
  compact,
}: {
  label: string;
  percent?: number;
  resetLabel?: string;
  /** The limit verdict's word on this window: when it resets, or the credits paying past it. */
  note?: string;
  noteTone?: "yellow" | "red";
  title: string;
  compact: boolean;
}) {
  const clamped =
    percent === undefined ? undefined : Math.max(0, Math.min(100, percent));
  // Use the same rounded value for color and text so 89.6% and 90.2% both
  // display as "90%" and use the >=90 threshold, avoiding red/amber flicker.
  const displayPercent = clamped === undefined ? undefined : Math.round(clamped);
  const fillTone =
    displayPercent === undefined
      ? undefined
      : noteTone ?? (displayPercent >= 90
        ? "red"
        : displayPercent >= 70
          ? "yellow"
          : "green");
  const textClass =
    displayPercent === undefined
      ? ""
      : displayPercent >= 70
        ? "text-white"
        : "text-foreground/90";
  // Compact chips (Agents sidebar / status column): label + percent only.
  // Reset time stays in the tooltip so the pill does not feel cramped.
  // The verdict's note names the reset itself, so the plain reset steps aside.
  const showReset = Boolean(resetLabel) && !compact && !note;
  /* The tooltip is drawn here rather than left to the native `title`: that one
     waits out a browser delay, needs a still pointer, and restarts whenever a
     presence update rewrites the chip, so the reset time often never showed.
     It is portalled and fixed because the agent rail clips its overflow. */
  const [tipAnchor, setTipAnchor] = useState<DOMRect | null>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  // The rail sits at the window's right edge; keep the whole tip on screen.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!tip || !tipAnchor) return;
    const maxLeft = window.innerWidth - tip.offsetWidth - 8;
    tip.style.left = `${Math.max(8, Math.min(tipAnchor.left, maxLeft))}px`;
  }, [tipAnchor]);

  // `inline-flex` in both sizes, like every `Tag`: the final glass override in
  // globals.css skips `.inline-flex`, so a `flex` meter took a different fill
  // from the chips beside it.
  return (
    <span
      data-usage-meter-chip
      aria-label={title}
      onPointerEnter={(event) => setTipAnchor(event.currentTarget.getBoundingClientRect())}
      onPointerLeave={() => setTipAnchor(null)}
      className={cn(
        "relative inline-flex shrink-0 items-center overflow-hidden font-medium",
        COUNT_CHIP_MATERIAL_CLASS,
        compact
          ? "h-5 w-full px-2 text-[10px] leading-none"
          : "h-6 gap-1.5 px-2 text-[11px] leading-none"
      )}
    >
      {displayPercent !== undefined ? (
        <span
          aria-hidden
          className="app-usage-meter-fill pointer-events-none absolute inset-y-0 left-0"
          data-tone={fillTone}
          style={{ width: `${displayPercent}%` }}
        />
      ) : null}
      <span
        className={cn(
          "relative z-[1] w-full",
          compact ? "flex items-center justify-between gap-2" : "inline-flex items-center gap-1.5",
          textClass
        )}
      >
        <span className="shrink-0">{label}</span>
        {showReset ? (
          <span className="shrink-0 text-muted-foreground">· {resetLabel}</span>
        ) : null}
        {displayPercent !== undefined ? (
          <span className="shrink-0 tabular-nums">{formatPercent(displayPercent)}</span>
        ) : null}
        {note ? <span className="shrink-0 tabular-nums">· {note}</span> : null}
      </span>
      {tipAnchor && typeof document !== "undefined"
        ? createPortal(
            <span
              ref={tipRef}
              role="tooltip"
              data-usage-meter-tip
              className="xmatrix-app app-hint-tooltip pointer-events-none fixed z-50 max-w-72 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium leading-4"
              style={{ left: tipAnchor.left, top: tipAnchor.bottom + 4 }}
            >
              {title}
            </span>,
            document.body
          )
        : null}
    </span>
  );
}

export function ToolSurface({
  view,
  profileUserId,
  user,
  channels,
  machines,
  localWorkspaces,
  localManagedAgents,
  agentPresetDiscoveries,
  loadingAgentPresetDiscoveries,
  automations,
  automationExecutionEnabled,
  spaces,
  currentSpace,
  token,
  events,
  agentsError,
  spacesError,
  desktopAvailable,
  desktopUpdateBridgeAvailable,
  desktopContext,
  desktopDaemonStatus,
  desktopSetupStatus,
  desktopUpdateStatus,
  localActionBusy,
  localActionError,
  automationBusy,
  automationError,
  automationLoadError,
  loadingAutomations,
  scheduleFocusId,
  onScheduleFocusConsumed,
  onOpenPage,
  onOpenConversation,
  runtimeCheck,
  localSetupReady,
  localMachineName,
  onNameLocalMachine,
  onStartDesktopDaemon,
  onStopDesktopDaemon,
  onRestartDesktopDaemon,
  checkingDesktopUpdates,
  onCheckDesktopUpdates,
  onInstallDesktopUpdate,
  onOpenCliInstall,
  onAddLocalWorkspace,
  onRefreshAgentPresetDiscoveries,
  onImportDiscoveredAgent,
  onImportDiscoveredWorkspace,
  onRemoveLocalWorkspace,
  onRevealLocalWorkspace,
  onCheckLocalRuntime,
  onCompleteDesktopSetup,
  onUpdateAutomation,
  onToggleAutomation,
  onDeleteAutomation,
  joinRequestsBySpace,
  onDecideJoinRequest,
  onCreateSpaceInviteCode,
  onInviteSpaceMembers,
  onUpdateSpaceMemberRole,
  onRemoveSpaceMember,
  onUpdateSpaceMemberPermissions,
  onUpdateSpacePreferredLanguage,
  onDeleteSpace,
  onRestoreSpace,
  creatingSpace,
  onCreateSpace,
  onSelectSpace,
  onLogout,
  onOpenAgentCreate,
  onOpenLocalManagedAgentEdit,
  onDeleteAgent,
  onChangeView,
  onReportIssue,
  platformAdmin,
}: {
  view: Exclude<AppView, "messages">;
  /** Whose profile the Profile view shows; null is the viewer's own. */
  profileUserId: string | null;
  user: { id: string; email: string; name?: string; avatarUrl?: string };
  /** Hub-reported operator capability; the admin route re-checks it. */
  platformAdmin?: boolean;
  channels: SerializedChannel[];
  machines: MachineSummary[];
  localWorkspaces: SerializedWorkspace[];
  localManagedAgents: LocalManagedAgent[];
  agentPresetDiscoveries: DesktopAgentPresetDiscovery[];
  loadingAgentPresetDiscoveries: boolean;
  automations: SerializedAutomation[];
  automationExecutionEnabled: boolean | null;
  spaces: SerializedSpace[];
  currentSpace: SerializedSpace | null;
  token?: string;
  events: ObservabilityEvent[];
  agentsError: string | null;
  spacesError: string | null;
  desktopAvailable: boolean;
  desktopUpdateBridgeAvailable: boolean;
  desktopContext: DesktopContext | null;
  desktopDaemonStatus: DesktopDaemonStatus | null;
  desktopSetupStatus: DesktopSetupStatus | null;
  desktopUpdateStatus: DesktopUpdateStatus | null;
  localActionBusy: string | null;
  localActionError: string | null;
  automationBusy: string | null;
  automationError: string | null;
  automationLoadError: string | null;
  loadingAutomations: boolean;
  /** An Automation Schedules opens for editing. */
  scheduleFocusId: string | null;
  onScheduleFocusConsumed: () => void;
  onOpenPage: (pageId: string) => void;
  onOpenConversation: (channelId: string) => void;
  runtimeCheck: DesktopRuntimeCheckResult | null;
  localSetupReady: boolean;
  localMachineName: string | null | undefined;
  onNameLocalMachine: (name: string) => void;
  onStartDesktopDaemon: () => void;
  onStopDesktopDaemon: () => void;
  onRestartDesktopDaemon: () => void;
  checkingDesktopUpdates: boolean;
  onCheckDesktopUpdates: () => void;
  onInstallDesktopUpdate: () => void;
  onOpenCliInstall: () => void;
  onAddLocalWorkspace: () => void;
  onRefreshAgentPresetDiscoveries: () => void;
  onImportDiscoveredAgent: (discovery: DesktopAgentPresetDiscovery) => void;
  onImportDiscoveredWorkspace: (candidate: DesktopWorkspaceCandidate) => void;
  onRemoveLocalWorkspace: (workspace: SerializedWorkspace) => void;
  onRevealLocalWorkspace: (workspace: SerializedWorkspace) => void;
  onCheckLocalRuntime: (runtime: string) => void;
  onCompleteDesktopSetup: () => void;
  onUpdateAutomation: (automationId: string, input: Omit<AutomationUpdateRequest, "expectedVersion">) => void;
  onToggleAutomation: (automation: SerializedAutomation) => void;
  onDeleteAutomation: (automation: SerializedAutomation) => void;
  joinRequestsBySpace: Record<string, SpaceJoinRequest[]>;

  creatingSpace: boolean;
  onCreateSpace: (name: string) => Promise<SerializedSpace | undefined>;
  onSelectSpace: (spaceId: string) => void;
  onLogout: () => void;
  onOpenAgentCreate: () => void;
  onOpenLocalManagedAgentEdit: () => void;
  onDeleteAgent: (agent: LocalManagedAgent) => void;
  onChangeView: (view: AppView, item?: string) => void;
  /** Opens the GitHub issue form for a report. */
  onReportIssue?: () => void;
} & SpaceMemberActions) {
  const currentSpaceChannelIds = useMemo(
    () => spaceChannelIdSet(channels, currentSpace?.id),
    [channels, currentSpace?.id],
  );
  const currentSpaceChannels = useMemo(
    () => channelsInSpace(channels, currentSpace?.id),
    [channels, currentSpace?.id],
  );
  const currentSpaceMachines = useMemo(
    () => machinesInSpace(machines, currentSpaceChannelIds, { ownerUserId: user.id }),
    [currentSpaceChannelIds, machines, user.id],
  );
  const currentSpaceLocalWorkspaces = useMemo(
    () => workspacesInSpace(localWorkspaces, currentSpaceChannelIds, { includeUnbound: true }),
    [currentSpaceChannelIds, localWorkspaces],
  );
  const currentSpaceLocalAgents = useMemo(
    () => localManagedAgentsInSpace(localManagedAgents, currentSpace?.id),
    [currentSpace?.id, localManagedAgents],
  );
  // Every Channel this account can see, so an Automation pinned to a Channel that no
  // longer exists stays visible instead of being read as another Space's.
  const knownChannelIds = useMemo(
    () => new Set(channels.map((channel) => channel.id)),
    [channels],
  );
  const currentSpaceAutomations = useMemo(
    () => automationsInSpace(automations, currentSpaceChannelIds, knownChannelIds),
    [currentSpaceChannelIds, knownChannelIds, automations],
  );
  const currentSpaceEvents = useMemo(
    () => eventsInSpace(events, currentSpace?.id, currentSpaceChannelIds),
    [currentSpace?.id, currentSpaceChannelIds, events],
  );

  // Schedules is read on the workspace panel's paper, like a page, not on the tools' board.
  if (view === "automation") {
    return (
      <SchedulesView
        spaceId={currentSpace?.id ?? null}
        token={token ?? ""}
        automations={currentSpaceAutomations}
        executionEnabled={automationExecutionEnabled}
        spaces={spaces}
        currentUserId={user.id}
        channels={currentSpaceChannels}
        busy={automationBusy}
        error={automationError}
        loadError={automationLoadError}
        loadingAutomations={loadingAutomations}
        focusAutomationId={scheduleFocusId ?? undefined}
        onFocusConsumed={onScheduleFocusConsumed}
        onUpdateAutomation={onUpdateAutomation}
        onToggleAutomation={onToggleAutomation}
        onDeleteAutomation={onDeleteAutomation}
        onOpenPage={onOpenPage}
        onOpenConversation={onOpenConversation}
        onOpenPages={() => onChangeView("pages")}
      />
    );
  }

  if (view === "admin") return <PlatformAdminTabs token={token} />;
  if (view === "team") {
    return (
      <TeamView
        token={token}
        user={user}
        currentSpace={currentSpace}
        error={spacesError}
        joinRequestsBySpace={joinRequestsBySpace}
        onDecideJoinRequest={onDecideJoinRequest}
        onCreateSpaceInviteCode={onCreateSpaceInviteCode}
        onInviteSpaceMembers={onInviteSpaceMembers}
        onUpdateSpaceMemberRole={onUpdateSpaceMemberRole}
        onRemoveSpaceMember={onRemoveSpaceMember}
        onUpdateSpaceMemberPermissions={onUpdateSpaceMemberPermissions}
        onUpdateSpacePreferredLanguage={onUpdateSpacePreferredLanguage}
        onDeleteSpace={onDeleteSpace}
        onRestoreSpace={onRestoreSpace}
        spaces={spaces}
        creatingSpace={creatingSpace}
        onCreateSpace={onCreateSpace}
        onSelectSpace={onSelectSpace}
      />
    );
  }
  // Status: the Space at work, opening into Agents, Machines and Schedules.
  if (view === "status") {
    return (
      <ToolPaper label="Status">
        <StatusView
          spaceId={currentSpace?.id ?? null}
          token={token}
          machines={currentSpaceMachines}
          channels={currentSpaceChannels}
          events={currentSpaceEvents}
          automations={currentSpaceAutomations}
          onOpenAgents={() => onChangeView("agents")}
          onOpenMachine={(machineId) => onChangeView("machines", machineId)}
          onOpenMachines={() => onChangeView("machines")}
          onOpenSchedule={(automationId) => onChangeView("automation", automationId)}
          onOpenSchedules={() => onChangeView("automation")}
        />
      </ToolPaper>
    );
  }
  // Agents: the Space's registered agents, each opened beside the list.
  if (view === "agents") {
    return (
      <MyAgentsView
        spaceId={currentSpace?.id ?? null}
        token={token}
        currentUserId={user.id}
        error={agentsError}
        channels={currentSpaceChannels}
        onOpenConversation={onOpenConversation}
        onOpenMachines={() => onChangeView("machines")}
      />
    );
  }
  if (view === "apps") {
    return (
      <AppsView
        connectors={APP_CONNECTORS}
        currentSpace={currentSpace}
        token={token}
        channels={currentSpaceChannels}
      />
    );
  }
  // On the desktop app this machine is a tagged row of Machines, not a destination of its own.
  if (view === "machines" || view === "local") {
    const localDirectories = currentSpaceLocalWorkspaces.length;
    return (
      <MachinesView
        machines={currentSpaceMachines}
        loading={false}
        error={agentsError}
        token={token}
        spaceId={currentSpace?.id}
        defaultItem={view === "local" ? THIS_MACHINE_ITEM : undefined}
        thisMachine={desktopAvailable && desktopContext
          && !["ios", "android"].includes(desktopContext.platform) ? {
          machineId: desktopContext?.machineId,
          name: "Unnamed machine",
          online: desktopDaemonStatus?.state === "running",
          platform: desktopContext?.platform,
          summary: `${desktopDaemonStatus?.state === "running" ? "Daemon online" : "Daemon offline"} · ${localDirectories} ${localDirectories === 1 ? "directory" : "directories"}`,
          content: (hubRecord) => (
        <LocalMacView
          hubRecord={hubRecord}
          desktopAvailable={desktopAvailable}
          desktopContext={desktopContext}
          desktopDaemonStatus={desktopDaemonStatus}
          desktopSetupStatus={desktopSetupStatus}
          workspaces={currentSpaceLocalWorkspaces}
          agents={currentSpaceLocalAgents}
          discoveries={agentPresetDiscoveries}
          loadingDiscoveries={loadingAgentPresetDiscoveries}
          busy={localActionBusy}
          error={localActionError}
          runtimeCheck={runtimeCheck}
          setupReady={localSetupReady}
          machineName={localMachineName}
          onNameMachine={onNameLocalMachine}
          harnesses={<MachineHarnessPanel key={currentSpace?.id} token={token} spaceId={currentSpace?.id}
            daemon={machines.find(machine => machine.machineId === desktopContext?.machineId)?.daemon} />}
          onStartDaemon={onStartDesktopDaemon}
          onRestartDaemon={onRestartDesktopDaemon}
          onOpenCliInstall={onOpenCliInstall}
          onRefreshDiscoveries={onRefreshAgentPresetDiscoveries}
          onAddWorkspace={onAddLocalWorkspace}
          onImportAgent={onImportDiscoveredAgent}
          onImportWorkspace={onImportDiscoveredWorkspace}
          onRemoveWorkspace={onRemoveLocalWorkspace}
          onRevealWorkspace={onRevealLocalWorkspace}
          onCreateAgent={onOpenAgentCreate}
          onEditAgent={onOpenLocalManagedAgentEdit}
          onDeleteAgent={onDeleteAgent}
          onCheckRuntime={onCheckLocalRuntime}
          onCompleteSetup={onCompleteDesktopSetup}
        />
          ),
        } : null}
      />
    );
  }
  if (view === "settings") {
    return (
      <SettingsView
        user={user}
        space={currentSpace ? { id: currentSpace.id, name: currentSpace.name } : null}
        projectedProfile={humanProfileFromSpaceMember(
          user,
          currentSpace?.members.find((member) => member.userId === user.id),
        )}
        token={token}
        onChangeView={onChangeView}
        desktopAvailable={desktopAvailable}
        desktopUpdateBridgeAvailable={desktopUpdateBridgeAvailable}
        desktopContext={desktopContext}
        desktopDaemonStatus={desktopDaemonStatus}
        desktopUpdateStatus={desktopUpdateStatus}
        onStartDesktopDaemon={onStartDesktopDaemon}
        onStopDesktopDaemon={onStopDesktopDaemon}
        onRestartDesktopDaemon={onRestartDesktopDaemon}
        checkingDesktopUpdates={checkingDesktopUpdates}
        onCheckDesktopUpdates={onCheckDesktopUpdates}
        onInstallDesktopUpdate={onInstallDesktopUpdate}
        onLogout={onLogout}
      />
    );
  }

  return (
    <ToolPaper label={view === "activity" ? "Activity" : view === "profile" ? "Profile" : "More"}>
      {view === "activity" && (
        <ActivityView events={currentSpaceEvents} />
      )}
      {view === "profile" && (
        <ProfileView
          user={user}
          member={currentSpace?.members.find(
            (candidate) => candidate.userId === (profileUserId ?? user.id),
          )}
          self={!profileUserId || profileUserId === user.id}
          token={token}
        />
      )}
      {view === "more" && (
        <MoreView
          profile={humanProfileFromSpaceMember(
            user,
            currentSpace?.members.find((member) => member.userId === user.id),
          )}
          platformAdmin={platformAdmin}
          onChangeView={onChangeView}
          onReportIssue={onReportIssue}
        />
      )}
    </ToolPaper>
  );
}

import {
  agentInstanceDisplayName,
} from "./workspace-shell-message-model";
export {
  agentInstanceBranchLabel,
  agentInstanceDisplayName,
} from "./workspace-shell-message-model";

export function agentTraceTargetRequestKey(target: AgentTraceTarget): string {
  return [
    target.id || "",
    target.channelId || "",
    ...agentTraceExactInstanceIds(target).sort(),
  ].join(":");
}

export function agentTraceTargetFromAgentInstance(
  agent: SerializedAgent,
  instance: SerializedAgentInstance
): AgentTraceTarget {
  return {
    id: agent.id,
    instanceId: instance.id,
    instanceIds: agentTraceInstanceIds(instance),
    exactInstanceIds: [instance.id],
    instanceScoped: true,
    ownerUserId: agent.userId,
    connectedAt: instance.connectedAt,
    name: agentInstanceDisplayName(instance),
    status: instance.status,
    avatarUrl: agentAvatarUrl(agent),
    activity: presenceStatusLabel(instance),
    gitBranch: instance.gitBranch,
    runtimeState: instance.runtimeState || agent.runtimeState,
    usage: instance.usage || agent.usage,
  };
}

export function agentTraceTargetFromInstance(
  agentId: string,
  instance: SerializedAgentInstance,
  channelId?: string
): AgentTraceTarget {
  return {
    id: agentId,
    instanceId: instance.id,
    instanceIds: agentTraceInstanceIds(instance),
    exactInstanceIds: [instance.id],
    instanceScoped: true,
    channelId,
    connectedAt: instance.connectedAt,
    name: agentInstanceDisplayName(instance),
    status: instance.status,
    activity: presenceStatusLabel(instance),
    gitBranch: instance.gitBranch,
    runtimeState: instance.runtimeState,
    usage: instance.usage,
  };
}

export function agentTraceGroupsForTarget(
  traceReplicas: AgentTraceReplica[],
  target: AgentTraceTarget,
  channelId?: string
): AgentTraceGroup[] {
  const groups: AgentTraceGroup[] = [];

  for (const replica of traceReplicas) {
    if (!agentTraceScopeMatchesTarget(replica.scope, target, channelId)) continue;

    const latest = replica.events.at(-1);
    const channelInstanceLabel = latest ? traceEventChannelInstanceLabel(latest) : "";
    groups.push({
      key: `${replica.scope.channelId}:${replica.scope.agentId}:${replica.scope.instanceId}`,
      label: `${latest?.agentName || target.name}:${channelInstanceLabel || shortId(replica.scope.instanceId)}`,
      events: replica.events,
    });
  }

  return groups.sort((left, right) => {
    const leftTime = latestEventTimestampMs(left.events);
    const rightTime = latestEventTimestampMs(right.events);
    return leftTime - rightTime || left.key.localeCompare(right.key);
  });
}

function ReadyAttachmentDetails({ attachment, separator, onRemove }: {
  attachment: { name: string; size: number }; separator: string; onRemove: () => void;
}) {
  return <>
    <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-2 py-2">
      <div className="truncate text-xs font-bold text-foreground" title={attachment.name}>{attachment.name}</div>
      <div className="text-[11px] text-muted-foreground">Ready {separator} {formatFileSize(attachment.size)}</div>
    </div>
    <button type="button" title="Remove attachment" aria-label={`Remove ${attachment.name}`} onClick={onRemove}
      className="absolute right-1 top-1 z-20 flex size-6 items-center justify-center rounded-full bg-background text-foreground shadow ring-1 ring-border hover:bg-muted">
      <X className="size-3.5" />
    </button>
  </>;
}
