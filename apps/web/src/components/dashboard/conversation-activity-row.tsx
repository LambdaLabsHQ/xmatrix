"use client";

import { memo } from "react";
import { ChevronRight, CircleCheck, CircleDashed, GitPullRequest, LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { statusInkClass } from "@/components/ui/status-tone";
import { formatMessageDateTime, formatMessageTimestamp } from "./channel-history";
import { foldSummary, timelineItemActivity } from "./conversation-activity-rows";
import type { TimelineItem } from "./workspace-shell-message-model";

/**
 * One folded run of an Instance's activity and superseded reports
 * (docs/design/conversation-activity.md §4.1): a single line where the run
 * began, opening in place to every entry it stands for.
 */

function Time({ value, className }: { value: string; className?: string }) {
  return (
    <time dateTime={value} title={formatMessageDateTime(value)} className={cn("shrink-0 tabular-nums", className)}>
      {formatMessageTimestamp(value)}
    </time>
  );
}

function entryAnchorId(item: TimelineItem): string | undefined {
  return item.messageId ? `message:${item.messageId}` : undefined;
}

function FoldedEntry({ item }: { item: TimelineItem }) {
  const activity = timelineItemActivity(item);
  if (!activity) {
    return (
      <div className="min-w-0">
        <span className="mr-2 rounded bg-muted px-1 py-px text-[10px] font-bold uppercase tracking-wide">
          superseded
        </span>
        <span className="whitespace-pre-wrap break-words text-foreground/80">{item.body}</span>
      </div>
    );
  }
  if (activity.kind === "pull_request") {
    return (
      <a href={activity.url} target="_blank" rel="noreferrer"
        className="inline-flex min-w-0 items-center gap-1 font-medium text-foreground/80 hover:underline">
        <GitPullRequest className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">Opened {activity.repository}#{activity.number}</span>
      </a>
    );
  }
  return (
    <div className="min-w-0 space-y-0.5">
      {activity.completed.map((step, index) => (
        <div key={`${index}:${step}`} className="flex min-w-0 items-center gap-1.5">
          <CircleCheck className={statusInkClass("settled", "size-3.5 shrink-0")} aria-hidden="true" />
          <span className="truncate">{step}</span>
        </div>
      ))}
      {activity.completed.length === 0 && activity.steps.length > 0 && (
        <ol className="space-y-0.5">
          {activity.steps.map((step, index) => (
            <li key={`${index}:${step.text}`} className="flex min-w-0 items-center gap-1.5">
              {step.status === "completed" ? (
                <CircleCheck className={statusInkClass("settled", "size-3.5 shrink-0")} aria-hidden="true" />
              ) : step.status === "in_progress" ? (
                <LoaderCircle className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <CircleDashed className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">{step.text}</span>
            </li>
          ))}
        </ol>
      )}
      {activity.inProgress && activity.completed.length > 0 && (
        <div className="flex min-w-0 items-center gap-1.5">
          <LoaderCircle className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{activity.inProgress}</span>
        </div>
      )}
    </div>
  );
}

export const FoldedActivityRow = memo(function FoldedActivityRow({
  row,
  expanded,
  onToggle,
}: {
  row: TimelineItem;
  expanded: boolean;
  onToggle: (rowId: string) => void;
}) {
  const items = row.folded ?? [];
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return null;
  const summary = foldSummary(items);
  // The newest facts are what a reader looks for; the rest open with the row.
  const shown = summary.segments.slice(-4);
  return (
    <div className="app-activity-row group flex items-start gap-3 px-5 py-0.5 text-[13px] text-muted-foreground"
      data-activity-row="">
      {/* Aligned with message text: the avatar column stays empty. */}
      <div className="w-9 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onToggle(row.id)}
          aria-expanded={expanded}
          className="flex w-full min-w-0 items-center gap-1.5 rounded text-left transition hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
            aria-hidden="true" />
          <span className="shrink-0 font-bold text-foreground/80">{row.author}</span>
          <span className="min-w-0 truncate">{shown.join(" · ")}</span>
          {summary.inProgress && (
            <span className="min-w-0 shrink truncate">→ {summary.inProgress}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-[11px] tabular-nums">
            {items.length > 1 && <span>{items.length} updates ·</span>}
            <Time value={last.sentAt} />
          </span>
        </button>
        {expanded && (
          <ol className="mt-1 mb-1 space-y-1 border-l border-border pl-3">
            {items.map((item) => (
              <li key={item.id} id={entryAnchorId(item)} className="flex min-w-0 items-start gap-2">
                <Time value={item.sentAt} className="w-16 shrink-0 pt-px text-[11px]" />
                <FoldedEntry item={item} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
});
