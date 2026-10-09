"use client";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronDown,
  Clock,
  FileText,
  History,
  Loader2,
  MessageSquare,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { ChannelMessage } from "@xmatrix/protocol";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { actionClass } from "@/components/ui/action-tone";
import { noticeClass } from "@/components/ui/status-tone";
import { cn } from "@/lib/utils";
import {
  buildAgentChannelMessageTraceStream,
  buildAgentConversationTraceTimeline,
  buildAgentTraceHeaderStatus,
  buildAgentTraceStatusFallback,
  type AgentTraceTimelineBlock,
  type AgentTraceTimelineField,
  type AgentTraceTimelineItem,
} from "./agent-trace-stream";
import { visibleAgentTraceReplicasForHistoryReads, type AgentTraceReplica } from "./agent-trace-replica";
import { agentTraceHistoryStatusCopy, type AgentTraceHistoryReadState } from "./agent-trace-on-demand";
import { CenteredDialogShell, DialogButton } from "./centered-dialog-shell";
import { RichMessageContent } from "./workspace-shell-rich-message";
import { AGENT_BUSY_TRACE_STALE_MS } from "./workspace-shell-constants";
import { tagsFromUsage, traceBlockText, traceFieldValue, traceToolPreviewText } from "./workspace-shell-formatters";
import { avatarInitials, formatTime, isOlderThan, relativeTime, shortId, traceUsage } from "./workspace-shell-recovered";
import {
  TagRow,
  agentTraceGroupsForTarget,
  type AgentTraceHistoryPanelState,
  type AgentTraceTarget,
} from "./workspace-composer-dialogs";

/** Rows mounted on open and added per reveal; older loaded rows wait above. */
const TRACE_RENDER_STEP = 80;
/** Within this distance of the bottom the view follows new output. */
const TRACE_PIN_THRESHOLD_PX = 32;
/** Scrolling this close to the top reveals (or fetches) earlier steps. */
const TRACE_REVEAL_THRESHOLD_PX = 240;

type AgentTraceRow =
  | { kind: "group"; key: string; label: string }
  | { kind: "item"; key: string; item: AgentTraceTimelineItem };

export const AgentInstanceDetailWindow = memo(function AgentInstanceDetailWindow({
  target,
  traceReplicas,
  traceHistoryState,
  history,
  channelId,
  onLoadOlder,
  onClose,
}: {
  target: AgentTraceTarget;
  traceReplicas: AgentTraceReplica[];
  traceHistoryState: AgentTraceHistoryPanelState | null;
  history: ChannelMessage[];
  channelId?: string | null;
  onLoadOlder: (state: AgentTraceHistoryPanelState | null) => void;
  onClose: () => void;
}) {
  // A burst of live pages may land while someone scrolls or types elsewhere;
  // rebuilding the timeline yields to that input instead of blocking it.
  const deferredReplicas = useDeferredValue(traceReplicas);
  const traceChannelId = target.channelId || channelId || undefined;
  const reads = traceHistoryState?.reads;

  const trace = useMemo(() => {
    const visibleReplicas = visibleAgentTraceReplicasForHistoryReads(deferredReplicas, reads || []);
    const groups = agentTraceGroupsForTarget(visibleReplicas, target, traceChannelId);
    const events = groups
      .flatMap((group) => group.events)
      .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
    const timelineGroups = groups
      .map((group) => ({
        key: group.key,
        label: group.label,
        items: buildAgentConversationTraceTimeline([], target, group.events),
      }))
      .filter((group) => group.items.length > 0);
    let latestUsage = null;
    for (let index = events.length - 1; index >= 0 && !latestUsage; index -= 1) {
      latestUsage = traceUsage(events[index]!);
    }
    return {
      groups,
      latestTimestamp: events.at(-1)?.timestamp,
      headerStatus: buildAgentTraceHeaderStatus(events),
      latestUsage: latestUsage || target.usage || null,
      rows: agentTraceRows(timelineGroups),
    };
  }, [deferredReplicas, reads, target, traceChannelId]);

  // Channel messages stand in only while the instance has no trace at all.
  const traceFallbackStream = useMemo(() => {
    if (trace.rows.length > 0) return "";
    return trace.groups
      .map((group) => {
        const body = group.events.length > 0 &&
          buildAgentChannelMessageTraceStream(history, target, group.events[0]?.timestamp);
        if (!body) return "";
        return trace.groups.length > 1 ? `## ${group.label}\n\n${body}` : body;
      })
      .filter(Boolean)
      .join("\n\n");
  }, [history, target, trace]);
  const fallbackStatus = buildAgentTraceStatusFallback(target);
  const latestTraceTimestamp = trace.latestTimestamp;
  const traceStale = target.status === "busy" && isOlderThan(latestTraceTimestamp, AGENT_BUSY_TRACE_STALE_MS);

  const hasOlderTrace = Boolean(reads?.some((read) =>
    read.phase === "available" && typeof read.nextCursor === "string"));
  const olderLoading = Boolean(traceHistoryState?.older?.loading);
  const traceFirstPageLoading = Boolean(reads?.some((read) => read.phase === "loading"));
  const traceReconnecting = Boolean(reads?.some((read) => read.staleSince !== undefined));
  const traceLive = target.status === "busy" && !traceReconnecting &&
    Boolean(reads?.some((read) => read.phase === "available"));
  const traceHistoryNotices = (reads || [])
    .map((state) => ({ state, copy: agentTraceHistoryStatusCopy(state) }))
    .filter((item): item is { state: AgentTraceHistoryReadState; copy: { title: string; detail: string } } =>
      item.copy !== null
    );
  const showTraceHistoryNotice = Boolean(
    traceHistoryState?.missingExactInstance ||
      traceHistoryState?.omittedCount ||
      traceHistoryNotices.length
  );
  const traceHistoryUnavailable = Boolean(
    traceHistoryState?.missingExactInstance ||
      (reads?.length && reads.every((state) =>
        state.phase === "unavailable" || state.phase === "expired" || state.phase === "error"
      ))
  );

  const loadOlder = useCallback(() => onLoadOlder(traceHistoryState), [onLoadOlder, traceHistoryState]);
  const scroll = useAgentTraceScroll({
    rows: trace.rows,
    canLoadOlder: hasOlderTrace && !olderLoading,
    onLoadOlder: loadOlder,
    // Fallback bodies have no rows; they still open at their newest line.
    contentKey: `${traceFallbackStream.length}:${fallbackStatus.length}:${trace.latestUsage ? "usage" : ""}`,
  });

  return (
    <AgentInstanceWindowShell
      target={target}
      busy={false}
      labelledBy="agent-instance-detail-title"
      onClose={onClose}
      scrollRef={scroll.scrollerRef}
      onScroll={scroll.onScroll}
      overlay={scroll.showJumpToLatest ? (
        <button
          type="button"
          onClick={scroll.jumpToLatest}
          className={actionClass(
            { variant: "secondary", size: "sm" },
            "pointer-events-auto rounded-full shadow-md animate-in fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none"
          )}
        >
          <ArrowDown className="size-3.5" />
          New activity
        </button>
      ) : null}
    >
      {showTraceHistoryNotice ? (
        <div className="mx-3 mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <div className="flex items-start gap-2">
            <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="font-bold">Trace history lives on the Agent host</p>
              {traceHistoryState?.missingExactInstance ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  No exact live instance is available for an on-demand history request. Live sync resumes automatically while this detail stays open.
                </p>
              ) : null}
              {traceHistoryNotices.length > 0 ? (
                <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                  {traceHistoryNotices.map(({ state, copy }) => (
                    <li key={state.instanceId}>
                      <span className="font-bold text-foreground">{copy.title}</span>
                      {reads && reads.length > 1 ? ` · ${shortId(state.instanceId)}` : ""}
                      <span> — {copy.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {traceHistoryState?.omittedCount ? (
                <p className="mt-1 text-xs font-medium text-destructive">
                  {traceHistoryState.omittedCount} additional instances exceeded the bounded on-demand request limit and were not queried.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {trace.headerStatus ? (
        <div
          className={noticeClass(
            trace.headerStatus.tone === "error" ? "alert" : "attention",
            "mx-3 mt-3 flex items-start gap-2"
          )}
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-bold">{trace.headerStatus.title}</p>
            {trace.headerStatus.detail ? (
              <p className="text-xs [overflow-wrap:anywhere]">{trace.headerStatus.detail}</p>
            ) : null}
            {trace.headerStatus.tone === "error" && !trace.headerStatus.detail.toLowerCase().includes("resend") ? (
              <p className="text-xs">Resend the last message to retry.</p>
            ) : null}
          </div>
        </div>
      ) : null}
      {traceStale && latestTraceTimestamp ? (
        <div className={noticeClass("attention", "mx-3 mt-3 flex items-start gap-2")}>
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-bold">Trace stale while agent is busy</p>
            <p className="text-xs">
              Last runtime trace event was {relativeTime(latestTraceTimestamp)}. The instance may be stuck even if presence still shows busy.
            </p>
          </div>
        </div>
      ) : null}
      {trace.rows.length > 0 ? (
        <div className="p-3">
          {scroll.hiddenRowCount > 0 ? (
            <div className="mb-3 flex justify-center">
              <DialogButton icon={History} onClick={scroll.revealEarlier}>
                Show earlier steps
              </DialogButton>
            </div>
          ) : hasOlderTrace || traceHistoryState?.older?.error ? (
            <div className="mb-3 flex flex-col items-center gap-1">
              {hasOlderTrace ? (
                <DialogButton icon={History} busy={olderLoading} disabled={olderLoading} onClick={scroll.loadOlder}>
                  Load earlier trace
                </DialogButton>
              ) : null}
              {traceHistoryState?.older?.error ? (
                <p className="text-xs text-muted-foreground">{traceHistoryState.older.error}</p>
              ) : null}
            </div>
          ) : null}
          <AgentTraceTimeline rows={scroll.visibleRows} animateAfter={scroll.animateAfter} />
          {traceReconnecting ? (
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" />
              Reconnecting to the Agent host…
            </p>
          ) : traceLive ? (
            <p className="mt-3 flex items-center gap-2 pl-6.5 text-xs text-muted-foreground">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/30 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-foreground/70" />
              </span>
              Live
            </p>
          ) : null}
          {trace.latestUsage ? <TagRow tags={tagsFromUsage(trace.latestUsage)} className="mt-3" /> : null}
        </div>
      ) : traceFirstPageLoading ? (
        <AgentTraceTimelineSkeleton />
      ) : traceFallbackStream ? (
        <div className="p-4">
          <div className="app-agent-instance-content app-agent-trace-content bg-muted/40 p-4 text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
            <RichMessageContent body={traceFallbackStream} />
          </div>
          {trace.latestUsage ? <TagRow tags={tagsFromUsage(trace.latestUsage)} className="mt-3" /> : null}
        </div>
      ) : fallbackStatus ? (
        <div className="p-4">
          <div className="app-agent-instance-content app-agent-trace-content bg-muted/40 p-4 text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
            <RichMessageContent body={fallbackStatus} />
          </div>
        </div>
      ) : traceHistoryUnavailable ? (
        <p className="p-5 text-sm text-muted-foreground">
          No retained trace history is available from this Agent host. Live events will appear here if the exact instance sends them.
        </p>
      ) : (
        <p className="p-5 text-sm text-muted-foreground">Waiting for agent output.</p>
      )}
    </AgentInstanceWindowShell>
  );
});

function agentTraceRows(
  groups: Array<{ key: string; label: string; items: AgentTraceTimelineItem[] }>
): AgentTraceRow[] {
  const rows: AgentTraceRow[] = [];
  for (const group of groups) {
    if (groups.length > 1) rows.push({ kind: "group", key: `group:${group.key}`, label: group.label });
    agentTraceTimelineItemKeys(group.items).forEach((key, index) => {
      rows.push({ kind: "item", key: `${group.key}|${key}`, item: group.items[index]! });
    });
  }
  return rows;
}

/**
 * Keys follow the item, not its position, so a prepended earlier page does
 * not remount (and re-animate) the steps already on screen.
 */
function agentTraceTimelineItemKeys(items: readonly AgentTraceTimelineItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = `${item.timestamp}:${item.kind}:${item.title}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}:${occurrence}`;
  });
}

type TraceScrollAnchor = { key: string; top: number };

/**
 * Scroll behaviour of a live log: it opens at the newest step, follows new
 * output only while the reader is at the bottom, and otherwise holds the step
 * they are reading still while pages land above or below it (the browser's
 * own scroll anchoring is missing in Safari, so it is done here). Only the
 * newest TRACE_RENDER_STEP rows mount at first; scrolling up reveals the rest
 * a step at a time and then fetches earlier pages from the Agent host.
 */
function useAgentTraceScroll({
  rows,
  canLoadOlder,
  onLoadOlder,
  contentKey,
}: {
  rows: AgentTraceRow[];
  canLoadOlder: boolean;
  onLoadOlder: () => void;
  contentKey: string;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const anchorRef = useRef<TraceScrollAnchor | null>(null);
  const programmaticRef = useRef(false);
  // A smooth jump to the newest step passes through "not at the bottom".
  const jumpingRef = useRef(false);
  const frameRef = useRef(0);
  // null follows the newest rows; a key holds the window's first row in place.
  const [startKey, setStartKey] = useState<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  // Steps present when the first page arrives (and earlier pages loaded
  // later) appear without an entrance; only newer live steps animate in.
  const animateAfterRef = useRef<number | null>(null);
  if (animateAfterRef.current === null && rows.length > 0) animateAfterRef.current = newestRowTimestamp(rows);
  // Set when the reader asks for an earlier page, so it shows once it lands.
  const expandOnPrependRef = useRef(false);

  const pinnedStart = Math.max(0, rows.length - TRACE_RENDER_STEP);
  const heldStart = startKey === null ? -1 : rows.findIndex((row) => row.key === startKey);
  const start = heldStart >= 0 ? Math.min(heldStart, pinnedStart) : pinnedStart;
  const visibleRows = useMemo(() => (start === 0 ? rows : rows.slice(start)), [rows, start]);
  const newestKey = rows.at(-1)?.key;

  const setScrollTop = useCallback((scroller: HTMLDivElement, top: number) => {
    const clamped = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
    // Only a real move fires a scroll event to swallow.
    if (Math.abs(scroller.scrollTop - clamped) < 1) return;
    programmaticRef.current = true;
    scroller.scrollTop = clamped;
  }, []);

  const recordAnchor = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    anchorRef.current = traceScrollAnchor(scroller);
  }, []);

  const stickOrHold = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (pinnedRef.current) {
      setScrollTop(scroller, scroller.scrollHeight);
    } else {
      const anchor = anchorRef.current;
      const element = anchor ? traceRowElement(scroller, anchor.key) : null;
      if (anchor && element) {
        const delta = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top;
        if (Math.abs(delta) >= 0.5) setScrollTop(scroller, scroller.scrollTop + delta);
      }
    }
    recordAnchor();
  }, [recordAnchor, setScrollTop]);

  useLayoutEffect(stickOrHold, [contentKey, stickOrHold, visibleRows]);

  useLayoutEffect(() => {
    if (!expandOnPrependRef.current || heldStart <= 0) return;
    expandOnPrependRef.current = false;
    setStartKey(rows[Math.max(0, heldStart - TRACE_RENDER_STEP)]!.key);
  }, [heldStart, rows]);

  // Streaming output, expanded details and late-loading media change height
  // without a new row; the same rule keeps the view steady through those.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = scroller?.firstElementChild;
    if (!scroller || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => stickOrHold());
    observer.observe(content);
    return () => observer.disconnect();
  }, [stickOrHold]);

  useEffect(() => {
    if (!pinnedRef.current && newestKey) setShowJumpToLatest(true);
  }, [newestKey]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const revealEarlier = useCallback(() => {
    if (start === 0) return;
    pinnedRef.current = false;
    recordAnchor();
    setStartKey(rows[Math.max(0, start - TRACE_RENDER_STEP)]!.key);
  }, [recordAnchor, rows, start]);

  const loadOlder = useCallback(() => {
    expandOnPrependRef.current = true;
    onLoadOlder();
  }, [onLoadOlder]);

  const onScroll = useCallback(() => {
    if (programmaticRef.current) {
      programmaticRef.current = false;
      return;
    }
    // Synchronously, so a resize in the same frame never restores a stale
    // position against the reader's scroll.
    recordAnchor();
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= TRACE_PIN_THRESHOLD_PX;
      if (jumpingRef.current) {
        if (!pinned) return;
        jumpingRef.current = false;
      }
      if (pinned !== pinnedRef.current) {
        pinnedRef.current = pinned;
        // Leaving the bottom freezes the window where the reader is; coming
        // back lets it slide with new output again.
        setStartKey(pinned ? null : rows[start]?.key ?? null);
      }
      if (pinned) setShowJumpToLatest(false);
      if (scroller.scrollTop <= TRACE_REVEAL_THRESHOLD_PX) {
        if (start > 0) revealEarlier();
        else if (canLoadOlder) loadOlder();
      }
    });
  }, [canLoadOlder, loadOlder, recordAnchor, revealEarlier, rows, start]);

  const jumpToLatest = useCallback(() => {
    const scroller = scrollerRef.current;
    pinnedRef.current = true;
    setShowJumpToLatest(false);
    if (start !== pinnedStart) {
      // The window slides back to the newest rows; the layout pass lands on
      // the bottom directly rather than animating across rows being dropped.
      setStartKey(null);
      return;
    }
    setStartKey(null);
    jumpingRef.current = true;
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, [pinnedStart, start]);

  return {
    scrollerRef,
    onScroll,
    visibleRows,
    hiddenRowCount: start,
    revealEarlier,
    showJumpToLatest,
    jumpToLatest,
    animateAfter: animateAfterRef.current ?? Number.POSITIVE_INFINITY,
    loadOlder,
  };
}

function newestRowTimestamp(rows: readonly AgentTraceRow[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "item") return row.item.timestamp;
  }
  return 0;
}

function traceRowElement(scroller: HTMLElement, key: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[data-trace-row="${CSS.escape(key)}"]`);
}

/** The first row still visible at the top, and how far it sits from the edge. */
function traceScrollAnchor(scroller: HTMLElement): TraceScrollAnchor | null {
  const top = scroller.getBoundingClientRect().top;
  for (const element of scroller.querySelectorAll<HTMLElement>("[data-trace-row]")) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom > top) return { key: element.dataset.traceRow || "", top: rect.top - top };
  }
  return null;
}

/** Placeholder rows shaped like trace cards while the first page loads. */
function AgentTraceTimelineSkeleton() {
  return (
    <div className="space-y-3 p-3" role="status" aria-label="Loading trace">
      {["w-2/3", "w-5/6", "w-1/2", "w-3/4"].map((width, index) => (
        <div key={width} className="flex gap-1.5" style={{ opacity: 1 - index * 0.18 }}>
          <span className="mt-0.5 size-5 shrink-0 animate-pulse rounded-md bg-foreground/10" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
            <span className="block h-2.5 w-28 animate-pulse rounded-full bg-foreground/10" />
            <span className={cn("block h-2 animate-pulse rounded-full bg-foreground/10", width)} />
          </span>
        </div>
      ))}
    </div>
  );
}

function AgentTraceTimeline({ rows, animateAfter }: { rows: AgentTraceRow[]; animateAfter: number }) {
  return (
    <div className="space-y-2">
      {rows.map((row) =>
        row.kind === "group" ? (
          <div
            key={row.key}
            data-trace-row={row.key}
            className="flex items-center gap-2 pt-1 text-xs font-black uppercase tracking-wide text-muted-foreground"
          >
            <span className="h-px flex-1 bg-border" />
            <span className="max-w-[70%] truncate">{row.label}</span>
            <span className="h-px flex-1 bg-border" />
          </div>
        ) : (
          <div
            key={row.key}
            data-trace-row={row.key}
            className={cn(
              row.item.timestamp > animateAfter &&
                "animate-in fade-in-0 slide-in-from-bottom-1 duration-300 motion-reduce:animate-none"
            )}
          >
            <AgentTraceTimelineCard item={row.item} />
          </div>
        )
      )}
    </div>
  );
}

/*
 * The timeline is rebuilt as new objects on every change, so cards compare by
 * content: a step that did not change skips its (markdown) render entirely.
 */
function sameTraceItem(
  { item: left }: { item: AgentTraceTimelineItem },
  { item: right }: { item: AgentTraceTimelineItem }
): boolean {
  return left === right || (
    left.timestamp === right.timestamp &&
    left.kind === right.kind &&
    left.title === right.title &&
    left.body === right.body &&
    sameList(left.fields, right.fields, (a, b) => a.label === b.label && a.value === b.value) &&
    sameList(left.blocks, right.blocks, (a, b) => a.label === b.label && a.text === b.text && a.format === b.format)
  );
}

function sameList<T>(left: T[] | undefined, right: T[] | undefined, same: (a: T, b: T) => boolean): boolean {
  if (left === right) return true;
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every((value, index) => same(value, right![index]!));
}

const AgentTraceTimelineCard = memo(function AgentTraceTimelineCard({ item }: { item: AgentTraceTimelineItem }) {
  const Icon = agentTraceTimelineIcon(item.kind);
  const fields = item.fields || [];
  const blocks = item.blocks || [];
  const primary = agentTracePrimaryText(item, fields, blocks);
  const detailBlocks = agentTraceDebugBlocks(blocks);
  const isReasoning = traceFieldValue(fields, "Category") === "reasoning";

  if (item.kind === "output") {
    return (
      <div className="app-agent-instance-content app-agent-trace-content pl-6.5 text-sm leading-7 text-foreground [overflow-wrap:anywhere]">
        <RichMessageContent body={item.body} />
      </div>
    );
  }

  return (
    <div className={cn("group flex gap-1.5 text-sm", agentTraceTimelineClass(item.kind))}>
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground ring-1 ring-border/70">
        <Icon className="size-3" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 leading-5">
          <span className="font-semibold text-foreground">{primary.title}</span>
          {primary.subject ? (
            <code
              title={primary.subject}
              className="min-w-0 max-w-full truncate rounded bg-muted/70 px-1 font-mono text-xs text-foreground"
            >
              {primary.subject}
            </code>
          ) : null}
          {primary.meta ? (
            <span className={cn("text-xs", primary.failed ? "font-semibold text-destructive" : "text-muted-foreground")}>
              {primary.meta}
            </span>
          ) : null}
          <span className="text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            {formatTime(new Date(item.timestamp).toISOString())}
          </span>
        </div>
        {isReasoning && item.body ? (
          <AgentTraceDisclosure label="Show reasoning">
            <div className="app-agent-instance-content app-agent-trace-content mt-1 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
              <RichMessageContent body={item.body} />
            </div>
          </AgentTraceDisclosure>
        ) : primary.output ? (
          <AgentTraceToolOutput output={primary.output} />
        ) : primary.body ? (
          <div className="app-agent-instance-content app-agent-trace-content text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            <RichMessageContent body={primary.body} />
          </div>
        ) : null}
        {detailBlocks.length > 0 ? (
          <AgentTraceDisclosure label="Debug details">
            <div className="mt-1.5 space-y-1.5">
              {detailBlocks.map((block) => (
                <AgentTraceStructuredBlock key={`${block.label}:${block.text.slice(0, 32)}`} block={block} />
              ))}
            </div>
          </AgentTraceDisclosure>
        ) : null}
      </div>
    </div>
  );
}, sameTraceItem);

/** Collapsed until asked for, and mounts its content only once opened. */
function AgentTraceDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex items-center gap-0.5 text-xs font-semibold leading-5 text-muted-foreground hover:text-foreground"
      >
        {label}
        <ChevronDown className={cn("size-3 transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open ? <div className="animate-in fade-in-0 duration-200 motion-reduce:animate-none">{children}</div> : null}
    </div>
  );
}

type AgentTraceToolOutputText = { preview: string; full: string; format: "text" | "diff" };

/**
 * Tool output is terminal text, a file or a patch; markdown would reflow it.
 * It reads as monospace, shows its first lines, and expands in place.
 */
function AgentTraceToolOutput({ output }: { output: AgentTraceToolOutputText }) {
  const [expanded, setExpanded] = useState(false);
  // The preview marks a cut with a trailing "..." line; the toggle says it.
  const canExpand = output.preview.endsWith("\n...");
  const text = expanded ? output.full : canExpand ? output.preview.slice(0, -4) : output.preview;
  return (
    <div className="app-agent-instance-content mt-0.5 overflow-hidden rounded-md border border-border/60 bg-muted/40">
      {output.format === "diff" ? (
        <AgentTraceDiff text={text} />
      ) : (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-2 py-1.5 font-mono text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
          {text}
        </pre>
      )}
      {canExpand ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex w-full items-center justify-center gap-0.5 border-t border-border/60 py-0.5 text-[11px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {expanded ? "Show less" : "Show all"}
          <ChevronDown className={cn("size-3 transition-transform duration-200", expanded && "rotate-180")} />
        </button>
      ) : null}
    </div>
  );
}

function AgentTraceDiff({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="max-h-96 overflow-auto py-1 font-mono text-xs leading-5">
      {lines.map((line, index) => {
        const kind = /^\+(?!\+\+)/u.test(line) ? "added" : /^-(?!--)/u.test(line) ? "removed" : line.startsWith("@@") ? "hunk" : "context";
        return (
          <div
            key={index}
            className={cn(
              "whitespace-pre-wrap px-2 [overflow-wrap:anywhere]",
              kind === "added" && "app-diff-line-added text-foreground",
              kind === "removed" && "app-diff-line-removed text-foreground",
              kind === "hunk" && "text-muted-foreground/70",
              kind === "context" && "text-muted-foreground"
            )}
          >
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

const FAILED_TOOL_STATUSES = new Set(["failed", "error", "errored", "cancelled", "canceled", "declined", "rejected"]);

function agentTracePrimaryText(
  item: AgentTraceTimelineItem,
  fields: AgentTraceTimelineField[],
  blocks: AgentTraceTimelineBlock[]
): {
  title: string;
  subject?: string;
  meta?: string;
  failed?: boolean;
  body?: string;
  output?: AgentTraceToolOutputText;
} {
  if (item.kind === "tool") {
    const tool = traceFieldValue(fields, "Tool") || item.title;
    const command = traceFieldValue(fields, "Command");
    const path = traceFieldValue(fields, "Path");
    const status = traceFieldValue(fields, "Status");
    const exitCode = traceFieldValue(fields, "Exit code");
    const callType = traceFieldValue(fields, "Type");
    const patch = traceBlockText(blocks, "Patch");
    const full = traceBlockText(blocks, "Output") || patch || traceBlockText(blocks, "Changes") ||
      traceBlockText(blocks, "Arguments");
    const [title, subject] = command
      ? ["Ran", command]
      : path && callType === "fileChange"
        ? ["Updated", path]
        : path
          ? [tool, path]
          : [tool, ""];
    const method = traceFieldValue(fields, "Method");
    const summary = traceFieldValue(fields, "Summary");
    const summaryStatus = summary.match(/^tool\s+([^:]+):/i)?.[1];
    const shownStatus = status || summaryStatus || "";
    const meta = [shownStatus, exitCode ? `exit ${exitCode}` : "", !command && callType && callType !== tool ? callType : "", method]
      .filter(Boolean)
      .join(" · ");
    const failed = FAILED_TOOL_STATUSES.has(shownStatus.toLowerCase()) || Boolean(exitCode && exitCode !== "0");
    const preview = traceToolPreviewText(full);
    return {
      title,
      subject,
      meta,
      failed,
      output: preview ? { preview, full, format: full === patch && patch ? "diff" : "text" } : undefined,
    };
  }

  if (item.kind === "input") {
    return { title: "Input", body: item.body };
  }

  if (item.kind === "error" || item.kind === "status") {
    return { title: item.title, body: item.body };
  }

  if (traceFieldValue(fields, "Category") === "reasoning") {
    return {
      title: "Reasoning",
      meta: traceFieldValue(fields, "Status"),
    };
  }

  return {
    title: traceFieldValue(fields, "Summary") || item.title,
    meta: traceFieldValue(fields, "Method"),
    body: traceBlockText(blocks, "Output"),
  };
}

function agentTraceDebugBlocks(blocks: AgentTraceTimelineBlock[]): AgentTraceTimelineBlock[] {
  return blocks.filter((block) => block.format === "json" || block.label === "Raw preview" || block.label === "Metadata");
}

function AgentTraceStructuredBlock({ block }: { block: AgentTraceTimelineBlock }) {
  const content =
    block.format === "json" || block.format === "diff" ? (
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-border/70 bg-background/80 p-1.5 font-mono text-xs leading-4 text-foreground">
        {block.text}
      </pre>
    ) : (
      <div className="app-agent-instance-content app-agent-trace-content rounded border border-border/70 bg-background/80 p-1.5 text-xs leading-5 text-foreground [overflow-wrap:anywhere]">
        <RichMessageContent body={block.text} />
      </div>
    );

  return (
    <section className="space-y-1">
      <div className="text-xs font-black uppercase leading-4 text-muted-foreground">{block.label}</div>
      {content}
    </section>
  );
}

function agentTraceTimelineIcon(kind: AgentTraceTimelineItem["kind"]): ComponentType<{ className?: string }> {
  if (kind === "input") return MessageSquare;
  if (kind === "output") return FileText;
  if (kind === "tool") return Wrench;
  if (kind === "error") return AlertTriangle;
  if (kind === "status") return Check;
  return Terminal;
}

function agentTraceTimelineClass(kind: AgentTraceTimelineItem["kind"]): string {
  /* These are categories, not states, and the app has no colour axis for a
     category. So they map onto the ink tiers by importance: a trace is opened
     to read what the agent *did*, so "tool" keeps the plain ink and every
     other category steps back. */
  if (kind === "tool") return "text-foreground";
  if (kind === "error") return "text-destructive";
  if (kind === "output") return "";
  return "text-muted-foreground";
}

export function AgentInstanceWindowShell({
  target,
  busy,
  labelledBy,
  children,
  onClose,
  scrollRef,
  onScroll,
  overlay,
}: {
  target: AgentTraceTarget;
  busy: boolean;
  labelledBy: string;
  children: ReactNode;
  onClose: () => void;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: () => void;
  /** Floats over the bottom of the scroll area (e.g. "New activity"). */
  overlay?: ReactNode;
}) {
  const headerContext = [target.activity || target.status || "offline", target.gitBranch].filter(Boolean).join(" | ");

  return (
    <CenteredDialogShell
      open
      busy={busy}
      labelledBy={labelledBy}
      overlayClassName="app-agent-instance-overlay"
      panelClassName="app-agent-instance-window flex max-h-[86vh] max-w-3xl flex-col overflow-hidden p-0"
      onCancel={onClose}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <IdentityAvatar
            kind="agent"
            label={target.name}
            status={target.status}
            imageUrl={target.avatarUrl}
            initials={avatarInitials(target.name)}
            size="sm"
          />
          <div className="min-w-0">
            <h2 id={labelledBy} className="truncate text-sm font-black">{target.name}</h2>
            <p className="truncate text-xs text-muted-foreground" title={headerContext}>
              {headerContext}
            </p>
          </div>
        </div>
        <button
          type="button"
          title="Close"
          disabled={busy}
          onClick={onClose}
          className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} onScroll={onScroll} data-agent-instance-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div>{children}</div>
        </div>
        {overlay ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">{overlay}</div>
        ) : null}
      </div>
    </CenteredDialogShell>
  );
}

