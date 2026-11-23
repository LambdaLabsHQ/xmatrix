"use client";

/**
 * Search in a Space, reached by ⌘F or a search control. Every result shows in
 * the panel that drops from that control: places by name, conversations,
 * people, pages and messages, with older messages read on request. Pressed
 * inside a conversation, ⌘F starts with `in:` that conversation; Backspace
 * takes it off.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/lib/auth-context";
import { isImeKeyDown } from "@/lib/ime-keydown";
import { cn } from "@/lib/utils";
import type { RealtimeCollection } from "./realtime-collection";
import { ArrowRight, AtSign, ChevronDown, Clock, FileText, Hash, MessageSquare, X } from "lucide-react";
import type {
  MessageSearchHit,
  ObservabilityEvent,
  PageSearchHit,
  PageSummary,
  SerializedAgent,
  ChannelSnapshot,
  SerializedMachineDaemon,
  SerializedSpace,
  SerializedWorkspace,
} from "@xmatrix/protocol";
import { channelTitle } from "@/components/dashboard/channel-links";
import { useCatalogSearch } from "./workspace-shell-chrome";
import { SearchPanel, SearchResultRow } from "./workspace-search-panel";
import {
  buildWorkspaceSearchResults, scrollActiveCommandResultIntoView, searchResultIcon,
} from "./workspace-shell-helpers-extra";
import {
  applySearchRerank, rankSearchResults, searchActivityMs, searchMatchTier, type SearchRank,
  type SearchRerankCandidate,
} from "./workspace-search-rank";
import { useSearchRerank, type WorkspaceSearchRerank } from "./use-search-rerank";
import type { WorkspaceMessageSearch } from "./workspace-shell-helpers";
import type { SpaceChannelCatalog } from "./use-channel-catalog-paging";
import type { AppView } from "./workspace-shell-navigation";
import { relativeTime } from "./workspace-shell-presence";
import {
  matchingSearchDestinations,
  readRecentSearches,
  rememberRecentSearch,
  searchAuthorParam,
  searchHasFilters,
  searchHighlightParts,
  searchIsRunnable,
  searchRequestFromParams,
  searchRequestKey,
  searchRequestLabel,
  type SearchAuthor,
  type SearchFilters,
  type SearchRequest,
} from "./workspace-search-model";

type MessageSearchState = {
  hits: MessageSearchHit[];
  status: "idle" | "loading" | "ready" | "unavailable";
  /** Older messages remain to be read; `loadMore` reads them. */
  more: boolean;
  loadingMore: boolean;
  loadMore: () => void;
};

/**
 * The Hub's message search for one request. The first page is read at once;
 * `loadMore` continues from where the Hub stopped. A failure is shown as one,
 * never as an empty result.
 */
export function useMessageSearch(reader: WorkspaceMessageSearch | undefined, request: SearchRequest,
  enabled: boolean): MessageSearchState {
  const key = searchRequestKey(request);
  const [state, setState] = useState<{ key: string; hits: MessageSearchHit[]; resumeToken?: string;
    status: MessageSearchState["status"]; loadingMore: boolean }>({ key: "", hits: [], status: "idle", loadingMore: false });
  const requestRef = useRef(request);
  requestRef.current = request;

  const filters = (current: SearchRequest) => ({
    ...(current.channel ? { channelId: current.channel.id } : {}),
    ...(current.from ? { from: searchAuthorParam(current.from) } : {}),
  });

  useEffect(() => {
    const current = requestRef.current;
    if (!enabled || !reader || !searchIsRunnable(current)) {
      setState({ key, hits: [], status: "idle", loadingMore: false });
      return undefined;
    }
    let cancelled = false;
    setState({ key, hits: [], status: "loading", loadingMore: false });
    const timer = window.setTimeout(() => {
      reader(current.text.trim(), undefined, filters(current)).then((page) => {
        if (cancelled) return;
        setState({ key, hits: page.results, status: "ready", loadingMore: false,
          ...(page.execution !== "proven" && page.resumeToken ? { resumeToken: page.resumeToken } : {}) });
      }, () => {
        if (!cancelled) setState({ key, hits: [], status: "unavailable", loadingMore: false });
      });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, key, reader]);

  const current = state.key === key ? state : { key, hits: [], status: "loading" as const, loadingMore: false };
  return {
    hits: current.hits,
    status: current.status,
    more: Boolean(state.key === key && state.resumeToken),
    loadingMore: current.loadingMore,
    loadMore: () => {
      if (!reader || state.key !== key || !state.resumeToken || state.loadingMore) return;
      const resumeToken = state.resumeToken;
      setState((previous) => ({ ...previous, loadingMore: true }));
      reader(requestRef.current.text.trim(), resumeToken, filters(requestRef.current)).then((page) => {
        setState((previous) => previous.key !== key ? previous : {
          key, status: "ready", loadingMore: false, hits: [...previous.hits, ...page.results],
          ...(page.execution !== "proven" && page.resumeToken && page.resumeToken !== resumeToken
            ? { resumeToken: page.resumeToken } : {}),
        });
      }, () => {
        setState((previous) => previous.key !== key ? previous : { ...previous, loadingMore: false, status: "unavailable" });
      });
    },
  };
}

function usePageSearch(searchPages: ((query: string) => Promise<{ results: PageSearchHit[] }>) | undefined,
  text: string, enabled: boolean): PageSearchHit[] {
  const [state, setState] = useState<{ text: string; hits: PageSearchHit[] }>({ text: "", hits: [] });
  const trimmed = text.trim();
  useEffect(() => {
    if (!enabled || !searchPages || !trimmed) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchPages(trimmed).then((page) => {
        if (!cancelled) setState({ text: trimmed, hits: page.results });
      }, () => {
        if (!cancelled) setState({ text: trimmed, hits: [] });
      });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, searchPages, trimmed]);
  return enabled && state.text === trimmed ? state.hits : [];
}

export function Highlighted({ text, needle }: { text: string; needle: string }) {
  return (
    <>
      {searchHighlightParts(text, needle).map((part, index) => part.match
        ? <mark key={index} className="app-search-match">{part.text}</mark>
        : <span key={index}>{part.text}</span>)}
    </>
  );
}

function hitChannelLabel(hit: MessageSearchHit, channelById: Map<string, ChannelSnapshot>): string {
  const channel = channelById.get(hit.channelId);
  return channel ? `#${channelTitle(channel)}` : "a conversation";
}

type FilterKind = "in" | "from";

function FilterTrigger({
  icon: Icon,
  label,
  open,
  onToggle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[color-mix(in_oklab,var(--foreground)_12%,transparent)] pl-2.5 pr-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)] hover:text-foreground sm:h-7 sm:text-[12px]",
        open && "border-[color-mix(in_oklab,var(--foreground)_24%,transparent)] bg-[color-mix(in_oklab,var(--foreground)_9%,transparent)] text-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span>{label}</span>
      <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
    </button>
  );
}

function ActiveFilterChip({
  prefix,
  value,
  open,
  onSelect,
  onRemove,
}: {
  prefix: string;
  value: string;
  open: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const fullLabel = `${prefix} ${value}`;
  return (
    <span
      className={cn(
        "app-search-chip inline-flex h-8 min-w-0 max-w-full items-center text-[13px] font-semibold sm:h-7 sm:text-[12px]",
        open && "border-[color-mix(in_oklab,var(--foreground)_24%,transparent)] bg-[color-mix(in_oklab,var(--foreground)_11%,transparent)]",
      )}
    >
      <button
        type="button"
        title={fullLabel}
        aria-expanded={open}
        onClick={onSelect}
        className="inline-flex h-full min-w-0 items-center gap-1 pl-2.5 pr-2 text-foreground transition-colors hover:bg-[color-mix(in_oklab,var(--foreground)_6%,transparent)]"
      >
        <span className="shrink-0 font-medium text-muted-foreground">{prefix}</span>
        <span className="truncate">{value}</span>
      </button>
      <button
        type="button"
        aria-label={`Remove ${fullLabel}`}
        title={`Remove ${fullLabel}`}
        onClick={onRemove}
        className="inline-flex h-full w-7.5 shrink-0 items-center justify-center text-muted-foreground shadow-[inset_1px_0_0_color-mix(in_oklab,var(--foreground)_10%,transparent)] transition-colors hover:bg-[color-mix(in_oklab,var(--foreground)_10%,transparent)] hover:text-foreground sm:w-6.5"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

function SearchFilterBar({
  filters,
  activeKind,
  onToggle,
  onRemove,
  onClearAll,
}: {
  filters: SearchFilters;
  activeKind: FilterKind | null;
  onToggle: (kind: FilterKind) => void;
  onRemove: (kind: FilterKind) => void;
  onClearAll: () => void;
}) {
  return (
    <>
      {filters.channel ? (
        <ActiveFilterChip
          prefix="in"
          value={`#${filters.channel.label}`}
          open={activeKind === "in"}
          onSelect={() => onToggle("in")}
          onRemove={() => onRemove("in")}
        />
      ) : (
        <FilterTrigger
          icon={Hash}
          label="In"
          open={activeKind === "in"}
          onToggle={() => onToggle("in")}
        />
      )}
      {filters.from ? (
        <ActiveFilterChip
          prefix="from"
          value={filters.from.label}
          open={activeKind === "from"}
          onSelect={() => onToggle("from")}
          onRemove={() => onRemove("from")}
        />
      ) : (
        <FilterTrigger
          icon={AtSign}
          label="From"
          open={activeKind === "from"}
          onToggle={() => onToggle("from")}
        />
      )}
      {filters.channel && filters.from && (
        <button
          type="button"
          onClick={onClearAll}
          className="inline-flex h-8 shrink-0 items-center rounded-full px-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-[oklch(0.42_0.012_238/0.07)] hover:text-foreground sm:h-7 sm:text-[12px]"
        >
          Clear
        </button>
      )}
    </>
  );
}

/** A trailing `in:` or `from:` being typed, to complete into a filter. */
function pendingFilter(text: string): { kind: FilterKind; needle: string; start: number } | null {
  const match = /(^|\s)(in|from):(\S*)$/u.exec(text);
  if (!match) return null;
  return { kind: match[2] as FilterKind, needle: match[3].replace(/^[#@]/u, "").toLowerCase(),
    start: match.index + match[1].length };
}

type DialogRow =
  | { key: string; kind: "recent"; request: SearchRequest }
  | { key: string; kind: "filter-in-clear" }
  | { key: string; kind: "filter-from-clear" }
  | { key: string; kind: "filter-in"; channel: ChannelSnapshot }
  | { key: string; kind: "filter-from"; author: SearchAuthor; detail: string }
  | { key: string; kind: "destination"; view: AppView; label: string }
  | { key: string; kind: "directory"; result: ReturnType<typeof buildWorkspaceSearchResults>[number] }
  | { key: string; kind: "message"; hit: MessageSearchHit }
  | { key: string; kind: "page"; hit: PageSearchHit }
  | { key: string; kind: "more" };

type DialogSection = { title?: string; rows: DialogRow[] };

/** How many of the ranked rows Jev reads; the rest keep their place after them. */
const RERANK_CANDIDATE_LIMIT = 20;

type RankedRow = { row: DialogRow; rank: SearchRank };

/** A row as Jev reads it: what it is, the title shown and one line about it. */
function rerankCandidate(row: DialogRow, channelById: Map<string, ChannelSnapshot>): SearchRerankCandidate {
  const clip = (text: string, limit: number) => text.trim().slice(0, limit);
  if (row.kind === "destination") return { key: row.key, kind: "place in the app", title: row.label };
  if (row.kind === "directory") {
    return { key: row.key, kind: row.result.kind === "channel" ? "conversation" : row.result.kind,
      title: clip(row.result.title, 300) || row.result.kind, detail: clip(row.result.subtitle, 400) };
  }
  if (row.kind === "message") {
    return { key: row.key, kind: "message", title: clip(row.hit.snippet, 300) || "Message",
      detail: clip(`${row.hit.senderLabel} in ${hitChannelLabel(row.hit, channelById)}`, 400) };
  }
  if (row.kind === "page") {
    return { key: row.key, kind: "page section", title: clip(row.hit.blockTitle || row.hit.title, 300) || "Page",
      detail: clip(row.hit.snippet, 400) };
  }
  return { key: row.key, kind: row.kind, title: row.key };
}

/** Authors `from:` can name: the Space's people and its Agents. */
function searchAuthors(space: SerializedSpace | undefined, agents: readonly SerializedAgent[]):
  Array<{ author: SearchAuthor; detail: string; searchable: string }> {
  const people = (space?.members ?? []).map((member) => {
    const label = member.name?.trim() || member.handle?.trim() || member.email?.trim() || member.userId;
    return {
      author: { kind: "user" as const, userId: member.userId, label },
      detail: member.handle ? `@${member.handle}` : member.email ?? "",
      searchable: [member.name, member.handle, member.email].filter(Boolean).join(" ").toLowerCase(),
    };
  });
  const seenAgents = new Set<string>();
  const agentAuthors = agents.flatMap((agent) => {
    if (seenAgents.has(agent.name)) return [];
    seenAgents.add(agent.name);
    return [{ author: { kind: "agent" as const, name: agent.name, label: agent.name }, detail: "Agent",
      searchable: agent.name.toLowerCase() }];
  });
  return [...people, ...agentAuthors];
}

export const WorkspaceSearchDialog = memo(function WorkspaceSearchDialog({
  open,
  initialFilters,
  spaceId,
  channels,
  spaces,
  agents: catalogAgents,
  realtimeAgents,
  projects,
  machineDaemons,
  pages = [],
  searchMessages,
  searchPages,
  searchRerank,
  catalogPaging,
  onSelectChannel,
  onSelectMessage,
  onSelectPage,
  onSelectMember,
  onChangeView,
  onCancel,
}: {
  open: boolean;
  /** Where ⌘F was pressed: the conversation it is scoped to. */
  initialFilters: SearchFilters;
  spaceId: string | null;
  channels: ChannelSnapshot[];
  spaces: SerializedSpace[];
  agents: SerializedAgent[];
  realtimeAgents?: RealtimeCollection<SerializedAgent>;
  projects: SerializedWorkspace[];
  machineDaemons: SerializedMachineDaemon[];
  pages?: readonly PageSummary[];
  searchMessages?: WorkspaceMessageSearch;
  searchPages?: (query: string) => Promise<{ results: PageSearchHit[] }>;
  /** Jev's reordering of the first results; Pro Spaces only. */
  searchRerank?: WorkspaceSearchRerank;
  catalogPaging: SpaceChannelCatalog;
  onSelectChannel: (channelId: string) => void;
  onSelectMessage: (channelId: string, messageId: string) => void;
  onSelectPage: (pageId: string, blockId?: string) => void;
  onSelectMember: (userId: string, spaceId?: string) => void;
  onChangeView: (view: AppView) => void;
  onCancel: () => void;
}) {
  const { user } = useAuth();
  const userId = user?.id;
  // Subscribe only the open picker; Agent discovery must not require a shell
  // render or an obsolete agent_list roster on the Hub.
  const subscribeAgents = useCallback((notify: () => void) =>
    open && realtimeAgents ? realtimeAgents.subscribe(notify) : () => {}, [open, realtimeAgents]);
  const agents = useSyncExternalStore(subscribeAgents,
    open && realtimeAgents ? realtimeAgents.getSnapshot : () => catalogAgents, () => catalogAgents);
  const [text, setText] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(initialFilters);
  const [picker, setPicker] = useState<FilterKind | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pickerInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initialKey = searchRequestKey({ text: "", ...initialFilters });

  useEffect(() => {
    if (!open) return;
    setText("");
    const scope = searchRequestFromParams(new URLSearchParams(initialKey));
    setFilters({ channel: scope.channel, from: scope.from });
    setPicker(null);
    setPickerQuery("");
    setActiveIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [initialKey, open]);
  useEffect(() => { setActiveIndex(0); }, [text, filters, picker, pickerQuery]);

  const pending = pendingFilter(text);
  const activeFilterKind = picker ?? pending?.kind ?? null;
  const activeFilterNeedle = picker
    ? pickerQuery.trim().replace(/^[#@]/u, "").toLowerCase()
    : pending?.needle ?? "";
  const searchText = pending ? text.slice(0, pending.start).trim() : text.trim();
  const request: SearchRequest = { text: searchText, ...filters };
  const scoped = searchHasFilters(filters);
  const messages = useMessageSearch(searchMessages, request, open && !pending);
  const pageHits = usePageSearch(searchPages, searchText, open && !pending && !scoped);
  useCatalogSearch(open && !scoped, searchText, catalogPaging);
  const space = spaces.find((item) => item.id === spaceId);
  const channelById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);

  const closePicker = useCallback((refocus = true) => {
    setPicker(null);
    setPickerQuery("");
    if (refocus) window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const togglePicker = useCallback((kind: FilterKind) => {
    if (picker === kind) {
      closePicker(true);
      return;
    }
    setPicker(kind);
    setPickerQuery("");
    window.requestAnimationFrame(() => pickerInputRef.current?.focus());
  }, [closePicker, picker]);

  const removeFilter = useCallback((kind: FilterKind) => {
    setFilters((current) => kind === "in"
      ? { ...current, channel: undefined }
      : { ...current, from: undefined });
    if (picker === kind) {
      setPicker(null);
      setPickerQuery("");
    }
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [picker]);

  const clearAllFilters = useCallback(() => {
    setFilters({});
    setPicker(null);
    setPickerQuery("");
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const directory = useMemo(() => open && !scoped && searchText
    ? buildWorkspaceSearchResults({
        query: searchText, channels: channels.filter((channel) => !spaceId || channel.spaceId === spaceId),
        spaces: space ? [space] : [], agents, projects, machineDaemons, events: [] as ObservabilityEvent[],
        messages: [], pages,
      }).filter((result) => result.kind !== "message" && result.kind !== "event" && result.kind !== "space")
    : [], [agents, channels, machineDaemons, open, pages, projects, scoped, searchText, space, spaceId]);

  // One list ranked by match and recency (`workspace-search-rank.ts`); the
  // icon on each row says what kind of thing it is. On Pro, Jev then reorders
  // the first of them once the reader pauses.
  const rankedRows = useMemo(() => {
    if (pending || !searchIsRunnable(request)) return [];
    const pageUpdatedAt = new Map(pages.map((page) => [page.pageId, page.updatedAt]));
    return rankSearchResults<RankedRow>([
      ...matchingSearchDestinations(searchText).map((destination) => ({
        row: { key: `view:${destination.view}`, kind: "destination" as const, view: destination.view,
          label: destination.label },
        rank: { tier: searchMatchTier(searchText, destination.label), activityMs: 0 } })),
      ...directory.map((item) => ({ row: { key: item.id, kind: "directory" as const, result: item },
        rank: item.rank })),
      ...messages.hits.map((hit) => ({ row: { key: `message:${hit.entityId}`, kind: "message" as const, hit },
        rank: { tier: 3 as const, activityMs: searchActivityMs(hit.sentAt) } })),
      ...pageHits.filter((hit) => hit.field === "body").map((hit) => ({
        row: { key: `page:${hit.pageId}:${hit.blockId}`, kind: "page" as const, hit },
        rank: { tier: 3 as const, activityMs: searchActivityMs(pageUpdatedAt.get(hit.pageId)) } })),
    ], (item) => item.rank);
    // `request` is rebuilt every render; its parts are the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, filters, messages.hits, pageHits, pages, pending, searchText]);
  const rerankCandidates = useMemo(() => rankedRows.slice(0, RERANK_CANDIDATE_LIMIT)
    .map((item) => rerankCandidate(item.row, channelById)), [channelById, rankedRows]);
  const rerankReading = useSearchRerank(searchRerank, searchText, rerankCandidates, open && !pending && !scoped);

  const sections = useMemo<DialogSection[]>(() => {
    if (activeFilterKind) {
      if (activeFilterKind === "in") {
        const filterRows: DialogRow[] = [];
        if (picker && filters.channel && !activeFilterNeedle) {
          filterRows.push({ key: "in:clear", kind: "filter-in-clear" });
        }
        filterRows.push(...channels
          .filter((channel) => (!spaceId || channel.spaceId === spaceId)
            && channelTitle(channel).toLowerCase().includes(activeFilterNeedle))
          .slice(0, 12)
          .map((channel) => ({ key: `in:${channel.id}`, kind: "filter-in" as const, channel })));
        return filterRows.length ? [{ title: "Search in", rows: filterRows }] : [];
      }
      const filterRows: DialogRow[] = [];
      if (picker && filters.from && !activeFilterNeedle) {
        filterRows.push({ key: "from:clear", kind: "filter-from-clear" });
      }
      filterRows.push(...searchAuthors(space, agents)
        .filter((item) => item.searchable.includes(activeFilterNeedle))
        .slice(0, 12)
        .map((item) => ({ key: `from:${searchAuthorParam(item.author)}`, kind: "filter-from" as const,
          author: item.author, detail: item.detail })));
      return filterRows.length ? [{ title: "From", rows: filterRows }] : [];
    }
    if (!searchIsRunnable(request)) {
      const recent = readRecentSearches({ userId, spaceId });
      return recent.length ? [{ title: "Recent", rows: recent.map((item) => ({
        key: `recent:${searchRequestKey(item)}`, kind: "recent" as const, request: item })) }] : [];
    }
    const ranked = applySearchRerank(rankedRows, (item) => item.row.key, (item) => item.rank.tier, rerankReading);
    const rows: DialogRow[] = ranked.map((item) => item.row);
    if (messages.more) rows.push({ key: "more", kind: "more" });
    return rows.length ? [{ rows }] : [];
    // `request` is rebuilt every render; its parts are the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilterKind, activeFilterNeedle, agents, channels, filters, messages.more, picker, rankedRows, rerankReading, searchText, space, spaceId, userId]);

  const rows = sections.flatMap((section) => section.rows);
  useLayoutEffect(() => {
    scrollActiveCommandResultIntoView(rowRefs.current[activeIndex]);
  }, [activeIndex, rows.length]);

  const choose = (row: DialogRow) => {
    if (row.kind === "more") return messages.loadMore();
    if (row.kind === "recent") {
      setFilters({ channel: row.request.channel, from: row.request.from });
      setText(row.request.text);
      closePicker(true);
      return;
    }
    if (row.kind === "filter-in-clear") {
      removeFilter("in");
      return;
    }
    if (row.kind === "filter-from-clear") {
      removeFilter("from");
      return;
    }
    if (row.kind === "filter-in" || row.kind === "filter-from") {
      setFilters((current) => row.kind === "filter-in"
        ? { ...current, channel: { id: row.channel.id, label: channelTitle(row.channel) } }
        : { ...current, from: row.author });
      if (picker) {
        closePicker(true);
      } else {
        setText(pending ? text.slice(0, pending.start) : text);
        inputRef.current?.focus();
      }
      return;
    }
    rememberRecentSearch({ userId, spaceId }, request);
    if (row.kind === "destination") return onChangeView(row.view);
    if (row.kind === "message") return onSelectMessage(row.hit.channelId, row.hit.messageId);
    if (row.kind === "page") return onSelectPage(row.hit.pageId, row.hit.blockId || undefined);
    const item = row.result;
    if (item.kind === "page" && item.pageId) return onSelectPage(item.pageId, item.blockId);
    if (item.kind === "member" && item.userId) return onSelectMember(item.userId, item.spaceId);
    if (item.kind === "agent") return onChangeView("agents");
    if (item.kind === "machine") return onChangeView("machines");
    if (item.channelId) onSelectChannel(item.channelId);
  };

  const runnable = !activeFilterKind && searchIsRunnable(request);
  const status = runnable
    ? messages.status === "loading" ? "Searching messages…"
      : messages.status === "unavailable" ? "Message search is unavailable right now."
        : undefined
    : undefined;

  const pickerHeader = picker ? (
    <div
      className="mb-0.5 flex h-9 items-center gap-3 shadow-[inset_0_-1px_0_oklch(0.42_0.012_238/0.08)]"
      style={{ paddingInline: "calc(var(--app-search-panel-column) - 0.5rem - var(--app-search-panel-gutter))" }}
    >
      {picker === "in"
        ? <Hash className="size-4 shrink-0 text-muted-foreground" />
        : <AtSign className="size-4 shrink-0 text-muted-foreground" />}
      <input
        ref={pickerInputRef}
        type="text"
        value={pickerQuery}
        onChange={(event) => setPickerQuery(event.target.value)}
        onKeyDown={(event) => {
          if (isImeKeyDown(event.nativeEvent)) return;
          if (event.key === "ArrowDown" && rows.length > 0) {
            event.preventDefault();
            setActiveIndex((activeIndex + 1) % rows.length);
          } else if (event.key === "ArrowUp" && rows.length > 0) {
            event.preventDefault();
            setActiveIndex(activeIndex === 0 ? rows.length - 1 : activeIndex - 1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            const row = rows[activeIndex] ?? rows[0];
            if (row) choose(row);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closePicker(true);
          }
        }}
        data-workspace-search-filter-input=""
        placeholder={picker === "in" ? "Filter conversations…" : "Filter people and agents…"}
        aria-label={picker === "in" ? "Filter conversations" : "Filter people and agents"}
        className="app-search-panel-input min-w-0 flex-1 text-[16px]! sm:text-[13px]!"
      />
      {pickerQuery && (
        <button
          type="button"
          aria-label="Clear filter search"
          onClick={() => {
            setPickerQuery("");
            pickerInputRef.current?.focus();
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  ) : undefined;

  let index = -1;
  return (
    <SearchPanel
      open={open}
      title="Search workspace"
      query={text}
      inputRef={inputRef}
      placeholder={scoped ? "Search here" : `Search ${space?.name ?? "this Space"}`}
      emptyLabel={activeFilterKind
        ? activeFilterKind === "in" ? "No conversation by that name" : "Nobody by that name"
        : runnable ? status ?? "No results"
          : "Search messages, pages, conversations and people."}
      activeIndex={activeIndex}
      resultCount={rows.length}
      filters={
        <SearchFilterBar
          filters={filters}
          activeKind={activeFilterKind}
          onToggle={togglePicker}
          onRemove={removeFilter}
          onClearAll={clearAllFilters}
        />
      }
      resultsHeader={pickerHeader}
      onRemoveLastFilter={scoped ? () => setFilters((current) => current.from
        ? { ...current, from: undefined } : { ...current, channel: undefined }) : undefined}
      onInputFocus={() => {
        if (picker) closePicker(false);
      }}
      onQueryChange={(next) => {
        if (picker) closePicker(false);
        setText(next);
      }}
      onActiveIndexChange={setActiveIndex}
      onEscape={picker ? () => closePicker(true) : onCancel}
      onCancel={onCancel}
      onSubmit={() => {
        const row = rows[activeIndex] ?? rows[0];
        if (row) choose(row);
      }}
    >
      {sections.map((section, sectionIndex) => (
        <div key={section.title ?? `section-${sectionIndex}`} role="group" aria-label={section.title}>
          {section.title && (
            <div className="app-search-panel-section text-muted-foreground">
              {section.title}
            </div>
          )}
          {section.rows.map((row) => {
            index += 1;
            const rowIndex = index;
            const common = {
              refCallback: (node: HTMLButtonElement | null) => { rowRefs.current[rowIndex] = node; },
              active: rowIndex === activeIndex,
              onMouseEnter: () => setActiveIndex(rowIndex),
              onSelect: () => choose(row),
            };
            if (row.kind === "more") {
              return <SearchResultRow key={row.key} {...common} icon={Clock}
                title={messages.loadingMore ? "Reading older messages…" : "Search older messages"}
                subtitle={searchRequestLabel(request)} />;
            }
            if (row.kind === "recent") {
              return <SearchResultRow key={row.key} {...common} icon={Clock}
                title={searchRequestLabel(row.request)} subtitle="Recent search" />;
            }
            if (row.kind === "filter-in-clear") {
              return <SearchResultRow key={row.key} {...common} icon={X}
                title="All conversations" subtitle="Remove channel filter" />;
            }
            if (row.kind === "filter-from-clear") {
              return <SearchResultRow key={row.key} {...common} icon={X}
                title="Anyone" subtitle="Remove sender filter" />;
            }
            if (row.kind === "filter-in") {
              return <SearchResultRow key={row.key} {...common} icon={Hash}
                selected={filters.channel?.id === row.channel.id}
                title={`#${channelTitle(row.channel)}`} subtitle="Search only this conversation" />;
            }
            if (row.kind === "filter-from") {
              return <SearchResultRow key={row.key} {...common} icon={AtSign}
                selected={Boolean(filters.from && searchAuthorParam(filters.from) === searchAuthorParam(row.author))}
                title={row.author.label} subtitle={row.detail || "Only their messages"} />;
            }
            if (row.kind === "destination") {
              return <SearchResultRow key={row.key} {...common} icon={ArrowRight}
                title={row.label} subtitle="Open" />;
            }
            if (row.kind === "message") {
              return <SearchResultRow key={row.key} {...common} icon={MessageSquare}
                title={<Highlighted text={row.hit.snippet.trim() || "Attachment"} needle={searchText} />}
                subtitle={[row.hit.senderLabel, hitChannelLabel(row.hit, channelById), row.hit.sentAt ? relativeTime(row.hit.sentAt) : ""]
                  .filter(Boolean).join(" · ")} />;
            }
            if (row.kind === "page") {
              return <SearchResultRow key={row.key} {...common} icon={FileText}
                title={<Highlighted text={row.hit.snippet.trim() || row.hit.title} needle={searchText} />}
                subtitle={row.hit.blockTitle ? `${row.hit.title} · ${row.hit.blockTitle}` : row.hit.title} />;
            }
            return <SearchResultRow key={row.key} {...common} icon={searchResultIcon(row.result.kind)}
              title={<Highlighted text={row.result.title} needle={searchText} />} subtitle={row.result.subtitle} />;
          })}
        </div>
      ))}
      {status && rows.length > 0 && (
        <div className="app-search-panel-status text-muted-foreground" role="status">{status}</div>
      )}
    </SearchPanel>
  );
});
