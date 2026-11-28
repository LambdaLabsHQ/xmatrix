"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type ChannelSnapshot, type PageLinkAnchor, type PageOverview, type PageResult,
  type PageResultKind, type PageSummary, type PageTreeAgent } from "@xmatrix/protocol";
import { ArrowUp, Check, ChevronRight, CircleCheck, Flag, LayoutDashboard, LineChart, Loader2, PenLine, Rocket,
  TriangleAlert, Wrench, type LucideIcon } from "lucide-react";

import { ContentSkeleton, useEmptySurfaceSkeleton } from "@/components/dashboard/content-skeleton";
import { Face } from "@/components/dashboard/face";
import { mobileChatTimeLabel } from "@/components/dashboard/time-display";
import { nornRequestMetadata, nornRequestWords, postNornRequest, takesWords,
  type NornRequestMetadata } from "@/components/dashboard/norn-request-card";
import { actionClass } from "@/components/ui/action-tone";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { statusChipClass, statusInkClass } from "@/components/ui/status-tone";
import { useAuth } from "@/lib/auth-context";
import { pageApi, type WaitingRequest } from "@/lib/pages/page-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { userErrorMessage } from "@/lib/user-facing-error";
import { cn } from "@/lib/utils";
import { commentBody, commentTaker } from "./page-comment";
import { OVERVIEW_RANGE_LABEL, OVERVIEW_RANGES, OVERVIEW_TITLE, overviewAttentionKey, overviewKept, overviewLists,
  overviewSeenThrough, overviewTreeKey, overviewWaits, resultAgent, resultKey, type OverviewHandled,
  type OverviewRange } from "./page-overview-model";

/**
 * The Overview (docs/design/pages-overview.md): what the reader has to handle
 * in this Space and what happened while they were away, in place of a page.
 * It is a board, not a document: a strip of controls, then what to handle
 * beside what happened, every item handled where it stands.
 */

export interface PageOverviewProps {
  spaceId: string;
  token: string;
  layout: "desktop" | "phone";
  pages: readonly PageSummary[];
  /** The Agents live on each page, as the page tree knows them. */
  agentsOnPages: ReadonlyMap<string, readonly PageTreeAgent[]>;
  /** The harnesses the Space can call, for a reply that names one. */
  harnesses: readonly string[];
  /** The Space's conversations this client holds, with what waits on the reader in each. */
  channels: readonly ChannelSnapshot[];
  restricted: (pageId: string) => boolean;
  onOpenSection: (pageId: string, blockId: string | null) => void;
  onOpenConversation: (conversationId: string, messageId?: string) => void;
  onMarkDone: (conversationId: string) => void;
  onSend: (channel: ChannelSnapshot, body: string) => Promise<string | null>;
  conversation: (conversationId: string) => ChannelSnapshot | null;
  onResolveConversation: (conversationId: string) => Promise<ChannelSnapshot | null>;
  onDiscuss: (input: { spaceId: string; pageId: string; blockId: string; name: string; restricted: boolean;
    anchor?: PageLinkAnchor; firstMessage?: string; open?: boolean; planned?: (conversationId: string) => void;
    existing?: ChannelSnapshot }) => Promise<unknown>;
}

const NO_REQUESTS: WaitingRequest[] = [];
const EMPTY_OVERVIEW: PageOverview = { seenAt: null, results: [], handled: [] };

/** The reader's Overview of a Space, read again whenever a page's head or summary moves. */
export function usePageOverview(spaceId: string | null, token: string, pages: readonly PageSummary[] | undefined) {
  const { user } = useAuth();
  const treeKey = useMemo(() => overviewTreeKey(pages ?? []), [pages]);
  return useQuery<PageOverview>({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-overview", [spaceId, treeKey]),
    enabled: Boolean(spaceId && token && user?.id && pages), placeholderData: keepPreviousData,
    queryFn: ({ signal }) => pageApi.overview(spaceId!, token, signal),
  });
}

/** The open requests the reader holds in a Space, read again whenever what waits on them in its conversations changes. */
export function useWaitingRequests(spaceId: string | null, token: string, channels: readonly ChannelSnapshot[]) {
  const { user } = useAuth();
  const attentionKey = useMemo(() => overviewAttentionKey(channels), [channels]);
  return useQuery<WaitingRequest[]>({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-overview-requests", [spaceId, attentionKey]),
    enabled: Boolean(spaceId && token && user?.id), placeholderData: keepPreviousData,
    queryFn: ({ signal }) => pageApi.waitingRequests(spaceId!, token, signal),
  });
}

/** How many things the reader has left to handle: what waits on them, and the problems they have not dealt with. */
export function overviewLeft(overview: PageOverview | undefined, requests: readonly WaitingRequest[] | undefined,
  channels: readonly ChannelSnapshot[], now: Date): { needs: number; problems: number } {
  return { needs: (requests?.length ?? 0) + overviewWaits(channels, requests ?? []).length,
    problems: overview ? overviewLists(overview, "away", now).problems.length : 0 };
}

const KIND: Record<PageResultKind, { icon: LucideIcon; word: string; ink: string }> = {
  shipped: { icon: Rocket, word: "Shipped", ink: "text-[oklch(0.5_0.12_155)]" },
  fixed: { icon: Wrench, word: "Fixed", ink: "text-[oklch(0.5_0.12_155)]" },
  decided: { icon: Flag, word: "Decided", ink: "text-foreground" },
  number: { icon: LineChart, word: "Numbers", ink: "text-[oklch(45%_0.11_255)]" },
  problem: { icon: TriangleAlert, word: "Problem", ink: "text-destructive" },
};

/** A range as its tab names it: short enough that the four stand in the narrow column beside what to handle. */
const RANGE_TAB: Record<OverviewRange, string> = { away: "New", today: "Today", yesterday: "Yesterday", week: "Week" };

const harnessOf = (address: string) => address.split(":")[0]!;
const requestKey = (item: { card: NornRequestMetadata }) => item.card.ref;
const channelKey = (channel: ChannelSnapshot) => channel.id;

function AgentFace({ address }: { address: string }) {
  return <Face of={{ kind: "agent", name: address, harness: harnessOf(address) }} size="xs" shape="circle" glass={false}
    showKindBadge={false} className="shrink-0" />;
}

function Heading({ title, count, tone, note, children }: { title: string; count: number; tone?: "attention" | "alert";
  note?: string; children?: ReactNode }) {
  return (
    <div className="mt-6 mb-2 flex min-w-0 items-baseline justify-between gap-3 first:mt-3">
      <h2 className={cn("text-[15px] font-extrabold tracking-tight", tone === "attention" && statusInkClass("attention"),
        tone === "alert" && "text-destructive")}>
        {title}<span className="ml-1.5 font-medium text-muted-foreground tabular-nums">{count}</span>
      </h2>
      {children ?? (note ? <span className="truncate text-[13px] text-muted-foreground">{note}</span> : null)}
    </div>
  );
}

/** A line of the reader's own words, written where the thing they answer stands. */
function Write({ placeholder, busy, onSend, onCancel, face }: { placeholder: string; busy: boolean;
  onSend: (text: string) => void; onCancel: () => void; face?: ReactNode }) {
  const [words, setWords] = useState("");
  const text = words.trim();
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2 rounded-full bg-background/70 py-1 pr-1 pl-3">
      {face}
      <input autoFocus value={words} disabled={busy} placeholder={placeholder} aria-label={placeholder}
        onChange={(event) => setWords(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && text) { event.preventDefault(); onSend(text); }
          if (event.key === "Escape") onCancel();
        }}
        className="h-7 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm outline-none placeholder:text-muted-foreground" />
      <button type="button" title="Send" aria-label="Send" disabled={busy || !text} onClick={() => onSend(text)}
        className={actionClass({ variant: "primary", size: "icon-sm" }, "rounded-full")}>
        {busy ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <ArrowUp className="size-4" />}
      </button>
    </div>
  );
}

/**
 * A list the reader works through: what they handle here stays where it stood, as a receipt of what they
 * did, for as long as they stay. It counts as handled, no longer as left.
 */
function useWorked<Item>(current: readonly Item[], keyOf: (item: Item) => string) {
  const [handled, setHandled] = useState<ReadonlyMap<string, OverviewHandled<Item> & { receipt: ReactNode }>>(() => new Map());
  const rows = useMemo(() => overviewKept(current, keyOf, handled), [current, keyOf, handled]);
  const handle = (item: Item, receipt: ReactNode) => setHandled((before) => {
    const key = keyOf(item);
    if (before.has(key)) return before;
    const at = rows.findIndex((row) => keyOf(row) === key);
    return new Map(before).set(key, { item, after: at > 0 ? keyOf(rows[at - 1]!) : null, receipt });
  });
  return { rows, handled, handle, left: rows.length - handled.size };
}

const Strong = ({ children }: { children: ReactNode }) => <b className="font-semibold text-foreground">{children}</b>;

/** What the reader did with an item, in the item's place. */
function Receipt({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm text-muted-foreground" data-testid="overview-receipt">
      <CircleCheck className="size-4 shrink-0 text-[oklch(0.5_0.12_155)]" aria-hidden="true" />
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

const rowClass = "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 rounded-xl px-3 py-2 hover:bg-foreground/[0.045]";

/** One request that waits on the reader: what is asked, and its answers on the row itself. */
function RequestRow({ request, channelId, pageName, token, userId, onAnswered }: { request: NornRequestMetadata;
  channelId: string; pageName: string | null; token: string; userId: string; onAnswered: (text: string) => void }) {
  const fetch = useXMatrixQueryFetch(userId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState<string | null>(null);
  const choices = request.verb === "confirm" ? ["Yes", "No"] : request.verb === "choose" ? request.options : [];
  const { asked } = nornRequestWords(request.text);
  const answer = async (text: string) => {
    setBusy(true);
    setError(null);
    try {
      const refusal = await postNornRequest(fetch, token, WEB_PROXY_ROUTES.channel_norn_request_answer(channelId, request.ref),
        { outcome: "answered", text });
      if (refusal) setError(refusal);
      else onAnswered(text);
    } catch (cause) {
      setError(userErrorMessage(cause, "Couldn't send your answer"));
    } finally {
      setBusy(false);
    }
  };
  const closes = request.by ? mobileChatTimeLabel(request.by) : null;
  return (
    <div className={rowClass} data-testid="overview-request">
      <div className="min-w-0">
        <p className="text-[15.5px] leading-snug font-semibold [overflow-wrap:anywhere]">{asked}</p>
        {writing === null ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {choices.map((choice, index) => (
              <button key={choice} type="button" disabled={busy}
                onClick={() => (takesWords(choice) ? setWriting(choice) : void answer(choice))}
                className={actionClass({ variant: index === 0 ? "primary" : "secondary", size: "sm" })}>{choice}</button>
            ))}
            <button type="button" disabled={busy} onClick={() => setWriting("")}
              className={actionClass({ variant: "quiet", size: "sm" })}><PenLine className="size-3.5" />Write…</button>
          </div>
        ) : (
          <Write placeholder={writing ? "Complete the option you picked" : "Write your answer…"} busy={busy}
            onSend={(text) => void answer(writing ? `${writing} ${text}` : text)} onCancel={() => setWriting(null)} />
        )}
        {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      <div className="flex flex-col items-end gap-1.5 pt-0.5 text-[12.5px] whitespace-nowrap text-muted-foreground">
        {closes ? <span className={statusChipClass("attention")} title={`Closes ${new Date(request.by!).toLocaleString()}`}>{closes}</span>
          : <span className={statusChipClass("settled")}>Waiting</span>}
        <span className="flex items-center gap-1.5">
          {request.asker && <AgentFace address={request.asker} />}{request.asker ?? pageName ?? "A program"}
        </span>
      </div>
    </div>
  );
}

/** A conversation whose message waits on the reader: answered in a line, opened, or marked done. */
function WaitRow({ channel, onOpen, onDone, onReply }: { channel: ChannelSnapshot; onOpen: () => void; onDone: () => void;
  onReply: (body: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = channel.attention?.lastMessage;
  return (
    <div className={rowClass} data-testid="overview-wait">
      <div className="min-w-0">
        <p className="line-clamp-2 text-[15.5px] leading-snug font-semibold [overflow-wrap:anywhere]">
          {waiting?.bodyPreview || channel.name}
        </p>
        {writing ? (
          <Write placeholder={`Reply to ${waiting?.from.label ?? "them"}…`} busy={busy} onCancel={() => setWriting(false)}
            onSend={(text) => {
              setBusy(true);
              setError(null);
              void onReply(text).catch((cause: unknown) => setError(userErrorMessage(cause, "Couldn't send the message")))
                .finally(() => setBusy(false));
            }} />
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={onOpen} className={actionClass({ variant: "primary", size: "sm" })}>Open</button>
            <button type="button" onClick={onDone} className={actionClass({ variant: "secondary", size: "sm" })}>Done</button>
            <button type="button" onClick={() => setWriting(true)} className={actionClass({ variant: "quiet", size: "sm" })}>
              <PenLine className="size-3.5" />Write…</button>
          </div>
        )}
        {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      <div className="flex flex-col items-end gap-1.5 pt-0.5 text-[12.5px] whitespace-nowrap text-muted-foreground">
        <span className={statusChipClass("settled")}>{mobileChatTimeLabel(waiting?.sentAt ?? channel.attention?.lastAttentionAt)}</span>
        <span className="flex max-w-40 items-center gap-1.5 truncate">
          {waiting?.from.kind === "agent" && <AgentFace address={waiting.from.label} />}{waiting?.from.label ?? channel.name}
        </span>
      </div>
    </div>
  );
}

function ResultIcon({ kind, className }: { kind: PageResultKind; className?: string }) {
  const Icon = KIND[kind].icon;
  return <Icon className={cn("mt-[3px] shrink-0", KIND[kind].ink, className)} aria-hidden="true" />;
}

function ResultMeta({ result }: { result: PageResult }) {
  const agent = resultAgent(result);
  return (
    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[12.5px] text-muted-foreground">
      <span className="truncate">{result.title}{result.block ? ` › ${result.block.title}` : ""}</span>
      {agent && <><span aria-hidden="true">·</span><AgentFace address={agent} /><span>{agent}</span></>}
      <span aria-hidden="true">·</span><span className="tabular-nums">{mobileChatTimeLabel(result.createdAt)}</span>
    </p>
  );
}

/** A problem: answered in a line that goes to whoever made the change, or checked off. */
function ProblemRow({ result, onOpen, onReply, onGotIt }: { result: PageResult; onOpen: () => void;
  onReply: (text: string) => Promise<void>; onGotIt: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = resultAgent(result);
  const act = (work: Promise<void>) => {
    setBusy(true);
    setError(null);
    void work.catch((cause: unknown) => setError(userErrorMessage(cause, "Couldn't send the message"))).finally(() => setBusy(false));
  };
  return (
    <div className={cn(rowClass, "grid-cols-[1.5rem_minmax(0,1fr)_auto]")} data-testid="overview-problem">
      <ResultIcon kind="problem" className="size-[17px]" />
      <div className="min-w-0">
        <button type="button" onClick={onOpen} className="block text-left text-[15px] leading-normal [overflow-wrap:anywhere]">
          {result.text}
        </button>
        <ResultMeta result={result} />
        {replying && (
          <Write placeholder={agent ? `Tell ${agent} what to do…` : "Say what should happen…"} busy={busy}
            face={agent ? <AgentFace address={agent} /> : undefined} onCancel={() => setReplying(false)}
            onSend={(text) => act(onReply(text))} />
        )}
        {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      <div className="flex items-center gap-2 pl-2">
        {!replying && <button type="button" disabled={busy} onClick={() => setReplying(true)}
          className={actionClass({ variant: "quiet", size: "sm" })}>Reply</button>}
        <button type="button" disabled={busy} title="Got it" aria-label="Got it"
          onClick={() => act(onGotIt())}
          className={actionClass({ variant: "secondary", size: "icon-sm" }, "rounded-full")}><Check className="size-4" /></button>
      </div>
    </div>
  );
}

export function PageOverviewView({ spaceId, token, layout, pages, agentsOnPages, harnesses, channels, restricted, onOpenSection,
  onOpenConversation, onMarkDone, onSend, conversation, onResolveConversation, onDiscuss }: PageOverviewProps) {
  const { user } = useAuth();
  const userId = user?.id ?? "";
  const phone = layout === "phone";
  const queryClient = useQueryClient();
  const overviewQuery = usePageOverview(spaceId, token, pages);
  const requestsQuery = useWaitingRequests(spaceId, token, channels);
  // Where the reader stood when the Overview opened. What is new stays new for the whole visit, though
  // turning away from the tab already records it as seen.
  const [stood, setStood] = useState<{ seenAt: string | null } | null>(null);
  if (!stood && overviewQuery.data) setStood({ seenAt: overviewQuery.data.seenAt });
  const overview = useMemo(() => {
    const read = overviewQuery.data ?? EMPTY_OVERVIEW;
    return stood && stood.seenAt !== read.seenAt ? { ...read, seenAt: stood.seenAt } : read;
  }, [overviewQuery.data, stood]);
  const requests = requestsQuery.data ?? NO_REQUESTS;
  const [range, setRange] = useState<OverviewRange>("away");
  // The reader's day does not move while they look: the lists keep their order under their hands.
  const [now] = useState(() => new Date());
  const lists = useMemo(() => overviewLists(overview, range, now), [overview, range, now]);
  const waits = useMemo(() => overviewWaits(channels, requests), [channels, requests]);
  const cards = useMemo(() => requests.flatMap((item) => {
    const card = nornRequestMetadata({ nornRequest: item.card });
    return card ? [{ ...item, card }] : [];
  }), [requests]);
  const asked = useWorked(cards, requestKey);
  const waiting = useWorked(waits, channelKey);
  const problems = useWorked(lists.problems, resultKey);
  const handled = asked.handled.size + waiting.handled.size + problems.handled.size;
  const needs = asked.left + waiting.left;
  const left = needs + problems.left;
  // Both lists are read again once something is handled: the count on the Overview's row in the list follows.
  const refresh = () => void queryClient.invalidateQueries({ predicate: ({ queryKey }) => queryKey.includes(spaceId)
    && (queryKey.includes("page-overview") || queryKey.includes("page-overview-requests")) });

  // Leaving the Overview, or the tab it is in, moves how far the reader has seen to the newest result it showed.
  const read = overviewQuery.data;
  const shown = useRef<PageOverview | undefined>(read);
  useEffect(() => { shown.current = read; }, [read]);
  useEffect(() => {
    let marked: string | null = null;
    const mark = () => {
      const through = shown.current ? overviewSeenThrough(shown.current.seenAt, shown.current.results) : null;
      if (!through || through === marked) return;
      marked = through;
      void pageApi.markOverviewSeen(spaceId, token, through).then(() => queryClient.invalidateQueries({
        predicate: ({ queryKey }) => queryKey.includes("page-overview") && queryKey.includes(spaceId) }), () => undefined);
    };
    const turnedAway = () => { if (document.visibilityState === "hidden") mark(); };
    document.addEventListener("visibilitychange", turnedAway);
    return () => {
      document.removeEventListener("visibilitychange", turnedAway);
      mark();
    };
  }, [queryClient, spaceId, token]);

  const reply = async (result: PageResult, text: string) => {
    const blockId = result.block?.id ?? "";
    const live = [...(agentsOnPages.get(result.pageId) ?? [])];
    const author = resultAgent(result);
    const taker = commentTaker(live.filter((agent) => agent.name === author), blockId, (id) => Boolean(conversation(id)))
      ?? commentTaker(live, blockId, (id) => Boolean(conversation(id)));
    const origin = result.conversationIds.length === 1 ? result.conversationIds[0] : undefined;
    // No Agent is at work on the page: the reply calls one of the kind that made the change.
    const called = !taker && !origin && author && harnesses.includes(harnessOf(author)) ? `@${harnessOf(author)} ${text}` : text;
    const { body, taker: named, conversationId } = commentBody(called, harnesses, taker, live, origin);
    const target = named?.conversationId ?? conversationId;
    const home = target ? conversation(target) ?? await onResolveConversation(target) : null;
    let started = home?.id ?? null;
    await onDiscuss({ spaceId, pageId: result.pageId, blockId,
      name: result.block ? `${result.title} › ${result.block.title}` : result.title, restricted: restricted(result.pageId),
      firstMessage: body, open: false, planned: (id) => { started = id; }, ...(home ? { existing: home } : {}) });
    await pageApi.markResultHandled(spaceId, token, { pageId: result.pageId, revision: result.revision,
      ...(started ? { conversationId: started } : {}) });
    problems.handle(result, <>Sent to <Strong>{named?.name ?? author ?? "an Agent"}</Strong></>);
    refresh();
  };
  const gotIt = async (result: PageResult) => {
    await pageApi.markResultHandled(spaceId, token, { pageId: result.pageId, revision: result.revision });
    problems.handle(result, "Got it");
    refresh();
  };

  const loading = overviewQuery.isLoading || requestsQuery.isLoading;
  const skeleton = useEmptySurfaceSkeleton(loading);
  // A problem answered on this visit stands as its receipt above; it is in motion from the next visit on.
  const moving = lists.moving.filter(({ result }) => !problems.handled.has(resultKey(result)));
  const todo = (
    <div className="min-w-0" data-testid="overview-todo">
      {skeleton && <ContentSkeleton label="Loading overview" lines={5} className="mt-4" />}
      {asked.rows.length + waiting.rows.length > 0 && (
        <section>
          <Heading title="Needs you" count={needs} tone={needs > 0 ? "attention" : undefined} />
          <div className="app-paper-card app-ask-card w-full p-1.5" data-ask-card="open">
            {asked.rows.map((item) => asked.handled.has(item.card.ref)
              ? <Receipt key={item.card.ref}>{asked.handled.get(item.card.ref)!.receipt}</Receipt>
              : <RequestRow key={item.card.ref} request={item.card} channelId={item.channelId} pageName={item.pageName}
                token={token} userId={userId}
                onAnswered={(text) => { asked.handle(item, <>You answered <Strong>{text}</Strong></>); refresh(); }} />)}
            {waiting.rows.map((channel) => waiting.handled.has(channel.id)
              ? <Receipt key={channel.id}>{waiting.handled.get(channel.id)!.receipt}</Receipt>
              : <WaitRow key={channel.id} channel={channel}
                onOpen={() => onOpenConversation(channel.id, channel.attention?.lastMessageId)}
                onDone={() => { waiting.handle(channel, <>Marked <Strong>{channel.name}</Strong> done</>); onMarkDone(channel.id); }}
                onReply={async (body) => {
                  if (await onSend(channel, body) === null) throw new Error("The message was not confirmed");
                  waiting.handle(channel, <>You replied in <Strong>{channel.name}</Strong></>);
                  onMarkDone(channel.id);
                }} />)}
          </div>
        </section>
      )}
      {problems.rows.length > 0 && (
        <section>
          <Heading title="Problems" count={problems.left} tone={problems.left > 0 ? "alert" : undefined}
            note="reply to send it back, or check it off" />
          <div className="-mx-3">
            {problems.rows.map((result) => problems.handled.has(resultKey(result))
              ? <Receipt key={resultKey(result)}>{problems.handled.get(resultKey(result))!.receipt}</Receipt>
              : <ProblemRow key={resultKey(result)} result={result}
                onOpen={() => onOpenSection(result.pageId, result.block?.id ?? null)}
                onReply={(text) => reply(result, text)} onGotIt={() => gotIt(result)} />)}
          </div>
        </section>
      )}
      {!loading && left === 0 && (
        <div className="mt-3 flex items-start gap-3 rounded-2xl bg-foreground/[0.04] px-5 py-4 text-sm text-muted-foreground"
          data-testid="overview-clear">
          <CircleCheck className="size-6 shrink-0 text-[oklch(0.5_0.12_155)]" aria-hidden="true" />
          <p><b className="block text-base text-foreground">Nothing left to handle.</b>
            New things show up here as your Agents ask or run into trouble.</p>
        </div>
      )}
      {moving.length > 0 && (
        <section>
          <Heading title="In motion" count={moving.length} note="the answers come back here" />
          <div className="-mx-3">
            {moving.map(({ result, conversationId }) => (
              <button key={resultKey(result)} type="button" onClick={() => onOpenConversation(conversationId)}
                className={cn(rowClass, "w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] text-left")} data-testid="overview-moving">
                <ResultIcon kind="problem" className="size-[17px] text-muted-foreground" />
                <span className="min-w-0"><span className="block text-[15px] leading-normal">{result.text}</span><ResultMeta result={result} /></span>
                <ChevronRight className="mt-1 size-4 text-muted-foreground" aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
  const happened = (
    <section className="min-w-0" data-testid="overview-happened">
      <Heading title="Happened" count={lists.happened.length} note="nothing to do" />
      <SegmentedTabs label="Time range" value={range} onChange={setRange} className="mb-2"
        items={OVERVIEW_RANGES.map((key) => ({ key, label: RANGE_TAB[key], title: OVERVIEW_RANGE_LABEL[key] }))} />
      <div className="-mx-2">
        {lists.happened.map((result) => (
          <button key={resultKey(result)} type="button" onClick={() => onOpenSection(result.pageId, result.block?.id ?? null)}
            title={`${KIND[result.kind].word} · ${result.title}${result.block ? ` › ${result.block.title}` : ""}`}
            className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start rounded-[10px] px-2 py-1.5 text-left hover:bg-foreground/[0.045]"
            data-testid="overview-result">
            <ResultIcon kind={result.kind} className="size-[15px]" />
            <span className="line-clamp-2 text-sm leading-normal">{result.text}</span>
            <span className="pl-2.5 text-[12.5px] leading-[21px] text-muted-foreground tabular-nums">{mobileChatTimeLabel(result.createdAt)}</span>
          </button>
        ))}
      </div>
      {skeleton && overviewQuery.isLoading && <ContentSkeleton label="Loading what happened" lines={4} className="mt-2" />}
      {!overviewQuery.isLoading && lists.happened.length === 0 && (
        <p className="px-0.5 py-2 text-sm text-muted-foreground">
          {range === "away" && overview.seenAt ? "Nothing new since you last looked." : "Nothing in this range."}
        </p>
      )}
    </section>
  );

  const total = handled + left;
  const strip = (
    <div className="flex min-w-0 flex-1 items-center gap-3 text-sm" data-testid="overview-strip">
      {!phone && (
        <span className="inline-flex items-center gap-1.5 text-[17px] font-extrabold tracking-tight">
          <LayoutDashboard className="size-[17px]" aria-hidden="true" />{OVERVIEW_TITLE}
        </span>
      )}
      <span className="ml-auto inline-flex items-center gap-3 text-[13.5px] text-muted-foreground">
        {left === 0 ? (
          <span className="inline-flex items-center gap-1.5 font-bold text-[oklch(0.45_0.12_155)]">
            <CircleCheck className="size-[17px]" aria-hidden="true" />All caught up
          </span>
        ) : (
          <span className="font-semibold whitespace-nowrap text-foreground" data-testid="overview-left">
            <b className={cn("mr-1 text-[19px] font-extrabold tracking-tight", statusInkClass("attention"))}>{left}</b>to handle
          </span>
        )}
        {!phone && (
          <span className="h-1.5 w-40 overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
            <span className="block h-full rounded-full bg-foreground transition-[width] duration-500"
              style={{ width: `${total ? Math.round((handled / total) * 100) : 0}%` }} />
          </span>
        )}
        {!phone && <span className="whitespace-nowrap tabular-nums">{handled} handled</span>}
      </span>
    </div>
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="pages-overview">
      {!phone && (
        <div className="app-page-band shrink-0 px-6 lg:px-12">
          <header className="app-band-header mx-auto flex w-full max-w-[1040px] items-center">{strip}</header>
        </div>
      )}
      <div className={phone ? "app-mobile-page-article min-h-0 min-w-0 flex-1 overflow-y-auto px-6 pb-32"
        : "app-page-article @container min-h-0 min-w-0 flex-1 overflow-y-auto px-6 pb-24 lg:px-12"}>
        {/* Two columns where the surface has the width for both; under that, one, as on a phone. */}
        <div className={cn("mx-auto w-full max-w-[1040px]", !phone
          && "items-start gap-x-9 @[760px]:grid @[760px]:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]")}>
          {phone && <div className="flex h-10 items-center">{strip}</div>}
          {todo}
          {happened}
        </div>
      </div>
    </div>
  );
}
