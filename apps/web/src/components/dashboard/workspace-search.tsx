"use client";

/**
 * Search in a Space, reached by ⌘F or a search control. The panel that drops
 * from that control is where a search starts: it opens a place by name, previews the first messages and pages,
 * and its first row opens every result on the search page. Pressed inside a
 * conversation, ⌘F starts with `in:` that conversation; Backspace takes it off.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, AtSign, Clock, FileText, Hash, MessageSquare, Search, X } from "lucide-react";
import type {
  MessageSearchHit,
  ObservabilityEvent,
  PageSearchHit,
  PageSummary,
  SerializedAgent,
  SerializedChannel,
  SerializedMachineDaemon,
  SerializedSpace,
  SerializedWorkspace,
} from "@xmatrix/protocol";
import { cn } from "@/lib/utils";
import { channelTitle } from "@/components/dashboard/channel-links";
import { useCatalogSearch } from "./workspace-shell-chrome";
import { SearchPanel, SearchResultRow } from "./workspace-search-panel";
import { buildWorkspaceSearchResults, scrollActiveCommandResultIntoView, searchResultIcon } from "./workspace-shell-helpers-extra";
import type { WorkspaceMessageSearch } from "./workspace-shell-helpers";
import type { SpaceChannelCatalog } from "./use-channel-catalog-paging";
import type { AppView } from "./workspace-shell-navigation";
import { relativeTime } from "./workspace-shell-presence";
import { ToolDetail, ToolDetailSection, ToolPaper } from "./tool-split";
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

function hitChannelLabel(hit: MessageSearchHit, channelById: Map<string, SerializedChannel>): string {
  const channel = channelById.get(hit.channelId);
  return channel ? `#${channelTitle(channel)}` : "a conversation";
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="app-search-chip inline-flex shrink-0 items-center gap-0.5 text-[13px] font-semibold">
      {label}
      <button type="button" aria-label={`Remove ${label}`} onClick={onRemove}
        className="flex size-4 items-center justify-center text-muted-foreground hover:text-foreground">
        <X className="size-3" />
      </button>
    </span>
  );
}

function filterChips(filters: SearchFilters, onChange: (filters: SearchFilters) => void) {
  if (!searchHasFilters(filters)) return null;
  return (
    <>
      {filters.channel && (
        <FilterChip label={`in #${filters.channel.label}`}
          onRemove={() => onChange({ ...filters, channel: undefined })} />
      )}
      {filters.from && (
        <FilterChip label={`from ${filters.from.label}`}
          onRemove={() => onChange({ ...filters, from: undefined })} />
      )}
    </>
  );
}

/** A trailing `in:` or `from:` being typed, to complete into a filter. */
function pendingFilter(text: string): { kind: "in" | "from"; needle: string; start: number } | null {
  const match = /(^|\s)(in|from):(\S*)$/u.exec(text);
  if (!match) return null;
  return { kind: match[2] as "in" | "from", needle: match[3].replace(/^[#@]/u, "").toLowerCase(),
    start: match.index + match[1].length };
}

type DialogRow =
  | { key: string; kind: "all" }
  | { key: string; kind: "recent"; request: SearchRequest }
  | { key: string; kind: "filter-in"; channel: SerializedChannel }
  | { key: string; kind: "filter-from"; author: SearchAuthor; detail: string }
  | { key: string; kind: "destination"; view: AppView; label: string }
  | { key: string; kind: "directory"; result: ReturnType<typeof buildWorkspaceSearchResults>[number] }
  | { key: string; kind: "message"; hit: MessageSearchHit }
  | { key: string; kind: "page"; hit: PageSearchHit };

type DialogSection = { title?: string; rows: DialogRow[] };

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

export function WorkspaceSearchDialog({
  open,
  initialFilters,
  spaceId,
  channels,
  spaces,
  agents,
  projects,
  machineDaemons,
  pages = [],
  searchMessages,
  searchPages,
  catalogPaging,
  onOpenResults,
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
  channels: SerializedChannel[];
  spaces: SerializedSpace[];
  agents: SerializedAgent[];
  projects: SerializedWorkspace[];
  machineDaemons: SerializedMachineDaemon[];
  pages?: readonly PageSummary[];
  searchMessages?: WorkspaceMessageSearch;
  searchPages?: (query: string) => Promise<{ results: PageSearchHit[] }>;
  catalogPaging: SpaceChannelCatalog;
  onOpenResults: (request: SearchRequest) => void;
  onSelectChannel: (channelId: string) => void;
  onSelectMessage: (channelId: string, messageId: string) => void;
  onSelectPage: (pageId: string, blockId?: string) => void;
  onSelectMember: (userId: string, spaceId?: string) => void;
  onChangeView: (view: AppView) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(initialFilters);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initialKey = searchRequestKey({ text: "", ...initialFilters });

  useEffect(() => {
    if (!open) return;
    setText("");
    const scope = searchRequestFromParams(new URLSearchParams(initialKey));
    setFilters({ channel: scope.channel, from: scope.from });
    setActiveIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [initialKey, open]);
  useEffect(() => { setActiveIndex(0); }, [text, filters]);

  const pending = pendingFilter(text);
  const searchText = pending ? text.slice(0, pending.start).trim() : text.trim();
  const request: SearchRequest = { text: searchText, ...filters };
  const scoped = searchHasFilters(filters);
  const messages = useMessageSearch(searchMessages, request, open && !pending);
  const pageHits = usePageSearch(searchPages, searchText, open && !pending && !scoped);
  useCatalogSearch(open && !scoped, searchText, catalogPaging);
  const space = spaces.find((item) => item.id === spaceId);
  const channelById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);

  const directory = useMemo(() => open && !scoped && searchText
    ? buildWorkspaceSearchResults({
        query: searchText, channels: channels.filter((channel) => !spaceId || channel.spaceId === spaceId),
        spaces: space ? [space] : [], agents, projects, machineDaemons, events: [] as ObservabilityEvent[],
        messages: [], pages,
      }).filter((result) => result.kind !== "message" && result.kind !== "event" && result.kind !== "space")
    : [], [agents, channels, machineDaemons, open, pages, projects, scoped, searchText, space, spaceId]);

  const sections = useMemo<DialogSection[]>(() => {
    if (pending) {
      if (pending.kind === "in") {
        return [{ title: "Search in", rows: channels
          .filter((channel) => (!spaceId || channel.spaceId === spaceId)
            && channelTitle(channel).toLowerCase().includes(pending.needle))
          .slice(0, 8)
          .map((channel) => ({ key: `in:${channel.id}`, kind: "filter-in" as const, channel })) }];
      }
      return [{ title: "From", rows: searchAuthors(space, agents)
        .filter((item) => item.searchable.includes(pending.needle))
        .slice(0, 8)
        .map((item) => ({ key: `from:${searchAuthorParam(item.author)}`, kind: "filter-from" as const,
          author: item.author, detail: item.detail })) }];
    }
    if (!searchIsRunnable(request)) {
      const recent = readRecentSearches(spaceId);
      return recent.length ? [{ title: "Recent", rows: recent.map((item) => ({
        key: `recent:${searchRequestKey(item)}`, kind: "recent" as const, request: item })) }] : [];
    }
    const result: DialogSection[] = [{ rows: [{ key: "all", kind: "all" }] }];
    const goTo: DialogRow[] = [
      ...matchingSearchDestinations(searchText).map((destination) => ({
        key: `view:${destination.view}`, kind: "destination" as const, view: destination.view, label: destination.label })),
      ...directory.map((item) => ({ key: item.id, kind: "directory" as const, result: item })),
    ].slice(0, 5);
    if (goTo.length) result.push({ title: "Go to", rows: goTo });
    if (messages.hits.length) {
      result.push({ title: "Messages", rows: messages.hits.slice(0, 5).map((hit) => ({
        key: `message:${hit.entityId}`, kind: "message" as const, hit })) });
    }
    const bodyHits = pageHits.filter((hit) => hit.field === "body").slice(0, 3);
    if (bodyHits.length) {
      result.push({ title: "In pages", rows: bodyHits.map((hit) => ({
        key: `page:${hit.pageId}:${hit.blockId}`, kind: "page" as const, hit })) });
    }
    return result;
    // `request` is rebuilt every render; its parts are the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, channels, directory, filters, messages.hits, pageHits, pending, searchText, space, spaceId]);

  const rows = sections.flatMap((section) => section.rows);
  useLayoutEffect(() => {
    scrollActiveCommandResultIntoView(rowRefs.current[activeIndex]);
  }, [activeIndex, rows.length]);

  const openResults = (next: SearchRequest) => {
    rememberRecentSearch(spaceId, next);
    onOpenResults(next);
  };

  const choose = (row: DialogRow) => {
    if (row.kind === "all") return openResults(request);
    if (row.kind === "recent") return openResults(row.request);
    if (row.kind === "filter-in" || row.kind === "filter-from") {
      setFilters((current) => row.kind === "filter-in"
        ? { ...current, channel: { id: row.channel.id, label: channelTitle(row.channel) } }
        : { ...current, from: row.author });
      setText(pending ? text.slice(0, pending.start) : text);
      inputRef.current?.focus();
      return;
    }
    if (row.kind === "destination") return onChangeView(row.view);
    if (row.kind === "message") {
      rememberRecentSearch(spaceId, request);
      return onSelectMessage(row.hit.channelId, row.hit.messageId);
    }
    if (row.kind === "page") return onSelectPage(row.hit.pageId, row.hit.blockId || undefined);
    const item = row.result;
    if (item.kind === "page" && item.pageId) return onSelectPage(item.pageId, item.blockId);
    if (item.kind === "member" && item.userId) return onSelectMember(item.userId, item.spaceId);
    if (item.kind === "agent") return onChangeView("agents");
    if (item.kind === "machine") return onChangeView("machines");
    if (item.channelId) onSelectChannel(item.channelId);
  };

  const scopeLabel = searchRequestLabel({ text: "", ...filters });
  const status = !pending && searchIsRunnable(request)
    ? messages.status === "loading" ? "Searching messages…"
      : messages.status === "unavailable" ? "Message search is unavailable right now."
        : undefined
    : undefined;

  let index = -1;
  return (
    <SearchPanel
      open={open}
      title="Search workspace"
      query={text}
      inputRef={inputRef}
      placeholder={scoped ? "Search here" : `Search ${space?.name ?? "this Space"}`}
      emptyLabel={pending
        ? pending.kind === "in" ? "No conversation by that name" : "Nobody by that name"
        : "Search messages, pages, conversations and people. Type in: or from: to narrow it."}
      activeIndex={activeIndex}
      resultCount={rows.length}
      chips={filterChips(filters, setFilters)}
      onRemoveLastChip={scoped ? () => setFilters((current) => current.from
        ? { ...current, from: undefined } : { ...current, channel: undefined }) : undefined}
      onQueryChange={setText}
      onActiveIndexChange={setActiveIndex}
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
            if (row.kind === "all") {
              return <SearchResultRow key={row.key} {...common} icon={Search}
                title={searchText ? `Search for “${searchText}”` : `Everything ${scopeLabel}`}
                subtitle={scoped ? scopeLabel : `Every message and page in ${space?.name ?? "this Space"}`}
                hint="↵" />;
            }
            if (row.kind === "recent") {
              return <SearchResultRow key={row.key} {...common} icon={Clock}
                title={searchRequestLabel(row.request)} subtitle="Recent search" />;
            }
            if (row.kind === "filter-in") {
              return <SearchResultRow key={row.key} {...common} icon={Hash}
                title={`#${channelTitle(row.channel)}`} subtitle="Search only this conversation" />;
            }
            if (row.kind === "filter-from") {
              return <SearchResultRow key={row.key} {...common} icon={AtSign}
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
}

/**
 * Every result of one search, on paper. Its address names the search, so it
 * can be shared and Back returns to it.
 */
export function WorkspaceSearchView({
  request,
  spaceName,
  channels,
  pages = [],
  searchMessages,
  searchPages,
  onChangeRequest,
  onEditSearch,
  onSelectChannel,
  onSelectMessage,
  onSelectPage,
}: {
  request: SearchRequest;
  spaceName: string;
  channels: SerializedChannel[];
  pages?: readonly PageSummary[];
  searchMessages?: WorkspaceMessageSearch;
  searchPages?: (query: string) => Promise<{ results: PageSearchHit[] }>;
  onChangeRequest: (request: SearchRequest) => void;
  onEditSearch: () => void;
  onSelectChannel: (channelId: string) => void;
  onSelectMessage: (channelId: string, messageId: string) => void;
  onSelectPage: (pageId: string, blockId?: string) => void;
}) {
  const runnable = searchIsRunnable(request);
  const scoped = searchHasFilters(request);
  const messages = useMessageSearch(searchMessages, request, runnable);
  const pageHits = usePageSearch(searchPages, request.text, runnable && !scoped);
  const channelById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const text = request.text.trim();
  const needle = text.toLowerCase();
  const channelHits = !scoped && needle
    ? channels.filter((channel) => channelTitle(channel).toLowerCase().includes(needle)).slice(0, 8) : [];
  const titledPages = !scoped && needle
    ? pages.filter((page) => page.title.toLowerCase().includes(needle)).slice(0, 8) : [];
  const bodyPageHits = pageHits.filter((hit) => hit.field === "body");
  const pageRows = [
    ...titledPages.map((page) => ({ key: `title:${page.pageId}`, pageId: page.pageId, blockId: undefined,
      title: page.title, detail: "Page" })),
    ...bodyPageHits.map((hit) => ({ key: `body:${hit.pageId}:${hit.blockId}`, pageId: hit.pageId,
      blockId: hit.blockId || undefined, title: hit.snippet.trim() || hit.title,
      detail: hit.blockTitle ? `${hit.title} · ${hit.blockTitle}` : hit.title })),
  ];

  return (
    <ToolPaper label="Search">
      {/* The wood bar names the destination, not the search, so the query stays on a phone too. */}
      <div className="app-search-paper contents">
      <ToolDetail
        context={<span>Search in {spaceName}</span>}
        title={
          <button type="button" onClick={onEditSearch} className="app-search-title text-left hover:opacity-80">
            {text ? `“${text}”` : "Everything"}
          </button>
        }
        status={scoped ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {filterChips(request, (filters) => onChangeRequest({ text: request.text, ...filters }))}
          </div>
        ) : undefined}
      >
        {!runnable && <p className="text-sm text-muted-foreground">Press ⌘F to search.</p>}
        {(channelHits.length > 0 || pageRows.length > 0) && (
          <div className="mb-8 grid gap-8 md:grid-cols-2">
            {pageRows.length > 0 && (
              <ToolDetailSection title={`Pages · ${pageRows.length}`}>
                <div className="flex flex-col">
                  {pageRows.map((row) => (
                    <button key={row.key} type="button" onClick={() => onSelectPage(row.pageId, row.blockId)}
                      className="app-search-result-row flex min-w-0 items-start gap-2.5 py-2 text-left">
                      <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold"><Highlighted text={row.title} needle={text} /></span>
                        <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </ToolDetailSection>
            )}
            {channelHits.length > 0 && (
              <ToolDetailSection title={`Conversations · ${channelHits.length}`}>
                <div className="flex flex-col">
                  {channelHits.map((channel) => (
                    <button key={channel.id} type="button" onClick={() => onSelectChannel(channel.id)}
                      className="app-search-result-row flex min-w-0 items-center gap-2.5 py-2 text-left">
                      <Hash className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate text-sm font-semibold">
                        <Highlighted text={channelTitle(channel)} needle={text} />
                      </span>
                    </button>
                  ))}
                </div>
              </ToolDetailSection>
            )}
          </div>
        )}
        {runnable && (
          <ToolDetailSection title={messages.hits.length ? `Messages · ${messages.hits.length}${messages.more ? "+" : ""}` : "Messages"}>
            {messages.status === "loading" && <p className="py-2 text-sm text-muted-foreground">Searching…</p>}
            {messages.status === "unavailable" && (
              <p className="py-2 text-sm text-destructive" role="alert">Message search is unavailable right now.</p>
            )}
            {messages.status === "ready" && messages.hits.length === 0 && !messages.more && (
              <p className="py-2 text-sm text-muted-foreground">No messages match.</p>
            )}
            <div className="flex flex-col">
              {messages.hits.map((hit) => (
                <button key={hit.entityId} type="button" onClick={() => onSelectMessage(hit.channelId, hit.messageId)}
                  className="app-search-result-row flex min-w-0 flex-col gap-0.5 py-2.5 text-left">
                  <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate font-semibold text-foreground">{hit.senderLabel || "Someone"}</span>
                    <span className="truncate">{hitChannelLabel(hit, channelById)}</span>
                    {hit.sentAt && <span className="shrink-0">· {relativeTime(hit.sentAt)}</span>}
                  </span>
                  <span className={cn("line-clamp-2 text-sm leading-5", hit.field !== "body" && "text-muted-foreground")}>
                    <Highlighted text={hit.snippet.trim() || "Attachment"} needle={text} />
                  </span>
                </button>
              ))}
            </div>
            {messages.more && (
              <button type="button" onClick={messages.loadMore} disabled={messages.loadingMore}
                className="mt-2 text-sm font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60">
                {messages.loadingMore ? "Reading older messages…" : "Search older messages"}
              </button>
            )}
          </ToolDetailSection>
        )}
      </ToolDetail>
      </div>
    </ToolPaper>
  );
}
