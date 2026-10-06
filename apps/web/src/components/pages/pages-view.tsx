"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PageDocBlock } from "@xmatrix/protocol/page-document";
import {
  isLiveAgentStatus, pageAuthorColor, type SerializedAutomation, type SerializedChannel,
} from "@xmatrix/protocol";
import {
  ChevronDown, ChevronRight, FileText, History, Lock, MessageSquare, Plus, Share2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { noticeClass } from "@/components/ui/status-tone";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import {
  PageLiveSession, pageApi, pageChildren,
  type PageClaim, type PageLinkAnchor, type PagePresenceState, type PageRecentChange, type PageSummary, type PageTreeAgent,
} from "@/lib/pages/page-client";
import { cn } from "@/lib/utils";
import { ListSkeleton } from "@/components/dashboard/content-skeleton";
import { pagesViewPath } from "@/components/dashboard/workspace-shell-navigation";
import type { CursorPresence, Discussion, HeadingActions, PageSectionActions, SectionNote } from "./page-editor";
import { PageAttached, type PageScheduleInput } from "./page-attached";
import {
  ConversationList, PageDialog, PageHistory, PageOffscreenPeople, PageScrollMarks, PresenceStack, ShareDialog, type OffscreenPerson, type PresentPerson, type PageScrollMark,
} from "./page-chrome";
import { PageMargin } from "./page-margin";
import { marginConversations, sectionConversationCounts, withOpenConversation, type LiveConversation } from "./page-margin-model";
import { formatRelativeAge, mobileChatTimeLabel } from "@/components/dashboard/time-display";
import { ListSectionHeading } from "@/components/dashboard/list-section-heading";
import { MORE_RECENT_CHANGES, RECENT_CHANGES, pageRecentChangePreview, pageTreeHeadKey } from "./page-recent-changes";
import { discussionDraft, discussionTitle } from "@/components/dashboard/selection-discussion";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { avatarInitials } from "@/components/dashboard/completion-option-button";
import { COUNT_CHIP_MATERIAL_CLASS } from "@/components/dashboard/workspace-shell-constants";
import { PageMigrationReview, usePageMigration } from "./page-migration-review";

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

/** The document already opens with this page's name, so the header must not say it again. */
function documentOpensWithTitle(title: string, blocks: PageDocBlock[], markdown: string | undefined): boolean {
  const name = title.trim();
  if (!name) return false;
  if (blocks.length > 0) return blocks[0].pos === 0 && blocks[0].title.trim() === name;
  const line = markdown?.trimStart().split("\n", 1)[0]?.trim() ?? "";
  const heading = /^(#{1,6})\s+(\S.*)$/u.exec(line);
  return heading?.[2]?.trim() === name;
}

/**
 * Pages (docs/design/pages-and-conversations.md): the Space's living documents.
 * The tree is how the organization is read; each page is co-edited live by
 * people and Agents, with who is on each section shown beside it.
 */

export function usePageTree(spaceId: string | null, token: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-tree", [spaceId]),
    enabled: Boolean(spaceId && token && user?.id), staleTime: 5_000, refetchInterval: 30_000,
    queryFn: ({ signal }) => pageApi.tree(spaceId!, token, signal).then((result) => result.pages),
  });
}

/** The Agents reading or editing each page from a live Run, as Channel rows show theirs. */
function usePageAgents(spaceId: string | null, token: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-tree-agents", [spaceId]),
    enabled: Boolean(spaceId && token && user?.id), staleTime: 5_000, refetchInterval: 15_000,
    queryFn: ({ signal }) => pageApi.agents(spaceId!, token, signal)
      .then((result) => new Map(result.pages.map((page) => [page.pageId, page.agents]))),
  });
}

const TREE_AVATARS = 3;
const NO_AGENTS = new Map<string, PageTreeAgent[]>();

// The Agents on a page stay icon-sized beside its title.
function PageAgentAvatars({ agents }: { agents: readonly PageTreeAgent[] }) {
  // Busy Agents first: they are the ones working on the page right now.
  const sorted = [...agents].sort((a, b) => Number(b.status === "busy") - Number(a.status === "busy"));
  const hidden = sorted.length - TREE_AVATARS;
  return (
    <div className="app-channel-agent-avatars flex shrink-0 items-center -space-x-1.5 px-0.5" data-testid="page-tree-agents">
      {sorted.slice(0, TREE_AVATARS).map((agent) => (
        <IdentityAvatar key={`${agent.instanceId}:${agent.conversationId}`} kind="agent"
          label={`${agent.name} (${agent.activity})`} status={agent.status} imageUrl={agent.avatarUrl}
          initials={agent.avatarUrl ? avatarInitials(agent.name) : undefined}
          size="xs" showKindBadge={false} className="app-channel-agent-avatar rounded-full" />
      ))}
      {hidden > 0 && (
        <span className={cn("app-channel-presence-overflow flex size-5 items-center justify-center text-[9px] font-bold",
          COUNT_CHIP_MATERIAL_CLASS)}>
          +{hidden}
        </span>
      )}
    </div>
  );
}

/** A page row's second line: who is on the page now, else when it last changed. */
export function pageRowMeta(page: Pick<PageSummary, "updatedAt">, agents: readonly PageTreeAgent[], now = Date.now()) {
  const editing = agents.filter((agent) => agent.activity === "editing");
  const on = editing.length > 0 ? editing : agents;
  if (on.length > 0) {
    const names = [...new Set(on.map((agent) => agent.name))];
    const who = names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
    return `${who} ${editing.length > 0 ? "editing" : "reading"}`;
  }
  const age = formatRelativeAge(page.updatedAt, now);
  return age ? `Edited ${age}` : "";
}

/**
 * One tree row's frame: the padding, selected material and expand control.
 * The caller supplies the row's own label control as children. The row is a list row, two lines
 * as tall as a conversation or an agent, on a phone as beside a page.
 */
function PageTreeRow({ depth, selected, open, onToggle, expandHidden, children }: {
  depth: number; selected: boolean; open: boolean; onToggle: () => void;
  expandHidden?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`app-page-row app-list-row group flex min-h-8 items-center gap-1${selected
      ? " app-page-row-selected font-semibold" : ""}`}
      style={{ "--page-depth": depth } as CSSProperties}>
      <button type="button" aria-label={open ? "Collapse" : "Expand"}
        className={`flex size-5 shrink-0 items-center justify-center text-muted-foreground ${expandHidden ? "invisible" : ""}`}
        onClick={onToggle}>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
      </button>
      {children}
    </div>
  );
}

function TreeNode({ page, childrenOf, agentsOf, depth, selectedPageId, onSelect, onPrefetch, onCreateChild }: {
  page: PageSummary; childrenOf: Map<string | null, PageSummary[]>; agentsOf: Map<string, PageTreeAgent[]>; depth: number;
  selectedPageId: string | null; onSelect: (pageId: string) => void; onPrefetch: (pageId: string) => void;
  /** Makes a page under this one, from the row itself. */
  onCreateChild?: (pageId: string) => void;
}) {
  const children = childrenOf.get(page.pageId) ?? [];
  const [open, setOpen] = useState(true);
  const selected = page.pageId === selectedPageId;
  const agents = agentsOf.get(page.pageId) ?? [];
  return (
    <li>
      <PageTreeRow depth={depth} selected={selected} open={open}
        onToggle={() => setOpen((value) => !value)} expandHidden={children.length === 0}>
        <button type="button" className="flex min-w-0 flex-1 flex-col text-left"
          onClick={() => onSelect(page.pageId)} onPointerEnter={() => onPrefetch(page.pageId)}
          onFocus={() => onPrefetch(page.pageId)}>
          <span className="app-page-row-title-line flex min-w-0 items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="app-page-row-title app-list-row-title truncate">{page.title}</span>
            {page.accessMode === "restricted" && <Lock className="size-3 shrink-0 text-muted-foreground" />}
          </span>
          <span className="app-list-row-meta truncate">{pageRowMeta(page, agents)}</span>
        </button>
        {agents.length > 0 && <PageAgentAvatars agents={agents} />}
        {/* Shown while the row is hovered; a touch screen has no hover, so there it stays. */}
        {onCreateChild && (
          <button type="button" aria-label="New sub-page" title="New sub-page"
            onClick={() => onCreateChild(page.pageId)}
            className="app-page-row-create flex size-4 shrink-0 items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100">
            <Plus className="size-4" />
          </button>
        )}
      </PageTreeRow>
      {open && children.length > 0 && (
        <ul>
          {children.map((child) => (
            <TreeNode key={child.pageId} page={child} childrenOf={childrenOf} agentsOf={agentsOf} depth={depth + 1}
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

const PREFETCHED_PAGES = 40;

export type PageCreation = ReturnType<typeof usePageCreation>;

/**
 * Creating a page, shared by the tree's own + and, on a phone, the + in the
 * top bar: one state, so the tree shows the error whichever of them started it.
 */
export function usePageCreation(spaceId: string | null, token: string, onCreated: (pageId: string) => void) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useCallback(async (parentPageId: string | null) => {
    const title = window.prompt(parentPageId ? "Title of the new sub-page" : "Title of the new page");
    if (!title?.trim() || !spaceId) return;
    setCreating(true);
    setError(null);
    try {
      const { page } = await pageApi.create(spaceId, token, { title: title.trim(), parentPageId });
      await queryClient.invalidateQueries({ queryKey: ["xmatrix"], predicate: (query) =>
        query.queryKey.includes("page-tree") });
      onCreated(page.pageId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the page");
    } finally {
      setCreating(false);
    }
  }, [onCreated, queryClient, spaceId, token]);
  return { create, creating, error };
}

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
  const agents = usePageAgents(spaceId, token);
  const agentsOf = agents.data ?? NO_AGENTS;
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const prefetch = useCallback((pageId: string) => {
    if (spaceId) void queryClient.prefetchQuery(pageDocumentQuery(userId, spaceId, pageId, token));
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
      {creation.error && <p className={`${inset} pb-2 text-xs text-destructive`}>{creation.error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {tree.isLoading && <ListSkeleton label="Loading pages" rows={6} className={inset} />}
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
            <ListSectionHeading label="Recent changes"
              action={moreChanges ? { label: "Less", onClick: () => setMoreChanges(false) }
                : changes.length >= RECENT_CHANGES ? { label: "More", onClick: () => setMoreChanges(true) } : undefined} />
            <ul>{changes.map((change) => (
              <RecentChangeRow key={change.pageId} change={change}
                onOpen={() => onOpenSection(change.pageId, change.block?.id ?? null)} />
            ))}</ul>
          </section>
        )}
        {/* The list always meets the plank with a section's name, never a bare row. */}
        {roots.length > 0 && <ListSectionHeading label="All pages" />}
        <ul>{roots.map((page) => (
          <TreeNode key={page.pageId} page={page} childrenOf={childrenOf} agentsOf={agentsOf} depth={0}
            selectedPageId={selectedPageId} onSelect={onSelectPage} onPrefetch={prefetch}
            onCreateChild={creation.creating ? undefined : (pageId) => void creation.create(pageId)} />
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
    const read = () => setStates([...session.awareness.getStates().entries()]
      .filter(([clientId]) => clientId !== session.doc.clientID)
      .map(([clientId, state]) => ({ clientId, state: state as PagePresenceState }))
      .filter(({ state }) => Boolean(state?.user)));
    read();
    session.awareness.on("change", read);
    return () => session.awareness.off("change", read);
  }, [session]);
  return states;
}


function pageClaimsKey(userId: string | null, spaceId: string | null | undefined, pageId: string | null) {
  return xmatrixQueryKeys.domain({ userId: userId ?? "anonymous" }, "page-claims", [spaceId, pageId]);
}

/** The Agents live in a conversation this client holds, from its member presence. */
function liveAgents(channel: SerializedChannel): LiveConversation["agents"] {
  if (!channel.memberPresence) return undefined;
  return Object.values(channel.memberPresence).flatMap((member) => {
    if (member.kind !== "agent") return [];
    return (member.instances ?? []).flatMap((instance) => {
      if (!isLiveAgentStatus(instance.status)) return [];
      return [{
        instanceId: instance.id, name: instance.label || member.label || "Agent",
        status: instance.status,
      }];
    });
  });
}

/** The document column at its narrowest beside the margin, plus the margin and the gap between them. */
const MARGIN_ROOM_PX = 640 + 24 + 320;

type PageDialogState =
  | "share"
  | { kind: "conversations"; blockId: string | null }
  | { kind: "attach"; blockId: string };

export function PagesView({ spaceId, token, selectedPageId, onSelectPage, conversation, activeConversationId = null,
  renderConversation, onCloseConversation, onExpandConversation, onOpenConversation, onDiscuss, onConnectGitHub, canMigrate, layout = "desktop", focusSection = null }: {
  spaceId: string | null;
  token: string;
  selectedPageId: string | null;
  onSelectPage: (pageId: string) => void;
  /** What this client knows live about a conversation: the channel it holds, when it holds it. */
  conversation: (conversationId: string) => SerializedChannel | null;
  /** The conversation open beside the page: in the margin at what it is about, or docked when there is no room. */
  activeConversationId?: string | null;
  /** The open conversation itself, the product's one conversation surface, for where the page shows it. */
  renderConversation?: (placement: "margin" | "dock") => ReactNode;
  /** Closes the open conversation, or gives it the whole window. */
  onCloseConversation?: () => void;
  onExpandConversation?: (conversationId: string) => void;
  /** Opens a conversation beside the page (pages-live-document.md §4.4). */
  onOpenConversation: (conversationId: string) => void;
  onDiscuss: (input: { spaceId: string; pageId: string; blockId: string; name: string; restricted: boolean;
    anchor?: PageLinkAnchor; firstMessage?: string; draft?: string }) => Promise<unknown>;
  /** Subscribes a conversation of its own, linked to a section, to a repository's issues and pull requests. */
  onConnectGitHub?: (input: { spaceId: string; pageId: string; blockId: string; repository: string;
    restricted: boolean }) => Promise<void>;
  /** A Space owner or admin may move the Space's Channels to pages. */
  canMigrate: boolean;
  /** On a phone a page is a pushed screen, like a conversation; the shell's back bar carries its title. */
  layout?: "desktop" | "phone";
  /** A section a reference opened the page at; a new `seq` brings it into view again. */
  focusSection?: { pageId: string; blockId: string; seq: number } | null;
}) {
  const { user } = useAuth();
  const tree = usePageTree(spaceId, token);
  const pages = tree.data ?? [];
  // Held from the moment the owner applies, or opens the report, so the report
  // is read before the new pages replace it.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const migration = usePageMigration(spaceId ?? "", token, canMigrate && Boolean(spaceId));
  const phone = layout === "phone";
  // A desktop opens the first page; a phone starts from the list.
  const pageId = selectedPageId ?? (phone ? null : pageChildren(pages).get(null)?.[0]?.pageId ?? null);
  const page = pages.find((item) => item.pageId === pageId) ?? null;
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
  const [mode, setMode] = useState<"page" | "history">("page");
  const [dialog, setDialog] = useState<PageDialogState | null>(null);
  // The conversation whose card is being read, so its passage is marked (§4.4).
  const [focused, setFocused] = useState<string | null>(null);
  const [anchorTops, setAnchorTops] = useState<ReadonlyMap<string, number>>(new Map());
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
      if (article) setViewport({ top: article.scrollTop, height: article.clientHeight });
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
  // How far this person has read the page, kept by the Hub on every device of theirs (§3.1): History shows
  // a dot when the page moved past it, as Google Docs does. `opened` is where it stood as the page opened.
  const [seenRevision, setSeenRevision] = useState<number | null>(null);
  const [opened, setOpened] = useState<{ pageId: string; revision: number | null } | null>(null);
  // What the page was when this reader last had it on screen, for showing what changed since.
  const [readerBaseline, setReaderBaseline] = useState<string | null>(null);
  useEffect(() => {
    setSeenRevision(null);
    setOpened(null);
    setReaderBaseline(null);
    if (!spaceId || !pageId || !token) return;
    const controller = new AbortController();
    // Unknown, nothing is marked read and nothing is shown as changed.
    pageApi.readState(spaceId, pageId, token, controller.signal).then(({ revision }) => {
      setOpened({ pageId, revision });
      setSeenRevision(revision);
    }, () => undefined);
    return () => controller.abort();
  }, [spaceId, pageId, token]);
  const seen = useRef<number | null>(null);
  seen.current = seenRevision;
  const markSeen = useCallback((revision: number) => {
    if (!spaceId || !pageId || opened?.pageId !== pageId || revision <= (seen.current ?? 0)) return;
    seen.current = revision;
    setSeenRevision(revision);
    void pageApi.markRead(spaceId, pageId, token, revision).catch(() => undefined);
  }, [opened, pageId, spaceId, token]);
  const unseen = headRevision !== null && seenRevision !== null && headRevision > seenRevision;
  // The page on screen in this tab is read at its head once it has been there a moment.
  useEffect(() => {
    if (mode !== "page" || !drawn || headRevision === null) return;
    let timer: number | undefined;
    const read = () => {
      window.clearTimeout(timer);
      if (window.document.visibilityState === "visible") timer = window.setTimeout(() => markSeen(headRevision), READ_AFTER_MS);
    };
    read();
    window.document.addEventListener("visibilitychange", read);
    return () => { window.clearTimeout(timer); window.document.removeEventListener("visibilitychange", read); };
  }, [drawn, headRevision, markSeen, mode]);
  const baselineFor = useRef<typeof opened>(null);
  useEffect(() => {
    if (!opened || opened.pageId !== pageId || headRevision === null || baselineFor.current === opened) return;
    baselineFor.current = opened;
    setReaderBaseline(null);
    if (opened.revision === null || opened.revision >= headRevision || !spaceId) return;
    void pageApi.read(spaceId, opened.pageId, token, opened.revision)
      .then((result) => { if (baselineFor.current === opened) setReaderBaseline(result.page.body); }, () => undefined);
  }, [headRevision, opened, pageId, spaceId, token]);
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const userName = user?.name || user?.email || "";

  // With no page named, the first top-level page opens, and the URL names it.
  useEffect(() => {
    if (pageId && pageId !== selectedPageId) onSelectPage(pageId);
  }, [onSelectPage, pageId, selectedPageId]);

  // Another page opens as itself, not in the previous page's history.
  useEffect(() => {
    setMode("page");
    setDialog(null);
    setFocused(null);
  }, [pageId]);

  useEffect(() => {
    if (!spaceId || !pageId || !userId || !token) return;
    // One session per page; it must not churn when the auth context re-renders.
    const live = new PageLiveSession({ spaceId, pageId, token,
      user: { name: userName, color: pageAuthorColor({ kind: "user", id: userId }) } });
    setSession(live);
    setNotice(null);
    const off = live.on((event) => {
      if (event.type === "status") {
        setConnected(event.connected);
        connectedRef.current = event.connected;
        setSaveState((state) => state === "offline" && event.connected ? "saved"
          : state !== "idle" && !event.connected ? "offline" : state);
      }
      if (event.type === "local-edit") {
        setSaveState(connectedRef.current ? "saving" : "offline");
        window.clearTimeout(saveTimer.current);
        // The edit is sent as it is made; the session keeps it as it arrives.
        saveTimer.current = window.setTimeout(() => setSaveState(connectedRef.current ? "saved" : "offline"), 700);
      }
      if (event.type === "synced") setSynced(true);
      if (event.type === "session") { setCanEdit(event.canEdit); setHeadRevision(event.headRevision); }
      if (event.type === "access") {
        if (event.canRead === false) setNotice("You no longer have access to this page.");
        if (typeof event.canEdit === "boolean") setCanEdit(event.canEdit);
      }
      if (event.type === "committed") {
        setHeadRevision(event.headRevision);
        // An Agent that just edited is on the page from now; its caret shows once its live Run is known.
        void queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes("page-tree-agents") });
      }
      if (event.type === "suggestion") setNotice(`${event.author} suggested a change — see History.`);
      if (event.type === "claims") {
        queryClient.setQueryData<{ claims: PageClaim[]; competitiveBlocks: string[] }>(pageClaimsKey(userId, spaceId, pageId),
          (current) => ({ competitiveBlocks: current?.competitiveBlocks ?? [], claims: event.claims }));
      }
      if (event.type === "error" && event.code === "page_body_too_large") setNotice("This page is over 256 KiB.");
      if (event.type === "error" && event.code === "page_server_outdated") {
        setNotice("Live editing is being updated; the page will open for editing in a moment.");
      }
    });
    return () => { off(); live.destroy(); setSession(null); setConnected(false); setSynced(false); setEditorReady(false);
      setSaveState("idle"); };
  }, [spaceId, pageId, token, userId, userName, queryClient]);

  // The editor reads the page's sections from its document as it changes.
  const [blocks, setBlocks] = useState<PageDocBlock[]>([]);
  const presence = usePresence(session);
  const links = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-links", [spaceId, pageId, headRevision]),
    enabled: Boolean(spaceId && pageId), refetchInterval: 30_000,
    queryFn: ({ signal }) => pageApi.links(spaceId!, token, { pageId: pageId! }, signal),
  });
  const linkList = useMemo(() => links.data?.links ?? [], [links.data]);
  // The page's Automations, drawn as chips where the text references them (pages-live-document.md §6).
  const automations = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-automations", [spaceId, pageId, headRevision]),
    enabled: Boolean(spaceId && pageId), refetchInterval: 30_000,
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
        label: last.from.label }, bodyPreview: last.bodyPreview, sentAt: last.sentAt } : null,
      agents: liveAgents(channel),
      ...(channel.historyHeadSequence !== undefined ? { headSequence: channel.historyHeadSequence } : {}),
      ...(channel.readSequence !== undefined ? { readSequence: channel.readSequence } : {}),
    };
  }, [conversation]);
  const conversations = useMemo(() => marginConversations({ links: linkList, conversations: links.data?.conversations,
    live: liveConversation, now: Date.now() }), [linkList, links.data?.conversations, liveConversation]);
  const conversationName = useCallback((conversationId: string) =>
    conversations.find((item) => item.conversationId === conversationId)?.name ?? conversation(conversationId)?.name ?? null,
  [conversation, conversations]);
  // Open discussions anchored in the text, highlighted there (pages-live-document.md §4.3).
  const discussions = useMemo<Discussion[]>(() => linkList.filter((link) => link.anchor && !link.resolvedAt)
    .map((link) => ({ linkId: link.linkId, conversationId: link.conversationId, from: link.anchor!.from,
      to: link.anchor!.to, name: conversationName(link.conversationId) ?? link.anchor!.quote })),
  [conversationName, linkList]);

  // When each section last changed, and by whom where; refreshed as revisions land.
  const awareness = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-awareness", [spaceId, pageId, headRevision]),
    enabled: Boolean(spaceId && pageId && token), refetchInterval: 30_000,
    queryFn: ({ signal }) => pageApi.awareness(spaceId!, pageId!, token, signal),
  });
  // Who changed the page last and when, said by History's button as Google Docs says it by its clock.
  const lastEdit = useMemo(() => {
    const latest = (awareness.data?.blocks ?? []).map((block) => block.updated)
      .filter((updated) => updated !== null)
      .sort((a, b) => b.revision - a.revision)[0];
    if (!latest) return null;
    const who = latest.authors.map((author) => author.label).join(", ");
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
  const liveOnPage = useMemo(() => pageAgents.data?.get(pageId ?? "") ?? [], [pageAgents.data, pageId]);
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
  const present = useMemo(() => presence.filter(({ state }) => cursorPresence(state) !== null),
    [cursorPresence, presence]);

  // Claims arrive live from the session; the interval lets lapsed ones go.
  const claims = useQuery({
    queryKey: pageClaimsKey(userId, spaceId, pageId), enabled: Boolean(spaceId && pageId && token), refetchInterval: 60_000,
    queryFn: ({ signal }) => pageApi.claims(spaceId!, pageId!, token, signal),
  });
  const claimBlock = (blockId: string) => pageApi.claim(spaceId!, pageId!, token, blockId)
    .then(() => claims.refetch(), (cause: Error) => setNotice(cause.message));
  const releaseClaim = (claimId: string) => pageApi.releaseClaim(spaceId!, pageId!, token, claimId)
    .then(() => claims.refetch(), (cause: Error) => setNotice(cause.message));

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
    for (const item of conversations) {
      if (item.agents.length === 0) continue;
      const working = note(item.blockId).working ??= [];
      for (const agent of item.agents) {
        working.push({ name: agent.name, busy: agent.status === "busy", avatarUrl: agent.avatarUrl,
          conversation: { id: item.conversationId, name: item.name } });
      }
    }
    for (const [blockId, count] of sectionConversationCounts(conversations)) note(blockId).conversations = count;
    for (const claim of claims.data?.claims ?? []) {
      if (note(claim.blockId).claim) continue;
      note(claim.blockId).claim = { label: claim.holder.label, pullRequestUrl: claim.pullRequestUrl ?? null,
        claimId: claim.claimId, mine: claim.ownerUserId === userId };
    }
    return notes;
  }, [awareness.data, claims.data, conversationName, conversations, userId]);

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
      setNotice(cause instanceof Error ? cause.message : "Could not change who can read this page");
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
      setNotice(cause instanceof Error ? cause.message : "Could not change who edits this page");
    }
  };

  const renamePage = async (value: string) => {
    const title = value.trim();
    if (!spaceId || !page || !title || title === page.title) return;
    try {
      await pageApi.update(spaceId, page.pageId, token, { title });
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes("page-tree") });
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not rename the page");
    }
  };

  const toggleSuggestOnly = async () => {
    if (!spaceId || !page) return;
    await pageApi.update(spaceId, page.pageId, token, { agentSuggestOnly: !page.agentSuggestOnly });
    await queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes("page-tree") });
  };

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
  const restricted = page ? effectivelyRestricted(page.pageId, pages) : false;
  const pageLink = () => `${window.location.origin}${
    pagesViewPath(`/app/${encodeURIComponent(spaceId)}/pages`, page?.pageId ?? null, null)}`;
  // The link a pull request names to pass the `xmatrix/claim` check.
  const blockLink = (blockId: string) => `${pageLink()}#${blockId}`;
  const claimsOn = (blockId: string) => (claims.data?.claims ?? []).filter((claim) => claim.blockId === blockId);
  // Free, or open for competition and not already yours.
  const claimable = (blockId: string) => claimsOn(blockId).length === 0 ||
    (Boolean(claims.data?.competitiveBlocks.includes(blockId)) &&
      !claimsOn(blockId).some((claim) => claim.holder.kind === "user" && claim.holder.id === userId));
  const discuss = (blockId: string, anchor?: PageLinkAnchor) => {
    if (!page) return;
    const title = blocks.find((block) => block.id === blockId)?.title;
    // A discussion of a passage is named by the passage, and opens holding it; of a section, by the section.
    const place = title ? `${page.title} › ${title}` : page.title;
    void onDiscuss({ spaceId, pageId: page.pageId, blockId, name: anchor ? discussionTitle(anchor.quote) : place,
      restricted, ...(anchor ? { anchor, draft: discussionDraft(anchor.quote, { label: place, href: blockLink(blockId) }) }
        : {}) }).catch((cause: Error) => setNotice(cause.message));
  };
  const resolveDiscussion = (linkId: string) => pageApi.resolveLink(spaceId, token, linkId, true)
    .then(() => links.refetch(), (cause: Error) => setNotice(cause.message));
  const copy = (text: string) => void navigator.clipboard.writeText(text)
    .then(() => setNotice("Link copied."), (cause: Error) => setNotice(cause.message));
  const copyLink = (blockId: string) => copy(blockLink(blockId));
  // Asking about a passage, or asking for it to change, is a discussion on it whose first message
  // addresses xMatrix; it opens beside the page, where the answer arrives.
  const ask: NonNullable<PageSectionActions["ask"]> = async (blockId, anchor, request) => {
    if (!page) return;
    const quote = anchor.quote.split("\n").map((line) => `> ${line}`).join("\n");
    const where = `page:${page.pageId}${blockId ? ` (section #${blockId})` : ""}`;
    const firstMessage = request.mode === "ask"
      ? `@xMatrix ${request.prompt}\n\nAbout this passage of ${where}:\n${quote}`
      : `@xMatrix ${request.prompt}\n\nChange this passage of ${where} with \`xmatrix page edit\`, then resolve this ` +
        `discussion with \`xmatrix page resolve\` (its link id is under \`discussion:\` in \`xmatrix page read\`):\n${quote}`;
    try {
      await onDiscuss({ spaceId, pageId: page.pageId, blockId, restricted,
        name: `${request.mode === "ask" ? "Ask" : "Change"}: ${request.prompt.slice(0, 60)}`, anchor, firstMessage });
      void links.refetch();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not ask");
      throw cause;
    }
  };
  const claim = (blockId: string) => (claimable(blockId) ? void claimBlock(blockId)
    : setNotice("Someone is already on this section."));
  // What selecting text offers, for the section the selection is in.
  // Who last changed the section, as Show editors tells it in Google Docs (§3.2).
  const editors = (blockId: string) => {
    const updated = awareness.data?.blocks.find((block) => block.blockId === blockId)?.updated;
    if (!updated) return null;
    const conversationId = updated.conversationIds[0];
    const name = conversationId ? conversationName(conversationId) : null;
    return { people: updated.authors.map((author) => ({ name: author.label, color: pageAuthorColor(author) })),
      when: formatRelativeAge(updated.createdAt) ?? new Date(updated.createdAt).toLocaleString(),
      conversation: conversationId && name ? { id: conversationId, name } : null };
  };
  const openHistory = () => {
    if (headRevision !== null) markSeen(headRevision);
    setMode("history");
  };
  const sectionActions: PageSectionActions = { discuss, copyLink, ask, claim, editors, history: openHistory };
  // What a heading offers, beside it (§3.2).
  const headingActions: HeadingActions = {
    canEdit,
    discuss: (blockId) => discuss(blockId),
    copyLink,
    claim,
    release: (claimId) => void releaseClaim(claimId),
    attach: (blockId: string) => setDialog({ kind: "attach", blockId }),
    showConversations: (blockId) => setDialog({ kind: "conversations", blockId }),
  };
  const whereDetail = (activity: string, blockId: string, conversationId: string | null | undefined) => {
    const section = blocks.find((block) => block.id === blockId)?.title;
    const where = conversationId ? conversationName(conversationId) : null;
    return [activity, section, where ? `in ${where}` : null].filter(Boolean).join(" · ");
  };
  const sectionAnchor = (blockId: string) => blockId ? `block:${blockId}` : "page";
  const people: PresentPerson[] = [
    ...present.map(({ clientId, state }) => ({ key: `client:${clientId}`, name: state.user!.name,
      color: state.user!.color, agent: state.user!.kind === "agent", blockId: state.block ?? "",
      idle: cursorPresence(state) === "idle",
      // Placed by their caret where they have one, so the edge hints point at the line.
      anchor: anchorTops.has(`client:${clientId}`) ? `client:${clientId}` : sectionAnchor(state.block ?? ""),
      editing: state.activity === "editing",
      detail: whereDetail(state.activity ?? "viewing", state.block ?? "", state.user!.conversationId) })),
    ...staying.map((agent) => ({ key: `agent:${agent.instanceId}:${agent.conversationId}`, name: agent.name,
      color: pageAuthorColor({ kind: "agent", id: agent.instanceId }), agent: true, avatarUrl: agent.avatarUrl, blockId: agent.blockId,
      idle: agent.status !== "busy",
      anchor: sectionAnchor(agent.blockId), editing: agent.status === "busy",
      detail: whereDetail(agent.status === "busy" ? `${agent.activity}, working` : agent.activity, agent.blockId,
        agent.conversationId) })),
  ];
  // Beside the document on a wide screen, as comments are in Google Docs; the open conversation
  // expands in place there, and docks beside the page only when the margin has no room for it (§4.4).
  const marginRoom = !phone && mode === "page";
  const marginOn = marginRoom && articleWidth >= MARGIN_ROOM_PX;
  const openInMargin = Boolean(activeConversationId) && marginOn;
  const docked = Boolean(activeConversationId) && !phone && !openInMargin;
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
  const offscreen = ((): { above: OffscreenPerson[]; below: OffscreenPerson[] } => {
    const above: OffscreenPerson[] = [];
    const below: OffscreenPerson[] = [];
    if (mode !== "page" || !drawn || !viewport.height) return { above, below };
    for (const person of people) {
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

  const controls = (
    <>
      <PresenceStack people={people} onFollow={jumpTo} />
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
    </>
  );

  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 overflow-hidden", marginOn && "pages-margin-on")}
      data-testid="pages-view">
      <PageScrollMarks marks={scrollMarks} />
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <PageOffscreenPeople above={offscreen.above} below={offscreen.below} onJump={jumpTo} />
        <article ref={measureArticle} className={phone ? "app-mobile-page-article min-h-0 min-w-0 flex-1 overflow-y-auto px-4"
          : "app-page-article min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-6 lg:px-12"}>
          <div className={cn("mx-auto max-w-3xl", marginOn && "max-w-[calc(48rem+21.5rem)]")}>
            {phone ? (
              <div className="flex items-center justify-end gap-1 py-2" data-testid="page-controls">{controls}</div>
            ) : (
              <header className="app-band-header mb-4 flex flex-wrap items-center gap-1.5" data-testid="page-controls">
                {page && !documentOpensWithTitle(page.title, blocks, document.data?.body) ? (canEdit ? (
                  // The page's name, when the document does not already open with it. Plain text: a field well would repeat the heading.
                  <input key={`${page.pageId}:${page.title}`} defaultValue={page.title} aria-label="Page title"
                    data-testid="page-title" onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") { event.currentTarget.value = page.title; event.currentTarget.blur(); }
                    }}
                    onBlur={(event) => void renamePage(event.currentTarget.value)}
                    className="page-title mr-auto min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-2xl font-black shadow-none outline-none" />
                ) : (
                  <h1 className="mr-auto text-2xl font-black">{page.title}</h1>
                )) : <span className="mr-auto" />}
                <span className="mr-1 text-xs text-muted-foreground" data-testid="page-save-state"
                  title={`Revision ${headRevision ?? page?.headRevision ?? ""}`}>
                  {saveState === "saving" ? "Saving…" : saveState === "saved" ? "All changes saved"
                    : saveState === "offline" ? "Offline · your changes sync when you reconnect"
                    : connected ? `r${headRevision ?? page?.headRevision ?? ""}` : "Connecting…"}
                  {!canEdit && connected ? " · read-only" : ""}
                </span>
                {controls}
              </header>
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
                <div ref={docColumn} className="min-w-0 max-w-3xl flex-1">
                  {!drawn && document.data && (
                    // Where the editor's host holds its height.
                    <div className="min-h-[50vh]"><PageDocumentStatic body={document.data.body} testId="page-preview" /></div>
                  )}
                  <div className={drawn ? undefined : "hidden"}>
                    {session && <PageEditor key={session.doc.guid} session={session} canEdit={canEdit}
                      onReady={() => setEditorReady(true)} readerBaseline={drawn ? readerBaseline : null}
                      actions={sectionActions} headingActions={headingActions} onBlocks={setBlocks} sections={sections}
                      follow={follow} onOpenConversation={openConversation} discussions={discussions}
                      automations={automationsById}
                      focusedConversationId={activeConversationId ?? focused} onFocusConversation={setFocused}
                      onAnchorOffsets={setAnchorTops} cursorPresence={cursorPresence} />}
                  </div>
                </div>
                {/* The margin holds its room from the start, so the text does not reflow when the page has synced;
                    an open conversation shows from the start, and moves to its anchor once the page is drawn. */}
                {marginOn && (
                  <aside className="w-80 shrink-0">
                    {(drawn || openInMargin) && <PageMargin conversations={marginCards} tops={anchorTops} focusedId={focused} canResolve={canEdit}
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
      {docked && renderConversation?.("dock")}
      {page && (
        <>
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
