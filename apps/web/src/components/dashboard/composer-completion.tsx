"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  FileText,
  Hash,
  Pin,
  PlugZap,
  Wrench,
  Zap,
} from "lucide-react";
import {
  WEB_PROXY_ROUTES,
  pageBlocks,
  type SpaceLaunchTargetsResponse,
  type AgentInvocationSelection,
  type AppConnectorCompletionResponse,
  type SerializedChannel,
  type SerializedSpace,
  type SerializedWorkspace,
} from "@xmatrix/protocol";
import {
  composerCompletionHandlesKeyDown,
  isComposerImeKeyDown,
  scheduleTextareaSelection,
} from "@/components/dashboard/composer-caret";
import {
  CompletionOptionButton,
  avatarInitials,
  stopTouchPropagation,
} from "@/components/dashboard/completion-option-button";
import { ContentSkeleton } from "@/components/dashboard/content-skeleton";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { SlashCommandPanel } from "@/components/dashboard/slash-command-panel";
import { useAuth } from "@/lib/auth-context";
import { autoLaunchCandidates, filterLaunchCandidates, findLaunchFieldCompletion, completeLaunchFragment, summonAtCompletion, summonStartCandidates } from "./auto-launch-completion";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import {
  completeMention,
  connectorCompletionErrorMessage,
  connectorCompletionRecovery,
  groupedMentionCandidates,
  DEFAULT_OPEN_MENTION_KINDS,
  DEFAULT_OPEN_MENTION_ROWS,
  parseAppMentions,
  resolveMentionCompletion,
  type MentionCandidate,
  type MentionDynamicCompletionValues,
  type MentionInstanceTargetScope,
  type MentionLocalContext,
} from "@/components/dashboard/mention-complete";
import {
  completeSlashCommandTarget,
  completeSlashCommandToken,
  resolveSlashCompletion,
  type SlashCommandCandidate,
  type SlashCommandTarget,
} from "@/components/dashboard/slash-complete";
import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { registrationMentionCandidates } from "./registration-mention-candidates";
import { APP_CONNECTORS } from "@/lib/app-connectors";
import { pageApi } from "@/lib/pages/page-client";
import type { ComposerReferenceBinding } from "./composer-invocation-bindings";
import { useMessageReferenceCatalog } from "./message-reference-catalog";
import {
  channelReferenceCandidates,
  completeReference,
  findActiveReference,
  pageReferenceCandidates,
  referenceInsertion,
  sectionReferenceCandidates,
  type ReferenceCandidate,
} from "./reference-complete";

type MentionDynamicLoadState =
  | { status: "loading" }
  | {
      status: "error";
      message: string;
      recovery: ReturnType<typeof connectorCompletionRecovery>;
    };

/**
 * Why the launch-target list is not a list of targets yet. `no-repos` is an
 * answer the Hub gave, not a failure: the Space authorizes none, and the row
 * says which of the two it is.
 */
type LaunchTargetLoadState =
  | { status: "loading" }
  | { status: "error"; message: string; recovery?: "configure" | "retry" }
  | { status: "no-repos"; message: string; recovery: "configure" | "retry" };

/** Shared channel/context fields for composer completion and the input authority. */
export type ComposerContextFields = {
  draft: string;
  onDraftChange: (value: string) => void;
  onInvocationSelect?: (value: string, selection: AgentInvocationSelection, label?: string) => void;
  /** Keeps a picked channel or page shown by name; without it the draft holds the id token itself. */
  onReferenceSelect?: (value: string, binding: ComposerReferenceBinding) => void;
  channel: SerializedChannel | null;
  space: SerializedSpace | null;
  token: string | null;
  workspaces: SerializedWorkspace[];
  localContext?: MentionLocalContext | null;
  /** Channel is joined / completion is allowed. */
  enabled: boolean;
  /**
   * Whether `channel` is this composer's own Channel, and so whether its live
   * instances are addressable from here. The inline thread draft renders against
   * the parent Channel until its thread exists, and passes "none".
   */
  instanceTargetScope?: MentionInstanceTargetScope;
  selectedWorkspaceId?: string | null;
  onWorkspaceSelect?: (workspaceTarget: string | null) => void;
  onConfigureAppConnector?: (providerId: string) => void;
};

export type ComposerCompletionInput = ComposerContextFields & {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export type ComposerCompletionApi = {
  cursor: number;
  setCursor: (value: number) => void;
  syncCursor: (target: HTMLTextAreaElement) => void;
  isCompletionOpen: boolean;
  appMentions: ReturnType<typeof parseAppMentions>;
  /** Returns true when the key event was handled by completion navigation/accept. */
  handleCompletionKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
  dismissCompletion: () => void;
  renderOverlays: () => React.ReactNode;
};

/**
 * Shared composer textarea key handling used by the main channel composer and
 * the inline Reply-in-thread draft. Enter sends (Shift+Enter inserts a newline);
 * completion navigation is handled first when a suggestion panel is open.
 */
export function handleComposerTextareaKeyDown(
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
  options: {
    handleCompletionKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
    onSend: () => void;
    onEscape?: () => void;
  }
): boolean {
  if (options.handleCompletionKeyDown(event)) return true;
  // An IME keystroke is the input method's: Escape cancels the composition and
  // Enter commits it, so neither may cancel a draft or send a message here.
  const composing = isComposerImeKeyDown({
    isComposing: event.nativeEvent.isComposing,
    keyCode: event.nativeEvent.keyCode,
  });
  if (event.key === "Escape" && options.onEscape && !composing) {
    event.preventDefault();
    options.onEscape();
    return true;
  }
  if (event.key === "Enter" && !event.shiftKey && !composing) {
    event.preventDefault();
    options.onSend();
    return true;
  }
  return false;
}

export function useComposerCompletion({
  draft,
  onDraftChange,
  onInvocationSelect,
  onReferenceSelect,
  channel,
  space,
  token,
  localContext,
  enabled,
  instanceTargetScope = "channel",
  textareaRef,
  onConfigureAppConnector,
}: ComposerCompletionInput): ComposerCompletionApi {
  const { user } = useAuth();
  const referenceCatalog = useMessageReferenceCatalog();
  const mentionListRef = useRef<HTMLDivElement | null>(null);
  const mentionOptionRefs = useRef<Array<HTMLElement | null>>([]);
  // The query reset and the offline-row skip run in one commit. The reset
  // claims that commit so the skip does not put the highlight back on the old row.
  const mentionListReset = useRef(false);
  const [cursor, setCursor] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [afterLaunchPick, setAfterLaunchPick] = useState<{ body: string; cursor: number } | null>(null);
  const [launchNavigation, setLaunchNavigation] = useState(false);
  const boundarySummon = /\s$/u.test(draft.slice(0, cursor))
    ? summonAtCompletion(draft.slice(0, cursor), cursor) : undefined;
  const continuingLaunch = Boolean(boundarySummon) ||
    afterLaunchPick?.body === draft && afterLaunchPick.cursor === cursor;
  const [expandedMentionKinds, setExpandedMentionKinds] = useState<Set<MentionCandidate["kind"]>>(
    () => new Set()
  );
  const emptyMentionDynamicValues = useMemo<MentionDynamicCompletionValues>(() => ({}), []);
  const [dismissedCompletionDraft, setDismissedCompletionDraft] = useState<string | null>(null);
  const fieldCompletion = findLaunchFieldCompletion(draft, cursor);
  // The Space's registrations are every Agent this composer can start: summon,
  // launch conditions and handoff successors all read this one catalog.
  const registrationCatalog = useAgentRegistrationCatalog(space?.id ?? channel?.spaceId ?? "", token ?? "",
    Boolean(enabled && token && (space?.id ?? channel?.spaceId)));
  const successorHarnesses = useMemo(
    () => registrationCatalog.data?.capabilities.map((capability) => capability.harness) ?? [],
    [registrationCatalog.data],
  );

  /* One resolution, one authorized read. The composer no longer merges a
     Space-scoped answer with a machine-scoped one — it asks the Channel what may
     be launched and renders that. */
  const preliminaryMentionCompletion = useMemo(
    () =>
      resolveMentionCompletion(
        draft,
        cursor,
        channel,
        localContext,
        APP_CONNECTORS,
        space,
        emptyMentionDynamicValues,
        instanceTargetScope,
        successorHarnesses,
      ),
    [
      successorHarnesses,
      channel,
      cursor,
      draft,
      instanceTargetScope,
      localContext,
      emptyMentionDynamicValues,
      space,
    ]
  );
  const launchCompletionActive = Boolean(fieldCompletion || continuingLaunch ||
    preliminaryMentionCompletion.stage === "target" && preliminaryMentionCompletion.active);
  /* Launch targets are the Space's, so a new conversation — no Channel yet —
     completes the same repos as every conversation in its Space. */
  const launchTargetSpaceId = space?.id ?? channel?.spaceId;
  const launchTargetsQuery = useQuery({
    queryKey: xmatrixQueryKeys.domain(
      { userId: user?.id ?? "anonymous" }, "composer-launch-targets",
      [launchTargetSpaceId ?? null],
    ),
    queryFn: async ({ signal }) => {
      const payload = await xmatrixApiRequest<SpaceLaunchTargetsResponse>({
        url: WEB_PROXY_ROUTES.space_launch_targets(launchTargetSpaceId!),
        token: token ?? undefined,
        signal,
      });
      if (payload.spaceId !== launchTargetSpaceId) {
        throw new Error("Launch target response did not match the requested Space");
      }
      return payload;
    },
    enabled: Boolean(enabled && launchTargetSpaceId && launchCompletionActive && token),
  });
  const launchTargets = launchTargetsQuery.data;
  const launchTargetLoadState: LaunchTargetLoadState | undefined = launchTargetsQuery.isError
    ? {
        status: "error",
        message: launchTargetsQuery.error.message || "Could not load launch targets.",
      }
    : launchTargetsQuery.isFetching
      ? { status: "loading" }
      : launchTargets && launchTargets.repoStatus !== "authorized"
        ? {
            status: "no-repos",
            message: launchTargets.repoStatus === "not-connected"
              ? "This Space has no GitHub connector, so it authorizes no repo targets."
              : launchTargets.repoStatusDetail
                || "The GitHub connector could not be reached for this Space.",
            recovery: launchTargets.repoStatus === "not-connected" ? "configure" : "retry",
          }
        : undefined;
  const mentionDynamicRequest = preliminaryMentionCompletion.dynamicRequest;
  const mentionDynamicCacheKey = mentionDynamicRequest?.cacheKey;
  const mentionDynamicProviderId = mentionDynamicRequest?.providerId;
  const mentionDynamicSource = mentionDynamicRequest?.source;
  const mentionDynamicParent = mentionDynamicRequest?.parent;
  const mentionDynamicQuery = useQuery({
    queryKey: xmatrixQueryKeys.domain(
      { userId: user?.id ?? "anonymous" }, "composer-connector-completion",
      [space?.id ?? null, channel?.id ?? null, mentionDynamicProviderId ?? null,
        mentionDynamicSource ?? null, mentionDynamicParent ?? null],
    ),
    queryFn: ({ signal }) => xmatrixApiRequest<AppConnectorCompletionResponse>({
      url: WEB_PROXY_ROUTES.space_app_connection_completion(
        space!.id,
        mentionDynamicProviderId!,
        mentionDynamicSource!,
        channel!.id,
        mentionDynamicParent,
      ),
      token: token ?? undefined,
      signal,
    }).then((payload) => payload.options ?? []),
    enabled: Boolean(mentionDynamicCacheKey && mentionDynamicProviderId && mentionDynamicSource &&
      space?.id && channel?.id && token),
  });
  const mentionDynamicValues = useMemo<MentionDynamicCompletionValues>(
    () => mentionDynamicCacheKey && mentionDynamicQuery.isSuccess
      ? { [mentionDynamicCacheKey]: mentionDynamicQuery.data }
      : {},
    [mentionDynamicCacheKey, mentionDynamicQuery.data, mentionDynamicQuery.isSuccess],
  );
  const referenceCompletion = useMemo(
    () => resolveMentionCompletion(
      draft, cursor, channel, localContext, APP_CONNECTORS, space,
      mentionDynamicValues, instanceTargetScope, successorHarnesses,
    ),
    [successorHarnesses, channel, cursor, draft, instanceTargetScope,
      localContext, mentionDynamicValues, space],
  );
  const registrationMentionCompletion = useMemo(() => {
    // No `@` under the caret means no completion at all: an inactive "target"
    // result must not become a list of every harness.
    if (!onInvocationSelect || referenceCompletion.stage !== "target" || !referenceCompletion.active ||
        !registrationCatalog.data?.capabilities?.length) return referenceCompletion;
    return { ...referenceCompletion, candidates: registrationMentionCandidates(
      referenceCompletion.candidates, registrationCatalog.data.capabilities,
      referenceCompletion.active?.query ?? "") };
  }, [referenceCompletion, onInvocationSelect, registrationCatalog.data]);
  // Derive suggestions from the summon adjacent to the caret, never the first one.
  const launchActive = fieldCompletion ?? registrationMentionCompletion.active;
  const bodySummon = launchActive
    ? summonAtCompletion(draft.slice(0, launchActive.start), launchActive.start) : boundarySummon;
  const mentionCompletion = useMemo(() => {
    if (!fieldCompletion && registrationMentionCompletion.stage !== "target" ||
        !launchActive && !continuingLaunch) return registrationMentionCompletion;
    const query = launchActive?.query ?? "";
    const allChoices = autoLaunchCandidates(launchTargets, bodySummon?.tags ?? {},
      registrationCatalog.data?.registrations);
    const choices = filterLaunchCandidates((bodySummon ? allChoices : summonStartCandidates(allChoices)).filter(item =>
      bodySummon || !item.launchTags?.harness ||
      !registrationMentionCompletion.candidates.some(candidate => candidate.invocationTarget &&
        (candidate.mention || candidate.name).toLowerCase() === item.launchTags!.harness)), query);
    // Old Profile rows appended a colon and led into the retired launch picker.
    // Harnesses now use condition tags; explicit registration targets remain typed.
    const references = registrationMentionCompletion.candidates.filter(candidate =>
      !(candidate.kind === "agent" && !candidate.action && candidate.completionSuffix === ":" &&
        allChoices.some(choice => choice.launchTags?.harness === (candidate.mention || candidate.name).toLowerCase())));
    return { ...registrationMentionCompletion, stage: "target" as const,
      active: launchActive ?? { start: cursor, end: cursor, tokenEnd: cursor, query: "" },
      candidates: [...choices, ...(continuingLaunch || fieldCompletion ? [] : references)] };
  }, [bodySummon, launchTargets, registrationCatalog.data, registrationMentionCompletion,
    continuingLaunch, cursor, fieldCompletion, launchActive]);
  const mentionDynamicValueLoaded = mentionDynamicQuery.isSuccess;
  const mentionDynamicLoadState: MentionDynamicLoadState | undefined = mentionDynamicQuery.isError
    ? {
        status: "error",
        message: connectorCompletionErrorMessage(mentionDynamicQuery.error.message),
        recovery: connectorCompletionRecovery(mentionDynamicQuery.error.message),
      }
    : mentionDynamicQuery.isFetching ? { status: "loading" } : undefined;
  const activeMention = mentionCompletion.active;
  // Escape is presentation state, not launch state. A dismissed draft stays
  // closed until the human edits it or explicitly moves the caret again.
  const completionDismissed = dismissedCompletionDraft === draft;
  const mentionSuggestions = mentionCompletion.candidates;
  /* Folding is a browsing affordance for the bare `@` listing only. Once the
     human types, the query is already the filter, so a folded section would
     hide the very row they are describing. */
  const mentionListingFolds = mentionCompletion.stage === "target" && !activeMention?.query;
  const mentionSuggestionSections = useMemo(
    () =>
      groupedMentionCandidates(mentionSuggestions, {
        expandedKinds: expandedMentionKinds,
        // A folded section shows no rows at all — its own one-line header is
        // the whole section until it is opened.
        openKinds: mentionListingFolds ? [...DEFAULT_OPEN_MENTION_KINDS, "launch"] : undefined,
        limitPerKind: mentionListingFolds ? DEFAULT_OPEN_MENTION_ROWS : 100,
      }),
    [expandedMentionKinds, mentionListingFolds, mentionSuggestions]
  );
  const visibleMentionItems = useMemo(
    () =>
      mentionSuggestionSections.flatMap((section) => {
        const items: Array<
          | { candidate: MentionCandidate; sectionKind: MentionCandidate["kind"]; type: "candidate" }
          | {
              hiddenCount: number;
              label: string;
              sectionKind: MentionCandidate["kind"];
              type: "expand";
            }
        > = section.candidates.map((candidate) => ({
          candidate,
          sectionKind: section.kind,
          type: "candidate" as const,
        }));
        if (section.hiddenCount > 0) {
          items.push({
            hiddenCount: section.hiddenCount,
            label: section.label,
            sectionKind: section.kind,
            type: "expand",
          });
        }
        return items;
      }),
    [mentionSuggestionSections]
  );
  /* Slash-first completion is resolved from the same draft and caret. It only
     claims a draft that starts with `/`, so `@instance /model` still belongs to
     the mention stage below — but `/model @cl` opens an `@` the mention parser
     would also answer, and there the slash stage is the one that knows the
     answer has to be rewritten into `@instance /model`. */
  const slashCompletion = useMemo(
    () => resolveSlashCompletion(draft, cursor, channel, localContext),
    [channel, cursor, draft, localContext]
  );
  const slashActive = Boolean(slashCompletion.active);
  const slashItems = useMemo(
    () =>
      slashCompletion.stage === "command" ? slashCompletion.commands : slashCompletion.targets,
    [slashCompletion]
  );
  const appMentions = useMemo(() => parseAppMentions(draft, APP_CONNECTORS), [draft]);
  /* `#` and `[[` references. They never claim a draft that a slash command or
     an `@` address is completing: those stages own their own text. */
  const referenceSpaceId = space?.id ?? channel?.spaceId ?? null;
  const activeReference = useMemo(
    () => slashActive || activeMention ? null : findActiveReference(draft, cursor),
    [activeMention, cursor, draft, slashActive],
  );
  const activeReferenceSection = activeReference?.kind === "page" ? activeReference.section : null;
  const referenceIdentity = { userId: user?.id ?? "anonymous" };
  const referencePages = useQuery({
    queryKey: xmatrixQueryKeys.domain(referenceIdentity, "page-tree", [referenceSpaceId]),
    enabled: Boolean(enabled && activeReference?.kind === "page" && referenceSpaceId && token && user?.id),
    staleTime: 5_000,
    queryFn: ({ signal }) => pageApi.tree(referenceSpaceId!, token!, signal).then((result) => result.pages),
  });
  const sectionPage = activeReference?.kind === "page" && activeReference.section !== null
    ? pageReferenceCandidates(referencePages.data ?? [], activeReference.query)[0] ?? null : null;
  const sectionPageId = sectionPage?.kind === "page" ? sectionPage.pageId : null;
  const sectionDocument = useQuery({
    queryKey: xmatrixQueryKeys.domain(referenceIdentity, "page-document", [referenceSpaceId ?? "", sectionPageId ?? ""]),
    enabled: Boolean(enabled && sectionPageId && referenceSpaceId && token && user?.id),
    staleTime: 15_000,
    retry: false,
    queryFn: ({ signal }) =>
      pageApi.read(referenceSpaceId!, sectionPageId!, token!, undefined, signal).then((result) => result.page),
  });
  const referenceItems = useMemo<ReferenceCandidate[]>(() => {
    if (!activeReference) return [];
    if (activeReference.kind === "channel") {
      return channelReferenceCandidates(referenceCatalog?.channels ?? [], activeReference.query,
        referenceSpaceId, channel?.id ?? null);
    }
    if (activeReference.section === null) {
      return pageReferenceCandidates(referencePages.data ?? [], activeReference.query);
    }
    const document = sectionDocument.data;
    return document && document.pageId === sectionPageId
      ? sectionReferenceCandidates(document, pageBlocks(document.body), activeReference.section)
      : [];
  }, [activeReference, channel?.id, referenceCatalog?.channels, referencePages.data, referenceSpaceId,
    sectionDocument.data, sectionPageId]);
  const showSlashSuggestions =
    enabled &&
    !completionDismissed &&
    slashActive &&
    slashItems.length > 0;
  const showReferenceSuggestions =
    enabled &&
    !completionDismissed &&
    !slashActive &&
    Boolean(activeReference) &&
    referenceItems.length > 0;
  const showMentionSuggestions =
    enabled &&
    !completionDismissed &&
    !slashActive &&
    !showReferenceSuggestions &&
    visibleMentionItems.length > 0;
  const showMentionDynamicStatus =
    enabled &&
    !completionDismissed &&
    !slashActive &&
    !!mentionDynamicRequest &&
    visibleMentionItems.length === 0 &&
    (mentionDynamicValueLoaded || !!mentionDynamicLoadState);
  const showLaunchTargetStatus =
    enabled &&
    !completionDismissed &&
    !slashActive &&
    launchCompletionActive &&
    !!launchTargetLoadState;
  const showMentionOverlay =
    !completionDismissed &&
    (showMentionSuggestions || showMentionDynamicStatus || showLaunchTargetStatus);
  const isCompletionOpen =
    showMentionOverlay || showSlashSuggestions || showReferenceSuggestions;

  function retryMentionDynamicCompletion() {
    if (!mentionDynamicCacheKey) return;
    void mentionDynamicQuery.refetch();
  }

  function retryLaunchTargets() {
    if (!launchCompletionActive) return;
    void launchTargetsQuery.refetch();
  }

  useEffect(() => {
    mentionListReset.current = true;
    let next = 0;
    for (let index = 0; index < visibleMentionItems.length; index++) {
      const item = visibleMentionItems[index];
      if (!item || item.type !== "candidate" || !item.candidate.unavailable) { next = index; break; }
    }
    setActiveIndex(next);
    setLaunchNavigation(false);
    setExpandedMentionKinds(new Set());
    // visibleMentionItems is the list this query shows. Depending on it would
    // reset the highlight again whenever a group expands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeMention?.query,
    activeMention?.start,
    channel?.id,
    slashCompletion.active?.query,
    slashCompletion.active?.stage,
    activeReference?.kind,
    activeReference?.start,
    activeReference?.query,
    activeReferenceSection,
  ]);

  useEffect(() => {
    if (mentionListReset.current) {
      mentionListReset.current = false;
      return;
    }
    const item = visibleMentionItems[activeIndex];
    if (item?.type !== "candidate" || !item.candidate.unavailable) return;
    const count = visibleMentionItems.length;
    for (let step = 1; step <= count; step++) {
      const index = (activeIndex + step) % count;
      const next = visibleMentionItems[index];
      if (!next || next.type !== "candidate" || !next.candidate.unavailable) {
        if (index !== activeIndex) setActiveIndex(index);
        return;
      }
    }
  }, [activeIndex, visibleMentionItems]);

  useEffect(() => {
    mentionOptionRefs.current.length = showSlashSuggestions
        ? slashItems.length
        : showReferenceSuggestions
          ? referenceItems.length
          : visibleMentionItems.length;
  }, [
    showSlashSuggestions,
    showReferenceSuggestions,
    referenceItems.length,
    slashItems.length,
    visibleMentionItems.length,
  ]);

  useLayoutEffect(() => {
    if (!showMentionSuggestions && !showSlashSuggestions && !showReferenceSuggestions) return;

    const list = mentionListRef.current;
    const option = mentionOptionRefs.current[activeIndex];
    if (!list || !option) return;

    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    const visibleTop = list.scrollTop;
    const visibleBottom = visibleTop + list.clientHeight;
    const scrollPadding = 4;

    if (optionTop < visibleTop) {
      list.scrollTo({ top: Math.max(0, optionTop - scrollPadding) });
    } else if (optionBottom > visibleBottom) {
      list.scrollTo({ top: optionBottom - list.clientHeight + scrollPadding });
    }
  }, [
    activeIndex,
    showMentionSuggestions,
    showSlashSuggestions,
    showReferenceSuggestions,
    referenceItems.length,
    slashItems.length,
    visibleMentionItems.length,
  ]);

  function syncCursor(target: HTMLTextAreaElement) {
    setCursor(target.selectionStart || 0);
  }

  function focusAndSelect(expectedValue: string, nextCursor: number) {
    scheduleTextareaSelection(
      () => textareaRef.current,
      expectedValue,
      { start: nextCursor, end: nextCursor }
    );
  }

  function pickedLaunch(value: string, nextCursor: number, write: () => void) {
    write();
    setAfterLaunchPick({ body: value, cursor: nextCursor });
    setLaunchNavigation(false);
    setDismissedCompletionDraft(null);
    setCursor(nextCursor);
    focusAndSelect(value, nextCursor);
  }

  function applyMention(candidate: MentionCandidate) {
    if (candidate.unavailable) return;
    if (candidate.launchTags && activeMention) {
      const next = completeLaunchFragment(draft, activeMention, candidate.launchTags);
      pickedLaunch(next.value, next.cursor, () => onDraftChange(next.value));
      return;
    }
    const next = completeMention(draft, cursor, candidate);
    setDismissedCompletionDraft(null);
    if (candidate.invocationTarget && activeMention && onInvocationSelect) {
      const text = `@${candidate.mention || candidate.name}`;
      onInvocationSelect(next.value, { start: activeMention.start, end: activeMention.start + text.length,
        text, target: candidate.invocationTarget }, candidate.name);
    } else onDraftChange(next.value);
    setCursor(next.cursor);
    focusAndSelect(next.value, next.cursor);
  }

  function expandMentionKind(kind: MentionCandidate["kind"]) {
    setExpandedMentionKinds((current) => {
      if (current.has(kind)) return current;
      return new Set([...current, kind]);
    });
  }

  function expandableMentionKindForActiveItem(): MentionCandidate["kind"] | null {
    const item = visibleMentionItems[activeIndex];
    if (!item) return null;
    if (item.type === "expand") return item.sectionKind;

    const section = mentionSuggestionSections.find(
      (candidateSection) => candidateSection.kind === item.sectionKind
    );
    return section && section.hiddenCount > 0 ? section.kind : null;
  }

  function applyMentionItem(index: number) {
    const item = visibleMentionItems[index] || visibleMentionItems[0];
    if (!item) return;
    if (item.type === "expand") {
      expandMentionKind(item.sectionKind);
      return;
    }
    applyMention(item.candidate);
  }

  function applySlashDraft(next: { value: string; cursor: number }) {
    onDraftChange(next.value);
    setCursor(next.cursor);
    focusAndSelect(next.value, next.cursor);
  }

  function applySlashCommand(command: SlashCommandCandidate) {
    /* With one instance there is nothing to choose, so asking would be a stage
       that always has the same answer. Commit both halves at once. */
    if (command.targets.length === 1) {
      applySlashDraft(
        completeSlashCommandTarget(draft, cursor, command.token, command.targets[0].mention)
      );
      return;
    }
    applySlashDraft(completeSlashCommandToken(draft, cursor, command.token));
  }

  function applySlashTarget(target: SlashCommandTarget) {
    const token = slashCompletion.command?.token;
    if (!token) return;
    applySlashDraft(completeSlashCommandTarget(draft, cursor, token, target.mention));
  }

  function applySlashItem(index: number) {
    if (slashCompletion.stage === "command") {
      const command = slashCompletion.commands[index] || slashCompletion.commands[0];
      if (command) applySlashCommand(command);
      return;
    }
    const target = slashCompletion.targets[index] || slashCompletion.targets[0];
    if (target) applySlashTarget(target);
  }

  function applyReference(candidate: ReferenceCandidate) {
    if (!activeReference) return;
    const pageTitle = candidate.kind === "page" && candidate.blockId ? sectionDocument.data?.title : undefined;
    const { text, token: reference } = referenceInsertion(candidate, pageTitle);
    setDismissedCompletionDraft(null);
    if (onReferenceSelect) {
      const next = completeReference(draft, activeReference, text);
      onReferenceSelect(next.value, { start: next.start, end: next.end, text, reference });
      setCursor(next.cursor);
      focusAndSelect(next.value, next.cursor);
      return;
    }
    // A composer that cannot keep the pick beside the text writes the id token itself.
    const next = completeReference(draft, activeReference, reference);
    onDraftChange(next.value);
    setCursor(next.cursor);
    focusAndSelect(next.value, next.cursor);
  }

  function dismissCompletion() {
    setDismissedCompletionDraft(draft);
    setCursor(-1);
  }

  function handleCompletionKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    const optionCount = showSlashSuggestions
        ? slashItems.length
        : showReferenceSuggestions
          ? referenceItems.length
          : visibleMentionItems.length;
    const open = showMentionSuggestions || showSlashSuggestions || showReferenceSuggestions;
    // First layer, before anything else can claim a key: during IME composition
    // the arrows walk the candidate list, Enter and Tab commit it, and Escape
    // cancels it. Every one of those belongs to the input method.
    if (
      isComposerImeKeyDown({
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
      })
    ) {
      return false;
    }
    if (!open) return false;
    /* Escape closes whatever is open, with or without something to pick — a
       stage the human cannot leave is worse than one that offers nothing. The
       draft is left exactly as typed; only the panel goes away. */
    if (event.key === "Escape") {
      event.preventDefault();
      dismissCompletion();
      return true;
    }
    if (continuingLaunch && !launchNavigation) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setLaunchNavigation(true);
        setActiveIndex(0);
        return true;
      }
      return false;
    }
    // Navigating and accepting still need something to navigate and accept.
    if (
      !composerCompletionHandlesKeyDown({
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
        open,
        optionCount,
      })
    ) {
      return false;
    }

    const mentionChoices = !showSlashSuggestions && !showReferenceSuggestions;
    // An offline machine stays in the list so the reason is visible, and it is
    // not a choice: arrows and Enter move past it.
    const nextMentionIndex = (current: number, direction: 1 | -1) => {
      const count = visibleMentionItems.length;
      if (!count) return 0;
      for (let step = 1; step <= count; step++) {
        const index = (current + direction * step + count) % count;
        const item = visibleMentionItems[index];
        if (!item || item.type !== "candidate" || !item.candidate.unavailable) return index;
      }
      return current;
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => mentionChoices ? nextMentionIndex(current, 1) : (current + 1) % optionCount);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => mentionChoices
        ? nextMentionIndex(current, -1)
        : (current === 0 ? optionCount - 1 : current - 1));
      return true;
    }
    if (event.key === "ArrowRight" && showMentionSuggestions) {
      const expandableKind = expandableMentionKindForActiveItem();
      if (expandableKind) {
        event.preventDefault();
        expandMentionKind(expandableKind);
        return true;
      }
    }
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      if (showSlashSuggestions) {
        applySlashItem(activeIndex);
      } else if (showReferenceSuggestions) {
        const candidate = referenceItems[activeIndex] ?? referenceItems[0];
        if (candidate) applyReference(candidate);
      } else {
        const item = visibleMentionItems[activeIndex];
        if (item?.type === "candidate" && item.candidate.unavailable) return true;
        applyMentionItem(activeIndex);
      }
      return true;
    }
    return false;
  }

  function renderOverlays() {
    return (
      <>
        {showSlashSuggestions && (
            <SlashCommandPanel
              stage={slashCompletion.stage}
              stageLabel={slashCompletion.stageLabel}
              commands={slashCompletion.commands}
              targets={slashCompletion.targets}
              activeIndex={activeIndex}
              optionRef={(index) => (node) => {
                mentionOptionRefs.current[index] = node;
              }}
              listRef={(node) => {
                mentionListRef.current = node;
              }}
              onSelectCommand={applySlashCommand}
              onSelectTarget={applySlashTarget}
            />
          )}
        {showReferenceSuggestions && activeReference && (
            <div
              ref={mentionListRef}
              role="listbox"
              aria-label={activeReference.kind === "channel" ? "Channels" : "Pages"}
              data-testid="composer-reference-suggestions"
              className="app-mention-suggestions w-full overflow-y-auto border-b border-border/60"
              onTouchStart={stopTouchPropagation}
              onTouchMove={stopTouchPropagation}
            >
              <div className="px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                {activeReference.kind === "channel"
                  ? "Channels"
                  : activeReference.section !== null
                    ? "Sections"
                    : "Pages · # for a section"}
              </div>
              {referenceItems.map((candidate, index) => (
                <CompletionOptionButton
                  key={candidate.id}
                  optionRef={(node) => {
                    mentionOptionRefs.current[index] = node;
                  }}
                  selected={index === activeIndex}
                  onSelect={() => applyReference(candidate)}
                  className="min-h-10 border-b border-border/30 last:border-b-0"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center text-foreground/45 [&_svg]:size-[18px] [&_svg]:stroke-[1.75]">
                    {candidate.kind === "channel" ? <Hash /> : <FileText />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="block truncate font-semibold">{candidate.label}</span>
                    {candidate.detail ? (
                      <span className="block truncate text-xs text-foreground/55">{candidate.detail}</span>
                    ) : null}
                  </span>
                </CompletionOptionButton>
              ))}
            </div>
          )}
        {showMentionOverlay && !showReferenceSuggestions && (
            <div
              ref={mentionListRef}
              role="listbox"
              className="app-mention-suggestions w-full overflow-y-auto border-b border-border/60"
              onTouchStart={stopTouchPropagation}
              onTouchMove={stopTouchPropagation}
            >
              {mentionCompletion.stage !== "target" ? (
                <div className="border-b border-border/60 px-2 py-1.5 text-xs font-bold text-foreground/75">
                  {mentionCompletion.stageLabel}
                </div>
              ) : null}
              {showLaunchTargetStatus ? (
                launchTargetLoadState?.status === "loading" ? (
                  <ContentSkeleton label="Loading launch targets" lines={2} className="border-b border-border/30 px-2 py-2" />
                ) : (
                <div className="flex min-h-10 items-center justify-between gap-2 border-b border-border/30 px-2 py-2 text-sm">
                  <span className="min-w-0 text-foreground/70">
                    {launchTargetLoadState?.message}
                  </span>
                  {launchTargetLoadState ? (
                    launchTargetLoadState.recovery === "configure" && onConfigureAppConnector ? (
                      <button
                        type="button"
                        className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-bold hover:bg-muted"
                        onClick={() => onConfigureAppConnector("github")}
                      >
                        Configure GitHub
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-bold hover:bg-muted"
                        onClick={retryLaunchTargets}
                      >
                        Retry
                      </button>
                    )
                  ) : null}
                </div>
                )
              ) : null}
              {showMentionDynamicStatus ? (
                mentionDynamicLoadState?.status === "loading" ? (
                  <ContentSkeleton
                    label={`Loading ${mentionCompletion.stageLabel.toLowerCase()}`}
                    lines={2}
                    className="px-2 py-2"
                  />
                ) : (
                <div className="flex min-h-10 items-center justify-between gap-2 px-2 py-2 text-sm">
                  <span className="min-w-0 text-foreground/70">
                    {mentionDynamicLoadState?.status === "error"
                        ? mentionDynamicLoadState.message
                        : `No matching ${mentionCompletion.stageLabel.toLowerCase()}.`}
                  </span>
                  {mentionDynamicLoadState?.status === "error" &&
                  mentionDynamicLoadState.recovery === "configure" &&
                  mentionDynamicProviderId &&
                  onConfigureAppConnector ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-bold hover:bg-muted"
                      onClick={() => onConfigureAppConnector(mentionDynamicProviderId)}
                    >
                      Configure GitHub
                    </button>
                  ) : mentionDynamicLoadState?.status === "error" &&
                    mentionDynamicLoadState.recovery === "retry" ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-bold hover:bg-muted"
                      onClick={retryMentionDynamicCompletion}
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
                )
              ) : null}
              {mentionSuggestionSections.map((section) => (
                <div key={section.kind}>
                  {/* A folded section carries its label on the fold row itself,
                      so it costs one line rather than a header plus a row. */}
                  {mentionCompletion.stage === "target" && section.candidates.length > 0 ? (
                    <div className="px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                      {section.label}
                    </div>
                  ) : null}
                  {section.candidates.map((candidate, sectionIndex) => {
                    const index = section.startIndex + sectionIndex;
                    const isApp = candidate.kind === "app";
                    const isAiService = candidate.kind === "service";
                    // Launch rows keep their tags wherever they are listed:
                    // Auto and runtimes sit among the Agents at a fresh `@`.
                    const isLaunch = Boolean(candidate.launchTags);
                    const isAppCommand = candidate.action === "app-command";
                    const isAgentGoal = candidate.action?.startsWith("agent-goal-") || false;
                    const isAgentCommand =
                      isAgentGoal ||
                      candidate.action === "agent-model-switch" ||
                      candidate.action === "agent-effort-switch";
                    // A bare Agent row is a registration to summon. Its neutral
                    // internal `offline` value is not live presence, and the
                    // row's existence already communicates summonability.
                    const isSummonableAgent =
                      candidate.kind === "agent" &&
                      !candidate.action &&
                      (candidate.completionSuffix === ":" || Boolean(candidate.invocationTarget || candidate.launchTags));

                    return (
                      <CompletionOptionButton
                        key={candidate.id}
                        optionRef={(node) => {
                          mentionOptionRefs.current[index] = node;
                        }}
                        selected={index === activeIndex && (!continuingLaunch || launchNavigation)}
                        disabled={Boolean(candidate.unavailable)}
                        onSelect={() => applyMention(candidate)}
                        className="min-h-10 border-b border-border/30 last:border-b-0"
                      >
                        {isApp || isAiService || isLaunch || isAgentCommand ? (
                          <span className="flex size-7 shrink-0 items-center justify-center text-foreground/45 [&_svg]:size-[18px] [&_svg]:stroke-[1.75]">
                            {isAgentGoal ? (
                              <Pin className="size-4" />
                            ) : candidate.action === "agent-model-switch" ||
                              candidate.action === "agent-effort-switch" ? (
                              <Wrench className="size-4" />
                            ) : isAiService || isLaunch ? (
                              <Zap className="size-4" />
                            ) : (
                              <PlugZap className="size-4" />
                            )}
                          </span>
                        ) : (
                          <IdentityAvatar
                            kind={candidate.kind === "agent" ? "agent" : "human"}
                            label={candidate.name}
                            initials={avatarInitials(candidate.name)}
                            imageUrl={candidate.avatarUrl}
                            size="sm"
                            shape="circle"
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {isApp || isAiService || isLaunch || isAgentCommand || isSummonableAgent ? (
                            <>
                              <span className="block truncate font-semibold">{candidate.name}</span>
                              <span className="block truncate text-xs text-foreground/55">
                                {candidate.description || `@${candidate.mention}`}
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="font-semibold">{candidate.name}</span>
                              <span className="ml-1.5 text-foreground/50">
                                @{candidate.mention || candidate.name}
                              </span>
                            </>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {/* Only concrete Instances expose ordinary locality
                              and presence badges. A normal Profile needs no
                              badge merely because it can be summoned here. */}
                          {candidate.local && !isSummonableAgent && (
                            <span className="rounded bg-primary/10 px-1.5 py-0 text-[10px] font-bold text-primary">
                              this machine
                            </span>
                          )}
                          {!isSummonableAgent && (
                            <span className="rounded bg-muted/70 px-1.5 py-0 text-[10px] text-muted-foreground">
                              {isLaunch ? (candidate.unavailable ? "offline" : (Object.keys(candidate.launchTags ?? {})[0] || "auto")) : isAgentCommand
                                    ? candidate.action === "agent-model-switch"
                                      ? "model"
                                      : candidate.action === "agent-effort-switch"
                                        ? "effort"
                                        : "goal"
                                    : isAppCommand
                                      ? "action"
                                      : isAiService
                                        ? "AI"
                                      : isApp
                                        ? "app"
                                        : candidate.kind === "agent"
                                          ? candidate.status
                                          : "human"}
                            </span>
                          )}
                        </span>
                      </CompletionOptionButton>
                    );
                  })}
                  {section.hiddenCount > 0 &&
                    (() => {
                      const index = section.startIndex + section.candidates.length;
                      return (
                        <CompletionOptionButton
                          key={`${section.kind}:more`}
                          optionRef={(node) => {
                            mentionOptionRefs.current[index] = node;
                          }}
                          selected={index === activeIndex}
                          onSelect={() => expandMentionKind(section.kind)}
                          className="min-h-6 gap-1 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60"
                        >
                          <ChevronRight className="size-3 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{section.label}</span>
                          <span className="shrink-0 text-muted-foreground/50">
                            +{section.hiddenCount}
                          </span>
                        </CompletionOptionButton>
                      );
                    })()}
                </div>
              ))}
            </div>
          )}
      </>
    );
  }

  return {
    cursor,
    setCursor,
    syncCursor,
    isCompletionOpen,
    appMentions,
    handleCompletionKeyDown,
    dismissCompletion,
    renderOverlays,
  };
}
