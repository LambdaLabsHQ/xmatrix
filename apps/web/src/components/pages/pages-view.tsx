"use client";
import { channelPresenceInstances, pageReferenceToken } from "@xmatrix/protocol";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PageDocBlock } from "@xmatrix/protocol/page-document";
import {
  agentPresetAvatarUrl, isLiveAgentStatus, normalizeAgentPresetRuntime, pageAuthorColor, pageAuthorLabel,
  type SerializedAutomation, type ChannelSnapshot, type PageConversation, type PageLink,
} from "@xmatrix/protocol";
import {
  Check, Clock, Files, FileText, History, Lock, MessageSquare, Plus, Share2, Trash2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { noticeClass } from "@/components/ui/status-tone";
import { actionClass } from "@/components/ui/action-tone";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import {
  PageLiveSession, pageApi, pageChildren,
  type PageLinkAnchor, type PagePresenceState, type PageRecentChange, type PageSummary, type PageTreeActivity, type PageTreeAgent,
} from "@/lib/pages/page-client";
import { cn } from "@/lib/utils";
import { ListSkeleton } from "@/components/dashboard/content-skeleton";
import { CountPill } from "@/components/dashboard/count-pill";
import { avatarInitials } from "@/components/dashboard/completion-option-button";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { MobileInlineActions } from "@/components/dashboard/mobile-inline-actions";
import { useMessageReferenceCatalog } from "@/components/dashboard/message-reference-catalog";
import { listenForOverlayDismissal } from "@/components/dashboard/use-overlay-dismiss";
import { pagesViewPath } from "@/components/dashboard/workspace-shell-navigation";
import type {
  CursorPresence, Discussion, HeadingActions, PageCompletion, PageReading, PageSectionActions, SectionNote,
  SuggestionControl,
} from "./page-editor";
import { PageAttached, type PageScheduleInput } from "./page-attached";
import {
  ConversationList, DeletePageDialog, PageChangeMark, PageDialog, PageHistory, PagePens, PageOffscreenPeople, PageScrollMarks, PresenceStack, ShareDialog, type OffscreenPerson, type PagePen, type PresentPerson, type PageScrollMark,
} from "./page-chrome";
import { PageMargin, type MarginWriter } from "./page-margin";
import { PagePhoneDock } from "./page-phone-dock";
import { PageReaderChangeGutter, PageReaderChangeMark } from "./page-reader-changes-bar";
import type { SuggestionsReport } from "./page-suggestions";
import { usePageSuggestions } from "./use-page-suggestions";
import { PageWriteWith } from "./page-write-with";
import { takeCoWriteRequest } from "@/lib/pages/co-write-request";
import { useOnboardingCopy } from "@/lib/onboarding-locale";
import { usePageWriters } from "./page-writers";
import { marginConversations, sectionConversationCounts, withOpenConversation, type LiveConversation } from "./page-margin-model";
import { formatRelativeAge, mobileChatTimeLabel } from "@/components/dashboard/time-display";
import { ListSectionHeading } from "@/components/dashboard/list-section-heading";
import { InlineRowPreview } from "@/components/dashboard/inline-row-preview";
import { MORE_RECENT_CHANGES, RECENT_CHANGES, pageRecentChangePreview, pageTreeHeadKey } from "./page-recent-changes";
import {
  discussionQuote, discussionTitle, quotedMessage, type DiscussionQuote,
} from "@/components/dashboard/selection-discussion";
import { refetchUnlessHumanPush } from "@/components/dashboard/workspace-resource-push";
import { PageMigrationReview, usePageMigration } from "./page-migration-review";
import { NEW_PAGE_ID, NEW_PAGE_TITLE, type PageCreation } from "./page-creation";
import { PageTreeRow } from "./page-tree-row";
import type { PageReferenceTargets } from "./page-reference-chips";
import { userErrorMessage } from "@/lib/user-facing-error";

// The native shell also imports this module for its list screens. The editor
// (ProseMirror and the page document) belongs to an open document, not to the cold-start list dependency graph.
const PageEditor = dynamic(() => import("./page-editor").then((module) => module.PageEditor), {
  ssr: false,
  loading: () => null,
});
// Until the editor is drawn, the page shows its prefetched document as the editor will draw it.
const PageDocumentStatic = dynamic(() => import("./page-document-static").then((module) => module.PageDocumentStatic), {
  ssr: false,
  loading: () => null,
});

/** The top-level heading the document opens with. That heading is the page's name. */
function openingHeading(blocks: PageDocBlock[], markdown: string | undefined): string | null {
  if (blocks.length > 0) return blocks[0].pos === 0 && blocks[0].depth === 1 ? blocks[0].title.trim() || null : null;
  const line = markdown?.trimStart().split("\n", 1)[0]?.trim() ?? "";
  return /^#[ \t]+(\S.*)$/u.exec(line)?.[1]?.trim() ?? null;
}

/**
 * Pages (docs/design/pages-and-conversations.md): the Space's living documents.
 * The tree is how the organization is read; each page is co-edited live by
 * people and Agents, with who is on each section shown beside it.
 */

const PAGE_SERVER_OUTDATED_NOTICE = "Live editing is being updated; the page will open for editing in a moment.";

export function usePageTree(spaceId: string | null, token: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-tree", [spaceId]),
    enabled: Boolean(spaceId && token && user?.id), staleTime: 5_000, refetchInterval: 30_000,
    queryFn: ({ signal }) => pageApi.tree(spaceId!, token, signal).then((result) => result.pages),
  });
}

interface PageTreeActivities {
  /** The Agents reading or editing each page from a live Run. */
  agents: Map<string, PageTreeAgent[]>;
  /** Each page's open discussions, as this reader sees them. */
  discussions: Map<string, PageTreeActivity["discussions"]>;
}

function usePageAgents(spaceId: string | null, token: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-tree-agents", [spaceId]),
    enabled: Boolean(spaceId && token && user?.id), staleTime: 5_000, refetchInterval: 15_000,
    queryFn: ({ signal }) => pageApi.agents(spaceId!, token, signal).then((result): PageTreeActivities => ({
      agents: new Map(result.pages.map((page) => [page.pageId, page.agents])),
      discussions: new Map(result.pages.map((page) => [page.pageId, page.discussions])),
    })),
  });
}

const NO_ACTIVITY: PageTreeActivities = { agents: new Map(), discussions: new Map() };

/**
 * A page's open discussions beside its title, as Google Docs counts unresolved
 * comments. While one has replies this reader has not read, the count wears the
 * app's count chip, as a conversation's unread does; otherwise it stays faint.
 */
function PageDiscussionCount({ open, unread }: { open: number; unread: number }) {
  const label = `${open} open discussion${open === 1 ? "" : "s"}${unread > 0 ? `, ${unread} with unread replies` : ""}`;
  if (unread > 0) {
    return (
      <span className="app-page-row-discussions flex shrink-0 items-center px-0.5" data-testid="page-tree-discussions"
        aria-label={label}>
        <CountPill count={open} title={label} />
      </span>
    );
  }
  return (
    <span className="app-page-row-discussions app-page-row-discussions-read flex shrink-0 items-center gap-1 px-0.5 text-xs tabular-nums text-muted-foreground"
      data-testid="page-tree-discussions" title={label} aria-label={label}>
      <MessageSquare className="size-3.5" aria-hidden="true" />{open}
    </span>
  );
}

function names(agents: readonly PageTreeAgent[]): string {
  const unique = [...new Set(agents.map((agent) => agent.name))];
  return unique.length > 2 ? `${unique.slice(0, 2).join(", ")} +${unique.length - 2}` : unique.join(", ");
}

/**
 * A page row's second line, what is happening on the page: an Agent editing
 * it and where, else the newest reply in its open discussions, else how the
 * page stands (its summary), else who is reading it, else when it last
 * changed. Whoever is on the page is also drawn at the line's end, so a
 * summary is not given up for "reading".
 */
export function pageRowMeta(page: Pick<PageSummary, "updatedAt" | "summary" | "headRevision">, agents: readonly PageTreeAgent[],
  latest: PageTreeActivity["discussions"]["latest"] = null, now = Date.now()): ReactNode {
  const editing = agents.filter((agent) => agent.activity === "editing");
  if (editing.length > 0) {
    const sections = [...new Set(editing.map((agent) => agent.section).filter(Boolean))];
    return `${names(editing)} editing${sections.length === 1 ? ` · ${sections[0]}` : ""}`;
  }
  if (latest) return <>{latest.from.label}: <InlineRowPreview text={latest.bodyPreview} /></>;
  if (page.summary?.text && page.summary.revision === page.headRevision) return <InlineRowPreview text={page.summary.text} />;
  if (agents.length > 0) return `${names(agents)} reading`;
  const age = formatRelativeAge(page.updatedAt, now);
  return age ? `Edited ${age}` : "";
}

function TreeNode({ page, childrenOf, activity, depth, selectedPageId, onSelect, onPrefetch, onCreateChild }: {
  page: PageSummary; childrenOf: Map<string | null, PageSummary[]>; activity: PageTreeActivities; depth: number;
  selectedPageId: string | null; onSelect: (pageId: string) => void; onPrefetch: (pageId: string) => void;
  /** Makes a page under this one, from the row itself. */
  onCreateChild?: (pageId: string) => void;
}) {
  const children = childrenOf.get(page.pageId) ?? [];
  const [open, setOpen] = useState(true);
  const selected = page.pageId === selectedPageId;
  const agents = activity.agents.get(page.pageId) ?? [];
  const discussions = activity.discussions.get(page.pageId);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actions = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!actionsOpen) return;
    const close = () => setActionsOpen(false);
    return listenForOverlayDismissal((event) => {
      if (!(event.target instanceof Node && actions.current?.contains(event.target))) close();
    }, close);
  }, [actionsOpen]);
  // Revisions the page has gained since this reader last had it on screen.
  const unread = typeof page.readRevision === "number" ? Math.max(0, page.headRevision - page.readRevision) : 0;
  return (
    <li>
      <PageTreeRow depth={depth} selected={selected} open={open}
        onToggle={() => setOpen((value) => !value)} expandHidden={children.length === 0}
        onLongPress={onCreateChild ? () => setActionsOpen(true) : undefined}>
        <button type="button" className="flex min-w-0 flex-1 flex-col text-left"
          onClick={() => onSelect(page.pageId)} onPointerEnter={() => onPrefetch(page.pageId)}
          onFocus={() => onPrefetch(page.pageId)}>
          <span className="app-page-row-title-line flex min-w-0 items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="app-page-row-title app-list-row-title min-w-0 truncate">{page.title}</span>
            {page.accessMode === "restricted" && <Lock className="size-3 shrink-0 text-muted-foreground" />}
            <span className="app-channel-row-time ml-auto shrink-0 pl-2">{mobileChatTimeLabel(page.updatedAt)}</span>
          </span>
          <span className="app-page-row-meta-line flex min-w-0 items-center gap-1.5">
            <span className="app-list-row-meta min-w-0 flex-1 truncate">{pageRowMeta(page, agents, discussions?.latest)}</span>
            {agents.length > 0 && (
              <span className="app-channel-agent-avatars flex shrink-0 items-center -space-x-1.5 px-0.5" data-testid="page-tree-agents">
                {[...new Map(agents.map((agent) => [agent.name, agent])).values()].slice(0, 3).map((agent) => (
                  <IdentityAvatar key={agent.instanceId} kind="agent" label={agent.name} status={agent.status}
                    imageUrl={agent.avatarUrl} size="sm" showKindBadge={false}
                    className="app-channel-agent-avatar rounded-full" />
                ))}
              </span>
            )}
            {unread > 0 && <CountPill count={unread} title="Changes since you read this page" className="shrink-0" />}
          </span>
        </button>
        {discussions && discussions.open > 0 && <PageDiscussionCount open={discussions.open} unread={discussions.unread} />}
        {/* Shown while the row is hovered; a touch screen has no hover and long-presses the row instead. */}
        {onCreateChild && (
          <button type="button" aria-label="New sub-page" title="New sub-page"
            onClick={() => onCreateChild(page.pageId)}
            className="app-page-row-create flex size-4 shrink-0 items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:hidden">
            <Plus className="size-4" />
          </button>
        )}
      </PageTreeRow>
      {actionsOpen && onCreateChild && (
        <div ref={actions}>
          <MobileInlineActions label={`Page actions for ${page.title}`} className="app-mobile-channel-inline-actions"
            actions={[{ key: "new-sub-page", icon: Plus, label: "New sub-page",
              onSelect: () => { setActionsOpen(false); onCreateChild(page.pageId); } }]} />
        </div>
      )}
      {open && children.length > 0 && (
        <ul>
          {children.map((child) => (
            <TreeNode key={child.pageId} page={child} childrenOf={childrenOf} activity={activity} depth={depth + 1}
              selectedPageId={selectedPageId} onSelect={onSelect} onPrefetch={onPrefetch} onCreateChild={onCreateChild} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * A page's latest change, drawn as a conversation row: the page and the
 * section on the first line with when, who wrote what on the second. It
 * opens the page at that section.
 */
function RecentChangeRow({ change, onOpen }: { change: PageRecentChange; onOpen: () => void }) {
  return (
    <li>
      <div role="button" tabIndex={0} onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen();
        }}
        className="app-recent-change app-list-row flex min-w-0 cursor-pointer flex-col">
        <span className="app-page-row-title-line flex min-w-0 items-center gap-2">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="app-list-row-title min-w-0 flex-1 truncate">
            {change.title}
            {change.block?.title && <span className="app-recent-change-section"> › {change.block.title}</span>}
          </span>
          <span className="app-channel-row-time shrink-0">{mobileChatTimeLabel(change.createdAt)}</span>
        </span>
        <span className="app-list-row-meta truncate">{pageRecentChangePreview(change)}</span>
      </div>
    </li>
  );
}

/** The page tree, for the sidebar beside the Pages view. */
/**
 * A page's current document, as read over HTTP. It is what the page shows
 * until its live session has synced, so the tree prefetches it: opening a
 * page is then immediate, and the live editor takes over a moment later.
 */
export function pageDocumentQuery(userId: string | null, spaceId: string, pageId: string, token: string) {
  return {
    queryKey: xmatrixQueryKeys.domain({ userId: userId ?? "anonymous" }, "page-document", [spaceId, pageId]),
    staleTime: 60_000,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      pageApi.read(spaceId, pageId, token, undefined, signal).then((result) => result.page),
  };
}

/**
 * A page's discussions with the conversations they name (its margin), its section awareness and its
 * Automations. Their keys do not carry the page's revision: the live session's commits invalidate them,
 * so a page opens on what was read ahead and keeps it on screen while it is read again.
 */
/**
 * A comment as its discussion's first message: an Agent it mentions starts on it at once; one that mentions no
 * Agent goes to xMatrix to give to one.
 */
export function commentBody(text: string, agents: readonly string[]): string {
  const mention = /(^|\s)[@＠]([\p{L}\p{N}_.:-]+)/gu;
  for (const match of text.matchAll(mention)) {
    if (!agents.includes(match[2]!.split(":")[0]!)) continue;
    const end = match.index! + match[0].length;
    return `${text.slice(0, end)} launch:force${text.slice(end)}`;
  }
  return `@auto ${text}`;
}

function pageLinksQuery(userId: string | null, spaceId: string, pageId: string, token: string) {
  return {
    queryKey: xmatrixQueryKeys.domain({ userId: userId ?? "anonymous" }, "page-links", [spaceId, pageId]),
    staleTime: 10_000,
    queryFn: ({ signal }: { signal: AbortSignal }) => pageApi.links(spaceId, token, { pageId }, signal),
  };
}

const PAGE_REVISION_QUERIES = ["page-links", "page-automations", "page-awareness"];
// Co-writing commits arrive many a second; what they move beside the page is read again once they settle.
const REVISION_REFRESH_MS = 1_000;

// The editor and the preview are read ahead, so a page's first opening waits on neither.
function preloadPageChunks() {
  void import("./page-editor");
  void import("./page-document-static");
}

const PREFETCHED_PAGES = 40;

export function PageTreePanel({ spaceId, token, selectedPageId, onSelectPage, onOpenSection, creation,
  layout = "sidebar", create }: {
  spaceId: string | null; token: string; selectedPageId: string | null; onSelectPage: (pageId: string) => void;
  /** Opens a page at one of its sections, as a recent change does. */
  onOpenSection: (pageId: string, blockId: string | null) => void;
  creation: PageCreation;
  /** The list's +, first under its name: a new page. */
  create?: ReactNode;
  /**
   * On a phone the tree is the Pages tab's list screen, in the same shell as
   * the Channels list; its + is the top bar's.
   */
  layout?: "sidebar" | "phone";
}) {
  const tree = usePageTree(spaceId, token);
  const activity = usePageAgents(spaceId, token).data ?? NO_ACTIVITY;
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const prefetch = useCallback((pageId: string) => {
    preloadPageChunks();
    if (!spaceId) return;
    void queryClient.prefetchQuery(pageDocumentQuery(userId, spaceId, pageId, token));
    // About to be opened: its margin is read with it.
    void queryClient.prefetchQuery(pageLinksQuery(userId, spaceId, pageId, token));
  }, [queryClient, spaceId, token, userId]);
  // The Space's pages are read ahead, a few at a time, so opening one does not wait on the network.
  useEffect(() => {
    const pages = (tree.data ?? []).slice(0, PREFETCHED_PAGES);
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < pages.length && !cancelled; i += 4) {
        await Promise.all(pages.slice(i, i + 4).map((page) => spaceId
          ? queryClient.prefetchQuery(pageDocumentQuery(userId, spaceId, page.pageId, token)) : undefined));
      }
    })();
    return () => { cancelled = true; };
  }, [queryClient, spaceId, token, tree.data, userId]);
  const childrenOf = useMemo(() => pageChildren(tree.data ?? []), [tree.data]);
  const roots = childrenOf.get(null) ?? [];
  // Read again only when the tree says a page changed: it rides the tree's refresh, with no clock of its own.
  const [moreChanges, setMoreChanges] = useState(false);
  const changeLimit = moreChanges ? MORE_RECENT_CHANGES : RECENT_CHANGES;
  const headKey = useMemo(() => pageTreeHeadKey(tree.data ?? []), [tree.data]);
  const recent = useQuery<PageRecentChange[]>({
    queryKey: xmatrixQueryKeys.domain({ userId: userId ?? "anonymous" }, "page-recent-changes",
      [spaceId, headKey, changeLimit]),
    enabled: Boolean(spaceId && token && userId && roots.length > 0),
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => pageApi.recentChanges(spaceId!, token, changeLimit, signal).then((result) => result.changes ?? []),
  });
  const changes = roots.length > 0 ? recent.data ?? [] : [];

  // The tree's other lines start where its rows' content and its header do.
  const inset = "px-[var(--app-list-row-start)]";
  const contents = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {tree.isLoading && <ListSkeleton label="Loading pages" rows={6} />}
        {tree.isError && <p className={`${inset} text-sm text-destructive`}>Pages are unavailable.</p>}
        {tree.data && roots.length === 0 && (
          <div className={`${inset} py-4 text-sm text-muted-foreground`}>
            <p>No pages yet.</p>
            <Button className="mt-2" size="sm" variant="outline" onClick={() => void creation.create(null)}>
              Create the first page
            </Button>
          </div>
        )}
        {changes.length > 0 && (
          <section data-testid="page-recent-changes">
            <ListSectionHeading label="Recent changes" mark={{ icon: Clock, tone: "plain" }}
              action={moreChanges ? { label: "Less", onClick: () => setMoreChanges(false) }
                : changes.length >= RECENT_CHANGES ? { label: "More", onClick: () => setMoreChanges(true) } : undefined} />
            <ul>{changes.map((change) => (
              <RecentChangeRow key={change.pageId} change={change}
                onOpen={() => onOpenSection(change.pageId, change.block?.id ?? null)} />
            ))}</ul>
          </section>
        )}
        {/* The list always meets the plank with a section's name, never a bare row. */}
        {roots.length > 0 && <ListSectionHeading label="All pages" mark={{ icon: Files, tone: "primary" }} />}
        <ul>{roots.map((page) => (
          <TreeNode key={page.pageId} page={page} childrenOf={childrenOf} activity={activity} depth={0}
            selectedPageId={selectedPageId} onSelect={onSelectPage} onPrefetch={prefetch}
            onCreateChild={(pageId) => void creation.create(pageId)} />
        ))}</ul>
      </div>
    </>
  );
  if (layout === "phone") {
    return (
      <div className="app-mobile-chat-pane app-mobile-channel-list-pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        data-testid="page-list">
        <div className="app-material-scroll-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="app-material-scroll-content app-mobile-page-list min-h-full shrink-0 pb-1 text-base">
            {contents}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="page-tree">
      <div className="app-band-header flex items-center px-5 pt-3 pb-2">
        <span className="text-xs font-black uppercase tracking-wide text-muted-foreground">Pages</span>
      </div>
      {create}
      {contents}
    </div>
  );
}

/** A page is restricted when it or any ancestor is. */
/** The new page + opened, as the page list would show it, until its first write makes it. */
function unmadePage(parentPageId: string | null): PageSummary {
  return { pageId: NEW_PAGE_ID, parentPageId, title: NEW_PAGE_TITLE, position: "", accessMode: "open", headRevision: 0,
    agentSuggestOnly: false, canEdit: true, updatedAt: "", publishedAt: null, governance: false };
}

function effectivelyRestricted(pageId: string, pages: readonly PageSummary[]): boolean {
  const byId = new Map(pages.map((page) => [page.pageId, page]));
  for (let page = byId.get(pageId), depth = 0; page && depth < 64;
    page = page.parentPageId ? byId.get(page.parentPageId) : undefined, depth++) {
    if (page.accessMode === "restricted") return true;
  }
  return false;
}

/** The live Run on the page whose Agent this awareness is, matched as the page tree matches them. */
function liveRunOf(state: PagePresenceState, agents: readonly PageTreeAgent[]): PageTreeAgent | undefined {
  const user = state.user;
  if (user?.kind !== "agent") return undefined;
  return agents.find((agent) => agent.conversationId === user.conversationId &&
    (agent.name === user.name || agent.name.startsWith(`${user.name}:`)));
}

/** How long the page stays on screen at a new revision before it counts as read there. */
const READ_AFTER_MS = 1_500;

function usePresence(session: PageLiveSession | null): Array<{ clientId: number; state: PagePresenceState }> {
  const [states, setStates] = useState<Array<{ clientId: number; state: PagePresenceState }>>([]);
  useEffect(() => {
    if (!session) return;
    const read = () => startTransition(() => setStates([...session.awareness.getStates().entries()]
      .filter(([clientId]) => clientId !== session.doc.clientID)
      .map(([clientId, state]) => ({ clientId, state: state as PagePresenceState }))
      .filter(({ state }) => Boolean(state?.user))));
    // This reader's own caret moves on every key; only others' presence is shown.
    const changed = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      if ([...added, ...updated, ...removed].some((clientId) => clientId !== session.doc.clientID)) read();
    };
    read();
    session.awareness.on("change", changed);
    return () => session.awareness.off("change", changed);
  }, [session]);
  return states;
}


/** The Agents live in a conversation this client holds, from its member presence. */
/** The time now, renewed every second while `active`. */
function useTicking(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function liveAgents(channel: ChannelSnapshot): LiveConversation["agents"] {
  if (!channel.presence) return undefined;
  return channelPresenceInstances(channel.presence).flatMap(instance => isLiveAgentStatus(instance.status)
    ? [{ instanceId: instance.id, name: instance.label || instance.agentName, status: instance.status }] : []);
}

/** What an Agent co-writing live is doing, as its face at the edge says it (page-co-writer.ts). */
const CO_WRITER_DOING: Partial<Record<string, string>> = { thinking: "thinking", writing: "writing", waiting: "waiting for you" };

/** A duration as a face's tag says it: "19s", "2m". */
function briefDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

/** Room at the bottom of a phone's page that its button and capsule cover, so a line there counts as out of view. */
const PEN_BOTTOM_ROOM = 110;
/** On a desktop only a face waiting at the bottom edge covers it. */
const DESKTOP_PEN_BOTTOM_ROOM = 44;

/** How long an Agent called to write shows on the page's button before its Run is on the page. */
const CALLED_SHOWS_MS = 3 * 60_000;

/** The document column at its narrowest beside the margin, plus the margin and the gap between them. */
const MARGIN_ROOM_PX = 640 + 24 + 320;

type PageDialogState =
  | "share"
  | "delete"
  | { kind: "conversations"; blockId: string | null }
  | { kind: "attach"; blockId: string }
  | { kind: "write" }
  | { kind: "agent"; key: string };

export function PagesView({ spaceId, token, selectedPageId, onSelectPage, onOpenSection, onPageDeleted, conversation, activeConversationId = null,
  renderConversation, onConversationDockChange, onCloseConversation, onExpandConversation, onOpenConversation,
  onConversationIntent, onDiscuss, onConnectGitHub, canMigrate, layout = "desktop", focusSection = null,
  creation }: {
  spaceId: string | null;
  token: string;
  /** A made page, or NEW_PAGE_ID for the new page + opened, which its first write makes (page-creation.tsx). */
  selectedPageId: string | null;
  onSelectPage: (pageId: string) => void;
  /** Opens a page a reference in the text names, at its section when it names one. */
  onOpenSection: (pageId: string, blockId?: string | null) => void;
  onPageDeleted: () => void;
  /** What this client knows live about a conversation: the channel it holds, when it holds it. */
  conversation: (conversationId: string) => ChannelSnapshot | null;
  /** The conversation open beside the page: in the margin at what it is about, or docked when there is no room. */
  activeConversationId?: string | null;
  /** The open conversation itself, the product's one conversation surface, for where the page shows it. */
  renderConversation?: (placement: "margin" | "dock") => ReactNode;
  /** Lets shell chrome follow the actual layout rather than inspect descendant DOM. */
  onConversationDockChange?: (docked: boolean) => void;
  /** Closes the open conversation, or gives it the whole window. */
  onCloseConversation?: () => void;
  onExpandConversation?: (conversationId: string) => void;
  /** Opens a conversation beside the page (pages-live-document.md §4.4). */
  onOpenConversation: (conversationId: string) => void;
  /** The reader rests on one of the page's conversations, which may be opened next. */
  onConversationIntent?: (conversationId: string) => void;
  onDiscuss: (input: { spaceId: string; pageId: string; blockId: string; name: string; restricted: boolean;
    anchor?: PageLinkAnchor; firstMessage?: string; quote?: DiscussionQuote; open?: boolean; coWrite?: boolean;
    /** Hears the conversation's id as soon as it is known, before the Hub has made or linked it. */
    planned?: (conversationId: string) => void }) => Promise<unknown>;
  /** Subscribes a conversation of its own, linked to a section, to a repository's issues and pull requests. */
  onConnectGitHub?: (input: { spaceId: string; pageId: string; blockId: string; repository: string;
    restricted: boolean }) => Promise<void>;
  /** A Space owner or admin may move the Space's Channels to pages. */
  canMigrate: boolean;
  /** On a phone a page is a pushed screen, like a conversation; the shell's back bar carries its title. */
  layout?: "desktop" | "phone";
  /** A section a reference opened the page at; a new `seq` brings it into view again. */
  focusSection?: { pageId: string; blockId: string; seq: number } | null;
  creation: PageCreation;
}) {
  const { user } = useAuth();
  const tree = usePageTree(spaceId, token);
  const pages = tree.data ?? [];
  // Held from the moment the owner applies, or opens the report, so the report
  // is read before the new pages replace it.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const migration = usePageMigration(spaceId ?? "", token, canMigrate && Boolean(spaceId));
  const phone = layout === "phone";
  // A new page opens as any page does, but is only this document until its first write makes it: until
  // then it has no id, and nothing that reads a made page asks about it.
  const pending = selectedPageId === NEW_PAGE_ID;
  const parentPageId = creation.parentPageId;
  const newPage = useMemo(() => pending ? unmadePage(parentPageId) : null, [parentPageId, pending]);
  // A desktop opens the first page; a phone starts from the list.
  const pageId = pending ? null : selectedPageId ?? (phone ? null : pageChildren(pages).get(null)?.[0]?.pageId ?? null);
  const page = newPage ?? pages.find((item) => item.pageId === pageId) ?? null;
  const [session, setSession] = useState<PageLiveSession | null>(null);
  // Until the live session has synced, the page shows its prefetched document.
  const [synced, setSynced] = useState(false);
  // The editor is drawn; with the session synced it takes the preview's place.
  const [editorReady, setEditorReady] = useState(false);
  const drawn = synced && editorReady;
  const [connected, setConnected] = useState(false);
  // Like Google Docs: "Saving…" while this person's edits are on their way, then "Saved".
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "offline">("idle");
  const connectedRef = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const [canEdit, setCanEdit] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Reads the page's waiting suggestions again; the live session calls it when one arrives.
  const waitingRefetch = useRef<() => void>(() => undefined);
  const [mode, setMode] = useState<"page" | "history">("page");
  const [dialog, setDialog] = useState<PageDialogState | null>(null);
  // The conversation whose card is being read, so its passage is marked (§4.4).
  const [focused, setFocused] = useState<string | null>(null);
  // A conversation being read is about to be opened: what opening it needs is read now.
  const conversationIntent = useRef(onConversationIntent);
  conversationIntent.current = onConversationIntent;
  useEffect(() => {
    if (focused) conversationIntent.current?.(focused);
  }, [focused]);
  const [anchorTops, setAnchorTops] = useState<ReadonlyMap<string, number>>(new Map());
  // Where the preview's sections stand, so the margin's cards stand beside them before the editor is drawn.
  const [previewTops, setPreviewTops] = useState<ReadonlyMap<string, number>>(new Map());
  // The margin needs room beside a full document column; narrower pages show bubbles instead (§4.4).
  const [articleWidth, setArticleWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const articleElement = useRef<HTMLElement | null>(null);
  const docColumn = useRef<HTMLDivElement | null>(null);
  // What part of the page is in view, so people out of it show at its edges (§3.2).
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const scrollFrame = useRef(0);
  const readViewport = useCallback(() => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const article = articleElement.current;
      if (article) startTransition(() => setViewport({ top: article.scrollTop, height: article.clientHeight }));
    });
  }, []);
  const measureArticle = useCallback((article: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    articleElement.current?.removeEventListener("scroll", readViewport);
    articleElement.current = article;
    if (!article) return;
    observer.current = new ResizeObserver(([entry]) => {
      setArticleWidth(entry?.contentRect.width ?? 0);
      readViewport();
    });
    observer.current.observe(article);
    article.addEventListener("scroll", readViewport, { passive: true });
  }, [readViewport]);
  const [headRevision, setHeadRevision] = useState<number | null>(null);
  // How far this person has read the page, kept by the Hub on every device of theirs (§3.1): the newest
  // revision they have seen whole, and the page as they have seen it when they saw only part of it past that.
  // History shows a dot when the page moved past it, as Google Docs does. `opened` is where it stood as the
  // page opened.
  const [seenRevision, setSeenRevision] = useState<number | null>(null);
  const [opened, setOpened] = useState<{ pageId: string; revision: number | null; seen: string | null } | null>(null);
  // What the page was when this reader last read it, for showing what changed since as a diff.
  const [readerBaseline, setReaderBaseline] = useState<string | null>(null);
  // How many changes that diff shows (null until known), and whether the reader has ticked it viewed.
  const [readerChanges, setReaderChanges] = useState<number | null>(null);
  const [diffViewed, setDiffViewed] = useState(false);
  // What of the page this reader has last told the Hub they have seen past `seenRevision`.
  const sentSeen = useRef<string | null>(null);
  useEffect(() => {
    setSeenRevision(null);
    setOpened(null);
    setReaderBaseline(null);
    setReaderChanges(null);
    setDiffViewed(false);
    if (!spaceId || !pageId || !token) return;
    const controller = new AbortController();
    // Unknown, nothing is marked read and nothing is shown as changed.
    pageApi.readState(spaceId, pageId, token, controller.signal).then(({ revision, seen = null }) => {
      setOpened({ pageId, revision, seen });
      setSeenRevision(revision);
      sentSeen.current = seen;
    }, () => undefined);
    return () => controller.abort();
  }, [spaceId, pageId, token]);
  const seen = useRef<number | null>(null);
  seen.current = seenRevision;
  /** The page read up to `revision`: seen whole, or as `seenBody` when only part of it was seen past that. */
  const markSeen = useCallback((revision: number, seenBody: string | null) => {
    if (!spaceId || !pageId || opened?.pageId !== pageId) return;
    // Seen in part, it stays read as far as it was seen whole.
    const at = seenBody === null ? Math.max(revision, seen.current ?? 0) : seen.current ?? revision;
    if (at === seen.current && seenBody === sentSeen.current) return;
    seen.current = at;
    sentSeen.current = seenBody;
    setSeenRevision(at);
    void pageApi.markRead(spaceId, pageId, token, at, seenBody).catch(() => undefined);
  }, [opened, pageId, spaceId, token]);
  // The GitHub files the page embeds are read through the Hub, as this reader (pages-live-document.md §6.5).
  const readGitHubFile = useCallback((href: string, signal: AbortSignal) =>
    pageApi.githubFile(spaceId!, pageId!, token, href, signal), [spaceId, pageId, token]);
  // Images and videos pasted into the page are the Space's private files, read and uploaded as this reader.
  const mediaUrl = useCallback((file: string) => spaceId && pageId ? pageApi.mediaUrl(spaceId, pageId, file) : undefined,
    [spaceId, pageId]);
  const uploadMedia = useCallback((file: File, onProgress: (percent: number) => void) =>
    pageApi.uploadMedia(spaceId!, pageId!, token, file, onProgress), [spaceId, pageId, token]);
  const unseen = headRevision !== null && seenRevision !== null && headRevision > seenRevision;
  const baselineFor = useRef<typeof opened>(null);
  useEffect(() => {
    if (!opened || opened.pageId !== pageId || headRevision === null || baselineFor.current === opened) return;
    baselineFor.current = opened;
    setReaderBaseline(null);
    // Seen in part, what changed is what the reader has not seen.
    if (opened.seen !== null) { setReaderBaseline(opened.seen); return; }
    // A first visit, or a page that has not moved, has nothing to show as changed.
    if (opened.revision === null || opened.revision >= headRevision || !spaceId) { setReaderChanges(0); return; }
    void pageApi.read(spaceId, opened.pageId, token, opened.revision).then((result) => {
      if (baselineFor.current === opened) setReaderBaseline(result.page.body);
    }, () => { if (baselineFor.current === opened) setReaderChanges(0); });
  }, [headRevision, opened, pageId, spaceId, token]);
  const reading = useRef<PageReading | null>(null);
  const viewDiff = () => {
    setDiffViewed(true);
    reading.current?.seeAll();
    if (headRevision !== null) markSeen(headRevision, null);
  };
  // Writing on the page, or calling an Agent to write it, is co-writing: what changes is seen as it happens,
  // in its writer's ink, so what changed while the reader was away is no longer marked over it. It is still
  // read only where it has been on their screen, so nothing says it was viewed.
  const coWriting = () => {
    if (!readerChanges || diffViewed) return;
    setDiffViewed(true);
    setReaderChanges(0);
  };
  // The page as the reader had seen it when it opened: what they see from then on is read (§3.1).
  const readFrom = readerBaseline !== null ? readerBaseline : readerChanges === 0 ? null : undefined;
  // What has been on the reader's screen a moment, while the tab is in front, is read as it is then: what an
  // Agent writes in view is read as it is written, and what it writes out of view is not.
  useEffect(() => {
    if (mode !== "page" || !drawn || headRevision === null || readFrom === undefined) return;
    let timer: number | undefined;
    const read = () => {
      window.clearTimeout(timer);
      if (window.document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        const area = articleElement.current?.getBoundingClientRect();
        const now = area && reading.current?.see({ top: Math.max(area.top, 0), bottom: Math.min(area.bottom, window.innerHeight) });
        if (now) markSeen(headRevision, now.whole ? null : now.body);
      }, READ_AFTER_MS);
    };
    read();
    window.document.addEventListener("visibilitychange", read);
    return () => { window.clearTimeout(timer); window.document.removeEventListener("visibilitychange", read); };
  }, [drawn, headRevision, markSeen, mode, readFrom, viewport]);
  const readerDiff = useMemo(() => readerBaseline === null || headRevision === null || diffViewed || !drawn ? null
    : { body: readerBaseline, head: headRevision }, [diffViewed, drawn, headRevision, readerBaseline]);
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const userName = user?.name || user?.email || "";
  useEffect(preloadPageChunks, []);
  // What a commit moves beside the page is read again once commits settle; the page's opening revision
  // is what it was read at, so the session reporting it reads nothing again.
  const refreshedAt = useRef<{ pageId: string | null; revision: number | null }>({ pageId: null, revision: null });
  useEffect(() => {
    const last = refreshedAt.current;
    refreshedAt.current = { pageId, revision: headRevision };
    if (!spaceId || !pageId || headRevision === null || last.pageId !== pageId || last.revision === null
      || last.revision === headRevision) return;
    const timer = window.setTimeout(() => void queryClient.invalidateQueries({ predicate: ({ queryKey }) =>
      PAGE_REVISION_QUERIES.some((name) => queryKey.includes(name)) && queryKey.includes(pageId) }), REVISION_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [headRevision, pageId, queryClient, spaceId]);

  // With no page named, the first top-level page opens, and the URL names it.
  useEffect(() => {
    if (pageId && pageId !== selectedPageId) onSelectPage(pageId);
  }, [onSelectPage, pageId, selectedPageId]);

  // Another page opens as itself, not in the previous page's history. The page a new page's first
  // write made is that same page going on: what is open on it stays open.
  const madeHere = useRef<string | null>(null);
  useEffect(() => {
    if (pageId !== null && pageId === madeHere.current) return;
    setMode("page");
    setDialog(null);
    setFocused(null);
  }, [pageId]);

  // A token renewal (hourly) must not rebuild the session: that would drop
  // the document and any edit the Hub has not received yet.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const hasToken = Boolean(token);
  useEffect(() => {
    if (token) session?.setToken(token);
  }, [session, token]);

  const make = useRef(creation.make);
  make.current = creation.make;
  const selectPage = useRef(onSelectPage);
  selectPage.current = onSelectPage;
  // The session of a new page its first write made: the page it became opens with this same session.
  const madeSession = useRef<PageLiveSession | null>(null);
  useEffect(() => {
    if (!spaceId || (!pageId && !pending) || !userId || !hasToken) return;
    const made = madeSession.current;
    madeSession.current = null;
    const kept = made && made.pageId === pageId ? made : null;
    if (made && !kept) made.destroy();
    // One session per page; it must not churn when the auth context re-renders.
    const live = kept ?? new PageLiveSession({ spaceId, pageId, token: tokenRef.current,
      user: { name: userName, color: pageAuthorColor({ kind: "user", id: userId }) },
      // A failed make says why on the page; a later write tries again.
      ...(pending ? { make: (document: Uint8Array) => make.current(document).catch((cause: unknown) => {
        setNotice(userErrorMessage(cause, "Couldn't create the page"));
        throw cause;
      }) } : {}) });
    if (!kept) {
      setSession(live);
      setNotice(null);
      // A new page has nothing to sync: it is this document until it is made.
      if (pending) { setSynced(true); setCanEdit(true); }
    }
    const off = live.on((event) => {
      if (event.type === "status") {
        setConnected(event.connected);
        connectedRef.current = event.connected;
        setSaveState((state) => (state === "offline" || state === "saving") && event.connected ? "saved"
          : state !== "idle" && !event.connected ? "offline" : state);
      }
      if (event.type === "local-edit") {
        // Until the page is made and its session first reached, an edit is on its way, not offline.
        setSaveState(connectedRef.current || live.underway ? "saving" : "offline");
        window.clearTimeout(saveTimer.current);
        // The edit is sent as it is made; the session keeps it as it arrives.
        saveTimer.current = window.setTimeout(() => setSaveState(connectedRef.current ? "saved"
          : live.underway ? "saving" : "offline"), 700);
      }
      if (event.type === "made") {
        setNotice(null);
        madeHere.current = event.pageId;
        if (event.seeded) madeSession.current = live;
        selectPage.current(event.pageId);
      }
      if (event.type === "synced") {
        setSynced(true);
        setNotice((current) => current === PAGE_SERVER_OUTDATED_NOTICE ? null : current);
      }
      if (event.type === "session") { setCanEdit(event.canEdit); setHeadRevision(event.headRevision); }
      if (event.type === "access") {
        if (event.canRead === false) setNotice("You no longer have access to this page.");
        if (typeof event.canEdit === "boolean") setCanEdit(event.canEdit);
      }
      if (event.type === "committed") {
        setHeadRevision(event.headRevision);
        // An Agent that just edited is on the page from now; its caret shows once its live Run is known.
        void queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes("page-tree-agents") });
        // Taking a reference out pauses its Automation; whoever is on the page hears it at once.
        const detached = event.detachedAutomations ?? [];
        if (detached.length) {
          setNotice(`${event.author ?? "An edit"} removed the reference to ${detached.map((automation) =>
            `“${automation.name}”`).join(", ")}, so ${detached.length === 1 ? "it is" : "they are"} paused. Put the reference back to resume.`);
        }
      }
      // A co-writing Agent's suggestion is laid over the page as it arrives.
      if (event.type === "suggestion") waitingRefetch.current();
      if (event.type === "error" && event.code === "page_body_too_large") setNotice("This page is over 256 KiB.");
      if (event.type === "error" && event.code === "credits_exhausted") {
        setNotice("This Space has used this month's Agent credits; an Agent's edit is saved once someone edits the page or credits return.");
      }
      if (event.type === "error" && event.code === "page_server_outdated") {
        setNotice(PAGE_SERVER_OUTDATED_NOTICE);
      }
    });
    return () => {
      off();
      if (madeSession.current === live) return;
      live.destroy(); setSession(null); setConnected(false); setSynced(false); setEditorReady(false);
      setSaveState("idle");
    };
  }, [spaceId, pageId, pending, hasToken, userId, userName, queryClient]);
  // Closed before the page it made opened: nothing keeps its session any more.
  useEffect(() => () => {
    const made = madeSession.current;
    madeSession.current = null;
    made?.destroy();
  }, []);

  // The editor reads the page's sections from its document as it changes. They count for its session only:
  // until the next page's editor reads them, the last page's first heading would put its name in the header.
  const [editorBlocks, setEditorBlocks] = useState<{ session: PageLiveSession; blocks: PageDocBlock[] } | null>(null);
  const blocks = useMemo(() => editorBlocks && editorBlocks.session === session ? editorBlocks.blocks : [],
    [editorBlocks, session]);
  const presence = usePresence(session);
  const links = useQuery({
    ...pageLinksQuery(userId, spaceId ?? "", pageId ?? "", token),
    enabled: Boolean(spaceId && pageId), refetchInterval: 30_000,
  });
  // Discussions this reader just started, shown where they are before the Hub has linked them.
  const [startedLinks, setStartedLinks] = useState<PageLink[]>([]);
  const linkList = useMemo(() => {
    const listed = links.data?.links ?? [];
    const started = startedLinks.filter((link) => link.pageId === pageId &&
      !listed.some((item) => item.conversationId === link.conversationId));
    return started.length ? [...listed, ...started] : listed;
  }, [links.data, pageId, startedLinks]);
  const listedConversations = useMemo<PageConversation[] | undefined>(() => {
    const listed = links.data?.conversations;
    if (!listed) return listed;
    const started = startedLinks.filter((link) => !listed.some((item) => item.conversationId === link.conversationId));
    return started.length ? [...listed, ...started.map((link) => ({ conversationId: link.conversationId, name: null,
      activityAt: link.createdAt, headSequence: 0, readSequence: 0, lastMessage: null, agents: [] }))] : listed;
  }, [links.data, startedLinks]);
  // The page's Automations, drawn as chips where the text references them (pages-live-document.md §6).
  const automations = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-automations", [spaceId, pageId]),
    enabled: Boolean(spaceId && pageId), refetchInterval: () => refetchUnlessHumanPush(30_000),
    queryFn: ({ signal }) => pageApi.automations(spaceId!, pageId!, token, signal).then((result) => result.automations),
  });
  const automationsById = useMemo(() => new Map((automations.data ?? []).map((item) => [item.id, item])),
    [automations.data]);
  // A message or an Agent in one of the page's conversations brings its card up to date.
  const linkedKey = [...new Set(linkList.map((link) => link.conversationId))].sort().join(",");
  const refetchLinks = links.refetch;
  useEffect(() => {
    const linked = new Set(linkedKey.split(",").filter(Boolean));
    let timer: number | undefined;
    const changed = (event: Event) => {
      const channelId = (event as CustomEvent<{ channelId?: string }>).detail?.channelId;
      if (!channelId || !linked.has(channelId)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refetchLinks(), 800);
    };
    window.addEventListener("xmatrix:channel-catalog-change", changed);
    return () => { window.removeEventListener("xmatrix:channel-catalog-change", changed); window.clearTimeout(timer); };
  }, [linkedKey, refetchLinks]);
  // Back from a conversation beside the page, what the page's conversations say may have moved on.
  const wasBeside = useRef(activeConversationId);
  useEffect(() => {
    if (wasBeside.current && !activeConversationId) void refetchLinks();
    wasBeside.current = activeConversationId;
  }, [activeConversationId, refetchLinks]);
  const liveConversation = useCallback((conversationId: string): LiveConversation | null => {
    const channel = conversation(conversationId);
    if (!channel) return null;
    const last = channel.lastMessage;
    return {
      name: channel.name ?? null,
      lastMessage: last ? { from: { kind: last.from.kind === "agent" || last.from.kind === "app" ? last.from.kind : "user",
        label: last.from.label, ...(last.from.avatarUrl ? { avatarUrl: last.from.avatarUrl } : {}) },
        bodyPreview: last.bodyPreview, sentAt: last.sentAt } : null,
      agents: liveAgents(channel),
      ...(channel.historyHeadSequence !== undefined ? { headSequence: channel.historyHeadSequence } : {}),
      ...(channel.readSequence !== undefined ? { readSequence: channel.readSequence } : {}),
    };
  }, [conversation]);
  const conversations = useMemo(() => marginConversations({ links: linkList, conversations: listedConversations,
    live: liveConversation, now: Date.now() }), [linkList, listedConversations, liveConversation]);
  const conversationName = useCallback((conversationId: string) =>
    conversations.find((item) => item.conversationId === conversationId)?.name ?? conversation(conversationId)?.name ?? null,
  [conversation, conversations]);
  // `page:<id>` and `channel:<id>` in the text read as the names this reader's lists give them.
  // They are drawn again only when the page list changes; the rest is read when a chip is drawn or clicked.
  const referenceActions = useRef({ conversation, onOpenConversation, onOpenSection });
  referenceActions.current = { conversation, onOpenConversation, onOpenSection };
  const references = useMemo<PageReferenceTargets>(() => ({
    pageTitle: (id) => tree.data?.find((item) => item.pageId === id)?.title ?? null,
    channelName: (id) => referenceActions.current.conversation(id)?.name ?? null,
    openPage: (id, blockId) => referenceActions.current.onOpenSection(id, blockId),
    openChannel: (id) => referenceActions.current.onOpenConversation(id),
  }), [tree.data]);
  // Open discussions anchored in the text, highlighted there (pages-live-document.md §4.3).
  const discussions = useMemo<Discussion[]>(() => linkList.filter((link) => link.anchor && !link.resolvedAt)
    .map((link) => ({ linkId: link.linkId, conversationId: link.conversationId, from: link.anchor!.from,
      to: link.anchor!.to, name: conversationName(link.conversationId) ?? link.anchor!.quote })),
  [conversationName, linkList]);

  // When each section last changed, and by whom where; refreshed as revisions land.
  const awareness = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-awareness", [spaceId, pageId]),
    enabled: Boolean(spaceId && pageId && token), refetchInterval: 30_000,
    queryFn: ({ signal }) => pageApi.awareness(spaceId!, pageId!, token, signal),
  });
  // Who changed the page last and when, said by History's button as Google Docs says it by its clock.
  const lastEdit = useMemo(() => {
    const latest = (awareness.data?.blocks ?? []).map((block) => block.updated)
      .filter((updated) => updated !== null)
      .sort((a, b) => b.revision - a.revision)[0];
    if (!latest) return null;
    const who = latest.authors.map(pageAuthorLabel).join(", ");
    const when = formatRelativeAge(latest.createdAt) ?? new Date(latest.createdAt).toLocaleString();
    return who ? `Last edit by ${who} · ${when}` : `Last edit ${when}`;
  }, [awareness.data]);
  const [follow, setFollow] = useState<{ blockId: string; seq: number } | null>(null);
  const followBlock = (blockId: string) => setFollow((current) => ({ blockId, seq: (current?.seq ?? 0) + 1 }));
  // Once the opened page's document has the referenced section, bring it into view once.
  const focusedSectionSeq = useRef<number | null>(null);
  useEffect(() => {
    if (!focusSection || focusSection.pageId !== pageId || focusedSectionSeq.current === focusSection.seq) return;
    if (!blocks.some((block) => block.id === focusSection.blockId)) return;
    focusedSectionSeq.current = focusSection.seq;
    setFollow((current) => ({ blockId: focusSection.blockId, seq: (current?.seq ?? 0) + 1 }));
  }, [focusSection, pageId, blocks]);

  // The Agents whose live Run read or edited the page stay on it while that Run lives, as in
  // the tree; a live session only shows an Agent at the moment it reads or edits (§3.2).
  const pageAgents = usePageAgents(spaceId, token);
  const liveOnPage = useMemo(() => pageAgents.data?.agents.get(pageId ?? "") ?? [], [pageAgents.data, pageId]);
  // Who this person can call to write the page with them, and the one they last called.
  const writers = usePageWriters(spaceId, token, Boolean(page) && canEdit);
  // An empty page someone is co-writing asks for its first line, naming who writes the next.
  const onboardingCopy = useOnboardingCopy(spaceId, token, userId ?? undefined);
  // What Agents co-writing the page suggest (§4.2), laid over it change by change.
  const waiting = usePageSuggestions(spaceId, pageId, token, Boolean(page));
  const [suggesting, setSuggesting] = useState<SuggestionsReport>({ count: 0, current: 0, author: null, through: 0 });
  waitingRefetch.current = waiting.refetch;
  const suggestionControl = useRef<SuggestionControl | null>(null);
  const reviewed = useRef(0);
  // Once every change of the suggestions on screen is taken or left, they stop waiting on the page.
  useEffect(() => {
    if (!spaceId || !pageId || !canEdit || waiting.through === 0 || suggesting.through !== waiting.through
      || suggesting.count > 0 || reviewed.current >= waiting.through) return;
    reviewed.current = waiting.through;
    void pageApi.reviewSuggestions(spaceId, pageId, token, waiting.through).then(waiting.refetch,
      (cause: Error) => setNotice(cause.message));
  }, [canEdit, pageId, spaceId, suggesting, token, waiting]);
  // The selection is acknowledged before any network request, including making an empty page.
  const startingWriter = useRef(false);
  const [starting, setStarting] = useState<{ pageId: string; harness: string } | null>(null);
  // An Agent just called, from the moment it is asked until it shows on the page.
  const [called, setCalled] = useState<{ pageId: string; harness: string; conversationId: string; blockId: string | null;
    at: number } | null>(null);
  // It is on the page once its conversation's Run is: from then on it shows as itself. One that never
  // arrives stops showing as called after a while; its conversation says why.
  useEffect(() => {
    if (!called) return;
    if (liveOnPage.some((agent) => agent.conversationId === called.conversationId)) { setCalled(null); return; }
    const timer = window.setTimeout(() => setCalled(null), Math.max(0, called.at + CALLED_SHOWS_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [called, liveOnPage]);
  const staying = useMemo(() => liveOnPage.filter((agent) =>
    !presence.some(({ state }) => liveRunOf(state, [agent]))), [liveOnPage, presence]);
  // An Agent's caret rests at its last edit while its Run lives, dimmed while the Run is not working;
  // a person's dims after ten minutes in a hidden tab, as in Google Docs.
  const cursorPresence = useCallback<CursorPresence>((state) => {
    const present = state as PagePresenceState;
    if (present.user?.kind !== "agent") return present.idle ? "idle" : "active";
    const run = liveRunOf(present, liveOnPage);
    return !run ? null : run.status === "busy" ? "active" : "idle";
  }, [liveOnPage]);
  // An Agent writing through its caret shows the face of the Run it writes from.
  const cursorAvatar = useCallback((state: object) => {
    const present = state as PagePresenceState;
    return present.user?.kind === "agent" ? liveRunOf(present, liveOnPage)?.avatarUrl : undefined;
  }, [liveOnPage]);
  const present = useMemo(() => presence.filter(({ state }) => cursorPresence(state) !== null),
    [cursorPresence, presence]);
  // Ticks each second only while an Agent on the page is thinking, so its time shows.
  const anyoneThinking = present.some(({ state }) => state.user?.kind === "agent" && state.activity === "thinking");
  const clock = useTicking(anyoneThinking);
  // An Agent on the page is its face at the right edge, beside its line (§3.2): the conversations
  // they work from, whose Agents a section's heading does not draw again.
  const atEdge = useMemo(() => [...new Set([
    ...present.flatMap(({ state }) => state.user?.kind === "agent" && state.user.conversationId ? [state.user.conversationId] : []),
    ...staying.map((agent) => agent.conversationId),
  ])].sort().join("\n"), [present, staying]);

  const sections = useMemo(() => {
    const notes = new Map<string, SectionNote>();
    const note = (blockId: string) => {
      const existing = notes.get(blockId) ?? {};
      notes.set(blockId, existing);
      return existing;
    };
    const named = (conversationId: string | null | undefined) => {
      const name = conversationId ? conversationName(conversationId) : null;
      // A conversation the reader cannot open is not named (pages-live-document.md §3).
      return conversationId && name ? { id: conversationId, name } : null;
    };
    for (const block of awareness.data?.blocks ?? []) {
      if (block.owed) {
        const { reason, at, holder, pullRequestUrl } = block.owed;
        const what = reason === "merged" ? `${pullRequestUrl?.replace(/^https:\/\/github\.com\//u, "") ?? "Its pull request"} merged`
          : reason === "released" ? `${holder} released the claim` : `${holder}'s claim lapsed`;
        note(block.blockId).owed = { text: `Update owed · ${what} ${formatRelativeAge(at) ?? at}`,
          conversation: named(block.owed.conversationId) };
      }
    }
    // The Agents working in each section's conversations, on the page or not (§3.2).
    const edge = new Set(atEdge.split("\n"));
    for (const item of conversations) {
      if (item.agents.length === 0 || edge.has(item.conversationId)) continue;
      const working = note(item.blockId).working ??= [];
      for (const agent of item.agents) {
        working.push({ name: agent.name, busy: agent.status === "busy", avatarUrl: agent.avatarUrl,
          conversation: { id: item.conversationId, name: item.name } });
      }
    }
    for (const [blockId, count] of sectionConversationCounts(conversations)) note(blockId).conversations = count;
    return notes;
  }, [atEdge, awareness.data, conversationName, conversations]);

  const document = useQuery({
    ...pageDocumentQuery(user?.id ?? null, spaceId ?? "", pageId ?? "", token),
    enabled: Boolean(spaceId && pageId && token),
  });

  const togglePublished = async () => {
    if (!spaceId || !page) return;
    try {
      await pageApi.publish(spaceId, page.pageId, token, !page.publishedAt);
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes("page-tree") });
    } catch (cause) {
      setNotice(userErrorMessage(cause, "Couldn't change who can read this page"));
    }
  };
  const publicUrl = spaceId && page ? `/p/${encodeURIComponent(spaceId)}/${encodeURIComponent(page.pageId)}` : null;

  // The page that states the project's rules only owners and admins edit (open-project-governance.md §4).
  const toggleRulesPage = async () => {
    if (!spaceId || !page) return;
    try {
      await pageApi.setGovernance(spaceId, token, { governancePageId: page.governance ? null : page.pageId });
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes("page-tree") });
    } catch (cause) {
      setNotice(userErrorMessage(cause, "Couldn't change who edits this page"));
    }
  };

  // A new page opens on its title, the first line of its document, as in Notion.
  const [writeOn, setWriteOn] = useState(0);
  useEffect(() => {
    if (pending && editorReady) setWriteOn((seq) => seq + 1);
  }, [pending, editorReady]);

  // A page's name is the top-level heading its document opens with (pages-live-document.md §4.1).
  const opening = openingHeading(blocks, document.data?.body);
  // The tree catches up with a rename the heading made.
  const renamedInDocument = Boolean(page && opening !== null && opening !== page.title.trim());
  useEffect(() => {
    if (renamedInDocument) void queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes("page-tree") });
  }, [headRevision, queryClient, renamedInDocument]);

  const toggleSuggestOnly = async () => {
    if (!spaceId || !page) return;
    await pageApi.update(spaceId, page.pageId, token, { agentSuggestOnly: !page.agentSuggestOnly });
    await queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes("page-tree") });
  };

  const marginOn = !phone && mode === "page" && articleWidth >= MARGIN_ROOM_PX;
  const openInMargin = Boolean(activeConversationId) && marginOn;
  const docked = Boolean(activeConversationId) && !phone && !openInMargin;
  useEffect(() => {
    onConversationDockChange?.(Boolean(spaceId && page && docked));
    return () => onConversationDockChange?.(false);
  }, [spaceId, page, docked, onConversationDockChange]);

  const coWriter = called && called.pageId === page?.pageId ? called.harness : liveOnPage[0]?.name;
  // Who writes instead of a co-writer that went quiet: the fastest other one this person can call.
  const switchWriter = (name: string): string | undefined => {
    const quiet = name.split(":")[0];
    return ["claude", "codex", ...writers.agents.map((agent) => agent.harness)]
      .find((harness) => harness !== quiet && writers.agents.some((agent) => agent.harness === harness));
  };
  // A page made to be co-written at once calls its Agent as it opens (co-write-request.ts).
  const coWriteRef = useRef<((harness: string, blockId: string | null, mentioned?: boolean) => Promise<void>) | null>(null);
  // Typing `[[`, `#` and `@` on the page completes as it does in the composer; an `@` calls the Agent to the page.
  const referenceCatalog = useMessageReferenceCatalog();
  const completion = useMemo<PageCompletion | undefined>(() => spaceId ? {
    spaceId, pages: tree.data ?? [], channels: referenceCatalog?.channels ?? [], agents: writers.agents,
    readPage: (id) => queryClient.fetchQuery(pageDocumentQuery(userId ?? null, spaceId, id, token)),
    summonAgent: (harness, blockId) => void coWriteRef.current?.(harness, blockId || null, true),
  } : undefined, [queryClient, referenceCatalog?.channels, spaceId, token, tree.data, userId, writers.agents]);
  useEffect(() => {
    if (!page || !canEdit || !coWriteRef.current) return;
    const harness = takeCoWriteRequest(page.pageId);
    if (harness) void coWriteRef.current(harness, null);
    // Once per page opened, not on every change to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.pageId, canEdit]);

  if (!spaceId) return <div className="p-6 text-sm text-muted-foreground">Choose a Space to see its pages.</div>;
  if (canMigrate && tree.data && (!page || reviewing === spaceId)) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageMigrationReview key={spaceId} spaceId={spaceId} token={token}
          onApplying={() => setReviewing(spaceId)} onDone={() => setReviewing(null)} />
      </div>
    );
  }
  if (tree.data && !page) {
    return (
      <div className="relative flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Pages describe how things stand. Create the first one from the Pages sidebar.
      </div>
    );
  }
  // A new page is as restricted as where it goes.
  const restricted = page ? effectivelyRestricted(pending ? page.parentPageId ?? "" : page.pageId, pages) : false;
  const pageLink = () => `${window.location.origin}${
    pagesViewPath(`/app/${encodeURIComponent(spaceId)}/pages`, page?.pageId ?? null, null)}`;
  // The link a pull request names for the block it works on.
  const blockLink = (blockId: string) => `${pageLink()}#${blockId}`;
  // A discussion is where people and Agents meet alike: asking an Agent is mentioning it there.
  const discuss: NonNullable<PageSectionActions["discuss"]> = (blockId, anchor) => startDiscussion(blockId, anchor);
  // A comment on a passage: the discussion of the passage, started with the comment; the page stays in front of
  // the reader, the discussion a card beside the passage. It names nobody: an Agent the comment mentions takes it,
  // else xMatrix gives it to one (`@auto`).
  const comment: NonNullable<PageSectionActions["comment"]> = (blockId, anchor, text) =>
    startDiscussion(blockId, anchor, { body: commentBody(text, writers.agents.map((agent) => agent.harness)) });
  const startDiscussion = (blockId: string, anchor?: Parameters<NonNullable<PageSectionActions["discuss"]>>[1],
    said?: { body: string }) => {
    if (!page) return;
    const title = blocks.find((block) => block.id === blockId)?.title;
    // A discussion of a passage is named by the passage, which its first message carries; of a section, by the section.
    const place = title ? `${page.title} › ${title}` : page.title;
    let started: string | null = null;
    const planned = (conversationId: string) => {
      started = conversationId;
      const now = new Date().toISOString();
      setStartedLinks((current) => [...current, { linkId: `started:${conversationId}`, conversationId,
        pageId: page.pageId, blockId, source: "manual", createdAt: now, lastSeenAt: now, anchor: anchor ?? null }]);
    };
    const quote = anchor ? discussionQuote(anchor.quote, { label: place, href: blockLink(blockId) }, true) : undefined;
    void onDiscuss({ spaceId, pageId: page.pageId, blockId, name: anchor ? discussionTitle(anchor.quote) : place,
      restricted, planned, ...(anchor ? { anchor } : {}),
      ...(said ? { firstMessage: quote ? quotedMessage(quote, { body: said.body, selections: [] }).body : said.body,
        open: false } : quote ? { quote } : {}) })
      .then(() => links.refetch(), (cause: Error) => setNotice(cause.message))
      .finally(() => setStartedLinks((current) => current.filter((link) => link.conversationId !== started)));
  };
  const resolveDiscussion = (linkId: string) => pageApi.resolveLink(spaceId, token, linkId, true)
    .then(() => links.refetch(), (cause: Error) => setNotice(cause.message));
  const copy = (text: string) => void navigator.clipboard.writeText(text)
    .then(() => setNotice("Link copied."), (cause: Error) => setNotice(cause.message));
  const copyLink = (blockId: string) => copy(blockLink(blockId));
  // Co-writing with an Agent: a conversation of its own, linked to the page or a section, whose first
  // message calls the chosen runtime to infer what the page needs and write it. The page stays open,
  // and the Agent shows at the right edge beside the line it writes.
  // An `@` in the page's text calls the Agent the same way, but its message is only the mention and where it
  // was made: the page tells it nothing of what to write.
  const coWrite = async (harness: string, blockId: string | null, mentioned = false) => {
    if (!page || startingWriter.current) return;
    coWriting();
    startingWriter.current = true;
    setStarting({ pageId: page.pageId, harness });
    setNotice(null);
    const section = blockId ? blocks.find((block) => block.id === blockId)?.title ?? null : null;
    try {
      writers.choose(harness);
      // Calling an Agent to write a new page is writing on it: it makes the page.
      const writing = pending && session ? await session.make() : page.pageId;
      setStarting({ pageId: writing, harness });
      const where = `page:${writing}${blockId ? ` (section #${blockId})` : ""}`;
      // The page itself tells the Agent what it needs, live, as turns its runtime hands it (§4.2).
      const firstMessage = mentioned ? `@${harness} launch:force ${pageReferenceToken(writing, blockId)}`
        : `@${harness} launch:force You're co-writing ${where} with me live. The page sends you ` +
          "what changed as I write, and you answer there, in the page; nothing to do here until it does.";
      const conversationId = await onDiscuss({ spaceId, pageId: writing, blockId: blockId ?? "", restricted,
        name: `Co-writing ${section ? `${page.title} › ${section}` : page.title}`, firstMessage, open: false,
        coWrite: true });
      if (typeof conversationId === "string") {
        setCalled({ pageId: writing, harness, conversationId, blockId, at: Date.now() });
      }
      void links.refetch();
    } catch (cause) {
      setNotice(userErrorMessage(cause, "Couldn't start the Agent"));
    } finally {
      startingWriter.current = false;
      setStarting(null);
    }
  };
  coWriteRef.current = coWrite;
  const openHistory = () => {
    reading.current?.seeAll();
    if (headRevision !== null) markSeen(headRevision, null);
    setMode("history");
  };
  // What selecting text offers, for the section the selection is in.
  const sectionActions: PageSectionActions = { discuss, comment };
  // What a heading offers, beside it (§3.2).
  const headingActions: HeadingActions = {
    canEdit,
    discuss: (blockId) => discuss(blockId),
    copyLink,
    attach: (blockId: string) => setDialog({ kind: "attach", blockId }),
    showConversations: (blockId) => setDialog({ kind: "conversations", blockId }),
    phone,
    ...(writers.favourite ? { write: { label: `Co-write with ${writers.favourite}`,
      run: (blockId: string) => void coWrite(writers.favourite!, blockId) } } : {}),
  };
  const whereDetail = (activity: string, blockId: string, conversationId: string | null | undefined) => {
    const section = blocks.find((block) => block.id === blockId)?.title;
    const where = conversationId ? conversationName(conversationId) : null;
    return [activity, section, where ? `in ${where}` : null].filter(Boolean).join(" · ");
  };
  const sectionAnchor = (blockId: string) => blockId ? `block:${blockId}` : "page";
  // A co-writer that thinks says for how long, and one that went quiet says so (§3.2).
  const coWriterDoing = (state: { activity?: string; since?: unknown; stalled?: unknown }) => {
    if (state.stalled === true) return onboardingCopy.coWrite.quiet;
    if (state.activity === "thinking" && typeof state.since === "number") {
      return onboardingCopy.coWrite.thinkingFor(Math.max(0, Math.round((clock - state.since) / 1000)));
    }
    return CO_WRITER_DOING[state.activity ?? ""]!;
  };
  const people: PresentPerson[] = [
    ...present.map(({ clientId, state }) => ({ key: `client:${clientId}`, name: state.user!.name,
      color: state.user!.color, agent: state.user!.kind === "agent", blockId: state.block ?? "",
      avatarUrl: cursorAvatar(state),
      idle: cursorPresence(state) === "idle",
      // Placed by their caret where they have one, so the edge hints point at the line.
      anchor: anchorTops.has(`client:${clientId}`) ? `client:${clientId}` : sectionAnchor(state.block ?? ""),
      editing: state.activity === "editing" || state.activity === "writing" || state.activity === "thinking",
      conversationId: state.user!.conversationId ?? null,
      // While it writes, its face says which conversation the words come from.
      ...(state.user!.kind === "agent" && state.activity === "writing" && state.user!.conversationId
        && conversationName(state.user!.conversationId) ? { from: conversationName(state.user!.conversationId)! } : {}),
      ...(state.user!.kind === "agent" && (CO_WRITER_DOING[state.activity ?? ""] || state.stalled === true)
        ? { doing: coWriterDoing(state) } : {}),
      ...(state.user!.kind === "agent" && state.activity === "thinking" ? { thinking: true,
        ...(typeof state.since === "number" ? { brief: briefDuration(clock - state.since) } : {}) } : {}),
      ...(state.user!.kind === "agent" && state.stalled === true ? { stalled: true } : {}),
      undoable: state.user!.kind === "agent" && state.undo === true,
      // An Agent co-writing live says what it is doing, and its note to the people on the page.
      detail: [whereDetail(state.user!.kind === "agent" && (CO_WRITER_DOING[state.activity ?? ""] || state.stalled === true)
        ? coWriterDoing(state)
        : CO_WRITER_DOING[state.activity ?? ""] ?? state.activity ?? "viewing", state.block ?? "",
        state.user!.conversationId), state.say].filter(Boolean).join(" — ") })),
    ...staying.map((agent) => ({ key: `agent:${agent.instanceId}:${agent.conversationId}`, name: agent.name,
      color: pageAuthorColor({ kind: "agent", id: agent.instanceId }), agent: true, avatarUrl: agent.avatarUrl, blockId: agent.blockId,
      idle: agent.status !== "busy",
      anchor: sectionAnchor(agent.blockId), editing: agent.status === "busy", conversationId: agent.conversationId,
      detail: whereDetail(agent.status === "busy" ? `${agent.activity}, working` : agent.activity, agent.blockId,
        agent.conversationId) })),
  ];
  // Beside the document on a wide screen, as comments are in Google Docs; the open conversation
  // expands in place there, and docks beside the page only when the margin has no room for it (§4.4).
  const marginCards = withOpenConversation(conversations, openInMargin ? activeConversationId : null,
    activeConversationId ? conversation(activeConversationId)?.name ?? null : null);
  const liveCount = conversations.filter((item) => item.live).length;
  // What runs on the page, and how people change it (§6).
  const attachedProps = page ? {
    automations: automations.data ?? [], canEdit,
    onSchedule: (input: PageScheduleInput) => pageApi.createAutomation(spaceId, page.pageId, token, input)
      .then(() => { void automations.refetch(); void links.refetch(); }),
    onPutBack: (automation: SerializedAutomation, blockId: string) =>
      pageApi.changeAutomation(spaceId, page.pageId, token, automation, "reference", blockId)
        .then(() => void automations.refetch()),
    ...(onConnectGitHub ? { onConnectGitHub: (input: { blockId: string; repository: string }) =>
      onConnectGitHub({ spaceId, pageId: page.pageId, restricted, ...input }).then(() => void links.refetch()) } : {}),
  } : null;
  const openConversation = (conversationId: string) => {
    setDialog(null);
    onOpenConversation(conversationId);
  };
  const attachSection = dialog && typeof dialog === "object" && dialog.kind === "attach" ? dialog.blockId : null;
  // Where an anchor is in the article's scrolled content, or null before the page is laid out.
  const contentTop = (anchor: string): number | null => {
    const article = articleElement.current;
    const column = docColumn.current;
    const top = anchorTops.get(anchor);
    if (!article || !column || top === undefined) return null;
    return column.getBoundingClientRect().top - article.getBoundingClientRect().top + article.scrollTop + top;
  };
  const jumpTo = (person: PresentPerson) => {
    const top = contentTop(person.anchor);
    const article = articleElement.current;
    if (top === null || !article) return followBlock(person.blockId);
    article.scrollTo({ top: Math.max(0, top - article.clientHeight / 3), behavior: "smooth" });
  };
  // Who is out of view above or below, at the page's edges (§3.2). A line of room keeps
  // someone on the very edge counted as seen.
  const bottomRoom = phone ? PEN_BOTTOM_ROOM : DESKTOP_PEN_BOTTOM_ROOM;
  // Whose suggestion is in front of the reader: its face, and what to do with the change, stand beside
  // the change at the right edge, as if the Agent were writing that line.
  const suggestedBy = suggesting.count > 0 && suggesting.author ? suggesting.author : null;
  const suggesterAvatar = suggestedBy ? agentPresetAvatarUrl(normalizeAgentPresetRuntime(suggestedBy.split(":")[0])) : undefined;
  const suggestionMark = ((): { top: number; away: "above" | "below" | null } | null => {
    const top = anchorTops.get("suggestion");
    const at = contentTop("suggestion");
    if (!suggestedBy || !drawn || mode !== "page" || top === undefined || at === null) return null;
    return { top: top - 4, away: !viewport.height ? null
      : at < viewport.top ? "above" : at > viewport.top + viewport.height - bottomRoom ? "below" : null };
  })();
  // Each Agent on the page is its face in the margin beside its line (§3.2), on a phone and a desktop alike.
  const pens = ((): PagePen[] => {
    if (mode !== "page" || !drawn) return [];
    return people.filter((person) => person.agent).flatMap((person) => {
      const top = anchorTops.get(person.anchor);
      const at = contentTop(person.anchor);
      if (top === undefined || at === null) return [];
      const away = !viewport.height ? null
        : at < viewport.top ? "above" : at > viewport.top + viewport.height - bottomRoom ? "below" : null;
      return [{ person, top: top + 2, away }];
    });
  })();
  // With a margin beside the page, each Agent at work stands in it, beside the line it writes, its channel under
  // it, and the cards make room (§4.4); an idle one leaves it, and its channel is a card again. Without one, each
  // Agent on the page is its face at the right edge (§3.2).
  const writersInMargin = marginOn && (drawn || openInMargin);
  const marginWriters: MarginWriter[] = writersInMargin ? pens.filter((pen) => !pen.person.idle).map(({ person }) => ({
    key: person.key, person, anchor: person.anchor,
    conversation: marginCards.find((card) => card.conversationId === person.conversationId) ?? null,
    channel: person.conversationId ? conversationName(person.conversationId) : null,
  })) : [];
  const edgePens = writersInMargin ? [] : pens;
  const penned = new Set(edgePens.map((pen) => pen.person.key));
  // Room beside the text column for a face to carry its name: from the column's edge to the article's.
  const penRoom = ((): number => {
    const article = articleElement.current;
    const column = docColumn.current;
    if (phone || !article || !column) return 0;
    return article.getBoundingClientRect().right - column.getBoundingClientRect().right;
  })();
  // The page's button: the face of the Agent the reader co-writes with, while no Agent is on the page;
  // an Agent just called shows there, starting, until it is on the page beside its line.
  const caller = ((): { agent: { name: string; avatarUrl?: string }; starting: boolean } | null => {
    if (!phone || mode !== "page" || !drawn || !canEdit || people.some((person) => person.agent && !person.idle)) return null;
    if (called && called.pageId === pageId) {
      const avatarUrl = writers.agents.find((agent) => agent.harness === called.harness)?.avatarUrl;
      return { agent: { name: called.harness, ...(avatarUrl ? { avatarUrl } : {}) }, starting: true };
    }
    const favourite = writers.agents[0];
    return favourite ? { agent: { name: favourite.harness, ...(favourite.avatarUrl ? { avatarUrl: favourite.avatarUrl } : {}) },
      starting: false } : null;
  })();
  const tapped = dialog && typeof dialog === "object" && dialog.kind === "agent"
    ? people.find((person) => person.key === dialog.key) ?? null : null;
  // What may be done to an Agent at work on the page, from its face or its pill: end its co-writing, take back
  // its last change while nobody changed it since, or, once it went quiet, have another Agent write instead.
  const agentControls = (person: PresentPerson) => {
    const conversationId = person.conversationId;
    const instead = person.stalled ? switchWriter(person.name) : undefined;
    return {
      stop: page && conversationId && canEdit ? () => {
        setDialog(null);
        void pageApi.endCoWriting(spaceId ?? "", page.pageId, token, conversationId)
          .catch((cause: unknown) => setNotice(userErrorMessage(cause, "Couldn't stop the Agent")));
      } : null,
      undo: page && conversationId && person.undoable && canEdit ? () => {
        setDialog(null);
        void pageApi.undoCoWriting(spaceId ?? "", page.pageId, token, conversationId)
          .then(({ outcome }) => {
            if (outcome === "changed") setNotice("Someone changed it since, so it stays");
          })
          .catch((cause: unknown) => setNotice(userErrorMessage(cause, "Couldn't undo the Agent's change")));
      } : null,
      switchTo: page && instead ? { label: onboardingCopy.coWrite.switchTo(instead), run: () => {
        setDialog(null);
        if (conversationId && canEdit) void pageApi.endCoWriting(spaceId ?? "", page.pageId, token, conversationId).catch(() => {});
        void coWrite(instead, null);
      } } : null,
    };
  };
  const tappedControls = tapped ? agentControls(tapped) : null;
  const offscreen = ((): { above: OffscreenPerson[]; below: OffscreenPerson[] } => {
    const above: OffscreenPerson[] = [];
    const below: OffscreenPerson[] = [];
    if (mode !== "page" || !drawn || !viewport.height) return { above, below };
    for (const person of people) {
      if (penned.has(person.key)) continue;
      const top = contentTop(person.anchor);
      if (top === null) continue;
      if (top < viewport.top + 8) above.push({ person, distance: viewport.top - top });
      else if (top > viewport.top + viewport.height - 24) below.push({ person, distance: top - viewport.top - viewport.height });
    }
    return { above, below };
  })();
  // Where others are, where discussions are and what owes an update, along the scrollbar (§3.2).
  const scrollMarks = ((): PageScrollMark[] => {
    const article = articleElement.current;
    const column = docColumn.current;
    if (!article || !column || mode !== "page" || !drawn) return [];
    const height = article.scrollHeight || 1;
    const base = column.getBoundingClientRect().top - article.getBoundingClientRect().top + article.scrollTop;
    const at = (anchor: string) => {
      const top = anchorTops.get(anchor);
      return top === undefined ? null : (base + top) / height;
    };
    const marks: PageScrollMark[] = [];
    const push = (mark: Omit<PageScrollMark, "fraction">, anchor: string) => {
      const fraction = at(anchor);
      if (fraction !== null) marks.push({ ...mark, fraction });
    };
    for (const person of people) {
      push({ key: `person:${person.key}`, kind: "person", color: person.color,
        title: `${person.name} · ${person.detail}` }, person.anchor);
    }
    for (const item of discussions) push({ key: `discussion:${item.linkId}`, kind: "discussion", title: item.name },
      `text:${item.linkId}`);
    for (const block of awareness.data?.blocks ?? []) {
      if (block.owed) push({ key: `owed:${block.blockId}`, kind: "owed", title: "Update owed" },
        block.blockId ? `block:${block.blockId}` : "page");
    }
    return marks;
  })();
  const listSection = dialog && typeof dialog === "object" && dialog.kind === "conversations" ? dialog : null;

  const hasChildren = pages.some((item) => item.parentPageId === pageId);
  const removePage = async () => {
    if (!spaceId || !page) return;
    await pageApi.remove(spaceId, page.pageId, token);
    queryClient.setQueryData<PageSummary[]>(xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-tree", [spaceId]), (current) =>
      current?.filter((item) => item.pageId !== page.pageId));
    setDialog(null);
    onPageDeleted();
    await queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes("page-tree") });
  };

  // On a phone the diff is walked from a floating bar under the thumb instead of a line above the text.
  const phoneDiff = phone && mode === "page" && drawn && !diffViewed && !!readerChanges;
  const writerStarting = starting?.pageId === page?.pageId ? starting : null;
  const writerCalled = called?.pageId === page?.pageId ? called : null;
  const writerFeedback = writerStarting ?? (!phone ? writerCalled : null);
  const controls = (
    <>
      {/* On a phone an Agent is its face in the margin and on the page's button; the stack names the people. */}
      <PresenceStack people={phone ? people.filter((person) => !person.agent) : people} onFollow={jumpTo} />
      {!phone && canEdit && writers.agents[0] && (
        <Button variant="ghost" size="sm" disabled={Boolean(starting)} onClick={() => setDialog({ kind: "write" })}
          title={`Co-write with ${writers.agents[0].harness}`}>
          <IdentityAvatar kind="agent" label={writers.agents[0].harness} imageUrl={writers.agents[0].avatarUrl} size="xs"
            shape="circle" glass={false} className="pointer-events-none rounded-full" />
          Co-write
        </Button>
      )}
      {/* What only a made page has: its conversations, history and sharing. A new page gets them on its first write. */}
      {!pending && (
        <>
          <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "conversations", blockId: null })}
            title="Conversations about this page" aria-label={`${conversations.length} conversations about this page`}>
            <MessageSquare /> {liveCount || conversations.length || ""}
          </Button>
          <Button variant="ghost" size="sm" aria-pressed={mode === "history"} title={lastEdit ?? "Version history"}
            aria-label={`Version history${unseen ? ", changed since you last looked" : ""}`}
            onClick={() => (mode === "history" ? setMode("page") : openHistory())} className="relative">
            <History /> History
            {unseen && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" data-testid="page-history-new" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDialog("share")}>
            <Share2 /> Share
          </Button>
          {canEdit && (
            <Button variant="ghost" size="sm" title="Delete page" aria-label="Delete page"
              onClick={() => setDialog("delete")}><Trash2 /></Button>
          )}
        </>
      )}
    </>
  );

  // The page's column, with room for the margin beside it when there is one.
  const column = cn("mx-auto max-w-3xl", marginOn && "max-w-[calc(48rem+21.5rem)]");
  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 overflow-hidden", marginOn && "pages-margin-on")}
      data-testid="pages-view">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* On a desktop the page's controls hold the band at the top, and the page scrolls below it: nothing
            passes under the band, and whatever waits at the page's top edge waits below it, clear of the
            window's search there. */}
        {!phone && (
          <div className="app-page-band shrink-0 px-6 lg:px-12">
            <header className={cn(column, "app-band-header flex flex-wrap items-center gap-1.5")} data-testid="page-controls">
              <span className="mr-auto" />
              <span className="mr-1 text-xs text-muted-foreground" data-testid="page-save-state"
                title={`Revision ${headRevision ?? page?.headRevision ?? ""}`}>
                {saveState === "saving" ? "Saving…" : saveState === "saved" ? "All changes saved"
                  : saveState === "offline" ? "Offline · your changes sync when you reconnect"
                  : pending ? "" : connected ? `r${headRevision ?? page?.headRevision ?? ""}` : "Connecting…"}
                {!canEdit && connected ? " · read-only" : ""}
              </span>
              {controls}
            </header>
          </div>
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <PageScrollMarks marks={scrollMarks} />
          <PageOffscreenPeople above={offscreen.above} below={offscreen.below} onJump={jumpTo} />
          <article ref={measureArticle} className={phone ? "app-mobile-page-article min-h-0 min-w-0 flex-1 overflow-y-auto px-6"
            : "app-page-article min-h-0 min-w-0 flex-1 overflow-y-auto px-6 pt-4 pb-6 lg:px-12"}>
            <div className={column}>
              {phone && <div className="-mr-2 flex items-center justify-end gap-1 pb-3" data-testid="page-controls">{controls}</div>}
              {writerFeedback && (
                <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span className="page-writer-dots" aria-hidden="true"><i /><i /><i /></span>
                  <span>{writerFeedback.harness} is starting…{!writerStarting && " Write in the page; your Agent responds here."}</span>
                  {!writerStarting && writerCalled && (
                    <Button variant="ghost" size="sm" onClick={() => openConversation(writerCalled.conversationId)}>
                      Conversation
                    </Button>
                  )}
                </div>
              )}
              {notice && <p className={noticeClass("attention", "mb-3 rounded-md px-3 py-2 text-sm")}>{notice}</p>}
              {migration.data?.state === "proposed" && (
                // An Agent drafted the move; it waits for an owner or admin, however many pages exist.
                <p className={noticeClass("secondary", "mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-sm")}
                  data-testid="page-migration-notice">
                  <span className="min-w-0 flex-1">A draft moves this Space&apos;s conversations to pages.</span>
                  <Button size="xs" variant="outline" onClick={() => setReviewing(spaceId)}>Review</Button>
                </p>
              )}
              {mode === "history" && page ? (
                <PageHistory spaceId={spaceId} pageId={page.pageId} token={token}
                  headRevision={headRevision ?? page.headRevision} canEdit={canEdit}
                  conversationName={conversationName} onOpenConversation={openConversation}
                  onClose={() => setMode("page")}
                  onPromoted={() => void queryClient.invalidateQueries({ predicate: (query) =>
                    query.queryKey.includes("page-tree") })} />
              ) : (
                <div className="flex gap-6">
                  <div ref={docColumn} className={cn("relative min-w-0 max-w-3xl flex-1",
                    phone && phoneDiff && !suggestionMark && "has-reader-mark")}>
                    <PagePens pens={edgePens} room={penRoom} onJump={jumpTo}
                      onOpen={(person) => setDialog({ kind: "agent", key: person.key })} />
                    {suggestionMark && suggestedBy && (
                      <PageChangeMark top={suggestionMark.top} away={suggestionMark.away} testId="page-suggestions"
                        label={`${suggestedBy} suggests this change, ${suggesting.current + 1} of ${suggesting.count}`}>
                        {/* Its face rides its pen in the line; here it says who waits, while the line is out of view. */}
                        {suggestionMark.away && <button type="button" className="page-change-face" aria-label={`${suggestedBy}, show its change`}
                          title={`${suggestedBy} suggests · ${suggesting.current + 1} of ${suggesting.count}`}
                          onClick={() => suggestionControl.current?.step(0)}>
                          <IdentityAvatar kind="agent" label={suggestedBy} imageUrl={suggesterAvatar} size="sm" shape="circle"
                            glass={false} initials={suggesterAvatar ? avatarInitials(suggestedBy) : undefined}
                            className="pointer-events-none rounded-full" />
                        </button>}
                        <button type="button" onClick={() => suggestionControl.current?.take()} aria-label="Take this change"
                          title={phone ? "Accept" : "Accept (Tab)"} className="page-change-button is-primary">
                          <Check className="size-4" />
                        </button>
                        <button type="button" onClick={() => suggestionControl.current?.leave()} aria-label="Leave this change"
                          title={phone ? "Skip" : "Skip (Esc)"} className="page-change-button">
                          <X className="size-4" />
                        </button>
                      </PageChangeMark>
                    )}
                    {drawn && !!readerChanges && !diffViewed && <PageReaderChangeGutter column={docColumn} />}
                    {phone && phoneDiff && !suggestionMark && (
                      <PageReaderChangeMark column={docColumn} article={articleElement} changes={readerChanges ?? 0}
                        onViewed={viewDiff} />
                    )}
                    {!drawn && document.data && (
                      // Where the editor's host holds its height.
                      <div className="min-h-[50vh]"><PageDocumentStatic body={document.data.body} testId="page-preview"
                        references={references} mediaUrl={mediaUrl} onAnchorOffsets={setPreviewTops} /></div>
                    )}
                    {drawn && !!readerChanges && !phone && (
                      <label className="mb-3 flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground"
                        data-testid="page-reader-diff">
                        <input type="checkbox" checked={diffViewed} onChange={(event) => {
                          if (event.target.checked) viewDiff();
                          else setDiffViewed(false);
                        }} />
                        <span className="text-foreground">Viewed</span>
                        <span>{readerChanges === 1 ? "1 change" : `${readerChanges} changes`} since you last read this page</span>
                      </label>
                    )}
                    <div className={drawn ? undefined : "hidden"}>
                      {session && <PageEditor key={session.doc.guid} session={session} canEdit={canEdit} writeOn={writeOn}
                        {...(coWriter ? { placeholder: onboardingCopy.coWrite.firstLine(coWriter) } : {})}
                        onReady={() => setEditorReady(true)} readerBaseline={readerDiff} onReaderChanges={setReaderChanges}
                        onWrite={coWriting} readFrom={readFrom} reading={reading}
                        suggestions={drawn ? waiting.suggestions : null} onSuggestions={setSuggesting}
                        suggestionControl={suggestionControl}
                        actions={sectionActions} headingActions={headingActions} sections={sections}
                        onBlocks={(next) => startTransition(() => setEditorBlocks({ session, blocks: next }))}
                        follow={follow} onOpenConversation={openConversation} discussions={discussions}
                        automations={automationsById} references={references} completion={completion}
                        focusedConversationId={activeConversationId ?? focused} onFocusConversation={setFocused}
                        onAnchorOffsets={setAnchorTops} cursorPresence={cursorPresence} readGitHubFile={readGitHubFile}
                        mediaUrl={mediaUrl} uploadMedia={uploadMedia} />}
                    </div>
                  </div>
                  {/* The margin holds its room from the start, so the text does not reflow when the page has synced;
                      its cards and an open conversation show beside the preview's sections, and move to their
                      anchors in the text once the page is drawn. */}
                  {marginOn && (
                    <aside className="w-80 shrink-0">
                      {(drawn || openInMargin || (document.data && links.data)) && <PageMargin conversations={marginCards}
                        tops={drawn ? anchorTops : previewTops} focusedId={focused} canResolve={canEdit}
                        writers={marginWriters}
                        onWriter={(writer) => setDialog({ kind: "agent", key: writer.key })}
                        writerActions={(person) => {
                          const controls = agentControls(person);
                          return (
                            <>
                              {controls.switchTo && (
                                <button type="button" onClick={controls.switchTo.run}
                                  className={actionClass({ variant: "primary", size: "sm" })}>{controls.switchTo.label}</button>
                              )}
                              {controls.undo && (
                                <button type="button" onClick={controls.undo}
                                  className={actionClass({ variant: "secondary", size: "sm" })}>Undo</button>
                              )}
                              {controls.stop && (
                                <button type="button" onClick={controls.stop}
                                  className={actionClass({ variant: "secondary", size: "sm" })}>Stop</button>
                              )}
                            </>
                          );
                        }}
                        openId={openInMargin ? activeConversationId : null}
                        {...(renderConversation ? { renderOpen: () => renderConversation("margin") } : {})}
                        {...(onCloseConversation ? { onClose: onCloseConversation } : {})}
                        {...(onExpandConversation ? { onExpand: onExpandConversation } : {})}
                        onOpen={openConversation} onResolve={(linkId) => void resolveDiscussion(linkId)}
                        onFocus={setFocused} />}
                    </aside>
                  )}
                </div>
              )}
            </div>
          </article>
        </div>
      </div>
      {phone && mode === "page" && drawn && (
        <PagePhoneDock caller={caller?.agent ?? null} starting={caller?.starting ?? false}
          onCall={() => setDialog({ kind: "write" })} />
      )}
      {docked && renderConversation?.("dock")}
      {page && (
        <>
          {((dialog && typeof dialog === "object" && dialog.kind === "write") || tapped) && (
            <PageWriteWith agents={writers.agents} onClose={() => setDialog(null)}
              working={tapped ? { name: tapped.name, ...(tapped.avatarUrl ? { avatarUrl: tapped.avatarUrl } : {}),
                doing: tapped.detail } : null}
              onStart={(harness) => { setDialog(null); void coWrite(harness, null); }}
              {...(tappedControls?.switchTo ? { switchTo: tappedControls.switchTo } : {})}
              onOpenConversation={tapped?.conversationId
                ? () => { setDialog(null); openConversation(tapped.conversationId!); } : null}
              onStop={tappedControls?.stop ?? null} onUndo={tappedControls?.undo ?? null} />
          )}
          <DeletePageDialog open={dialog === "delete"} title={page.title} hasChildren={hasChildren}
            onClose={() => setDialog(null)} onDelete={removePage} />
          <ShareDialog open={dialog === "share"} onClose={() => setDialog(null)} canPublish={canMigrate}
            canEdit={canEdit} published={Boolean(page.publishedAt)} restricted={restricted} publicUrl={publicUrl}
            suggestOnly={page.agentSuggestOnly} rulesPage={page.governance} onTogglePublished={() => void togglePublished()}
            onToggleSuggestOnly={() => void toggleSuggestOnly()} onToggleRulesPage={() => void toggleRulesPage()}
            onCopyLink={() => copy(pageLink())} />
          <PageDialog open={listSection !== null} onClose={() => setDialog(null)} id="page-conversations-title"
            title="Conversations about this page" wide>
            <ConversationList conversations={conversations} blocks={blocks} onOpen={openConversation}
              focusBlockId={listSection?.blockId ?? null}
              {...(canEdit ? { onResolve: (linkId: string) => void resolveDiscussion(linkId) } : {})} />
          </PageDialog>
          <PageDialog open={attachSection !== null} onClose={() => setDialog(null)} id="page-attach-title"
            title={`Attach to ${blocks.find((block) => block.id === attachSection)?.title ?? page.title}`}>
            {attachSection !== null && attachedProps && (
              <PageAttached {...attachedProps} section={attachSection}
                onAttached={() => setDialog(null)} />
            )}
          </PageDialog>
        </>
      )}
    </div>
  );
}
