"use client";

import { Fragment, memo, type ReactNode } from "react";
import {
  ChevronRight, CircleCheck, CircleDashed, CircleX, Eye, GitMerge, GitPullRequest, GitPullRequestClosed, LoaderCircle,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { statusInkClass } from "@/components/ui/status-tone";
import { formatMessageDateTime, formatMessageTimestamp } from "./channel-history";
import { MESSAGE_HEADER_TIMESTAMP_CLASS_NAME } from "./row-frames";
import { RichMessageContent } from "./workspace-shell-rich-message";
import { foldSummary, timelineItemActivity, timelineItemGitHubFact } from "./conversation-activity-rows";
import type { TimelineItem } from "./workspace-shell-message-model";

/*
 * Lines that are not talk (docs/design/conversation-activity.md §4.1): a run
 * of an Instance's plan, one pull request's line, and a person's review or
 * comment from GitHub. All share one shape: a mark in the avatar column, what
 * happened, the time at the right edge.
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

function ExternalLink({ url, label, children }: { url: string; label?: string; children: ReactNode }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" aria-label={label} title={label}
      className="font-medium text-foreground underline-offset-2 hover:underline">
      {children}
    </a>
  );
}

/** A pull request as `#121`; its repository is in the link's name and tooltip, not on every line. */
function PullRef({ repository, number, url }: { repository: string; number: number; url: string }) {
  return <ExternalLink url={url} label={`${repository}#${number}`}>#{number}</ExternalLink>;
}

const AVATAR_COLUMN = "flex h-[1lh] w-(--app-message-avatar-size) shrink-0 items-center justify-center";
const ENTRY_LIST = "mt-1 mb-1 ml-[calc(var(--app-message-avatar-size)+var(--app-message-avatar-gap))] space-y-1 border-l border-border pl-3";

/**
 * The shared shape. A line that opens: a link inside opens itself; anywhere
 * else on the line opens or closes it.
 */
function ActivityLine({ mark, time, onToggle, anchorId, attributes, children, below }: {
  mark: ReactNode;
  time: string;
  onToggle?: () => void;
  anchorId?: string;
  attributes?: Record<string, string>;
  children: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="app-activity-row group px-5 py-1 text-[13px] text-muted-foreground"
      data-activity-row="" id={anchorId} {...attributes}>
      <div
        onClick={onToggle ? (event) => {
          if (!(event.target as Element).closest("a, button")) onToggle();
        } : undefined}
        className={cn("flex w-full min-w-0 items-start gap-(--app-message-avatar-gap)",
          onToggle && "cursor-pointer transition hover:text-foreground")}
      >
        {mark}
        <span className="min-w-0 flex-1">{children}</span>
        <Time value={time} className={cn(MESSAGE_HEADER_TIMESTAMP_CLASS_NAME, "whitespace-nowrap pl-3 leading-[inherit]")} />
      </div>
      {below}
    </div>
  );
}

function Disclosure({ expanded, onToggle, label }: { expanded: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={expanded}
      aria-label={expanded ? `Hide ${label}` : `Show ${label}`} className={cn(AVATAR_COLUMN, "rounded")}>
      <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} aria-hidden="true" />
    </button>
  );
}

function PlanEntry({ item }: { item: TimelineItem }) {
  const activity = timelineItemActivity(item);
  if (activity?.kind !== "plan") return null;
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

/** The newest steps of a run, oldest first, then the step in progress: one line that truncates as a whole. */
function PlanFacts({ items, inProgress }: { items: readonly TimelineItem[]; inProgress?: string }) {
  const facts: ReactNode[] = [];
  items.forEach((item) => {
    const activity = timelineItemActivity(item);
    if (activity?.kind !== "plan") return;
    activity.completed.forEach((step, index) => facts.push(<span key={`${item.id}:${index}`}>✓ {step}</span>));
    if (activity.completed.length === 0 && !activity.inProgress) {
      facts.push(<span key={item.id}>
        Plan · {activity.steps.length} step{activity.steps.length === 1 ? "" : "s"}
      </span>);
    }
  });
  return (
    <>
      {facts.slice(-4).map((fact, index) => <Fragment key={index}>{index > 0 && " · "}{fact}</Fragment>)}
      {inProgress && ` → ${inProgress}`}
    </>
  );
}

/** One run of an Instance's plan entries: a single line where the run began, opening in place. */
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
  const last = items[items.length - 1];
  if (!last) return null;
  const toggle = () => onToggle(row.id);
  return (
    <ActivityLine time={last.sentAt} onToggle={toggle}
      mark={<Disclosure expanded={expanded} onToggle={toggle} label="activity" />}
      below={expanded && (
        <ol className={ENTRY_LIST}>
          {items.map((item) => (
            <li key={item.id} id={entryAnchorId(item)} className="flex min-w-0 items-start gap-2">
              <Time value={item.sentAt} className="min-w-16 whitespace-nowrap pt-px text-[11px]" />
              <PlanEntry item={item} />
            </li>
          ))}
        </ol>
      )}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-bold text-foreground/80">{row.author}</span>
        <span className="min-w-0 truncate"><PlanFacts items={items} inProgress={foldSummary(items).inProgress} /></span>
        {items.length > 1 && <span className="shrink-0 text-xs">· {items.length} updates</span>}
      </span>
    </ActivityLine>
  );
});

/** One step of a pull request's line, in words: "opened by claude:1", "CI passed", "merged". */
function PullRequestStep({ item }: { item: TimelineItem }) {
  if (timelineItemActivity(item)?.kind === "pull_request") return <>opened by {item.author}</>;
  const fact = timelineItemGitHubFact(item);
  if (!fact) return null;
  if (fact.event === "ci_passed") return <>CI passed</>;
  if (fact.event === "ci_failed") {
    return (
      <span className={statusInkClass("alert", "[&_a]:text-inherit")}>
        CI failed
        {fact.failed.length > 0 && ": "}
        {fact.failed.map((check, index) => (
          <Fragment key={`${index}:${check.name}`}>
            {index > 0 && ", "}
            {check.url ? <ExternalLink url={check.url}>{check.name}</ExternalLink> : check.name}
          </Fragment>
        ))}
        {fact.more > 0 && `, and ${fact.more} more`}
      </span>
    );
  }
  if (fact.event === "merged" || fact.event === "closed") {
    return <>{fact.event}{fact.actor && ` by ${fact.actor}`}</>;
  }
  return null;
}

type PullRequestState = { icon: LucideIcon; className?: string; title?: string };

/** Where the pull request stands after these steps: its mark, and its title once GitHub said it. */
function pullRequestState(items: readonly TimelineItem[]): PullRequestState {
  let state: PullRequestState = { icon: GitPullRequest };
  for (const item of items) {
    const fact = timelineItemGitHubFact(item);
    if (fact?.event === "merged") state = { icon: GitMerge, title: fact.title };
    else if (fact?.event === "closed") state = { icon: GitPullRequestClosed, title: fact.title };
    else if (fact?.event === "ci_failed") state = { icon: CircleX, className: statusInkClass("alert") };
    else if (fact?.event === "ci_passed") state = { icon: GitPullRequest };
  }
  return state;
}

/**
 * One pull request's line: its opening and what GitHub said about it in one
 * stretch, as `#121 Title   opened by claude:1 · CI passed · merged`. Its
 * mark is where it stands now. More than one step opens to each with its time.
 */
export const PullRequestLineRow = memo(function PullRequestLineRow({
  row,
  expanded,
  onToggle,
}: {
  row: TimelineItem;
  expanded: boolean;
  onToggle: (rowId: string) => void;
}) {
  const items = row.folded ?? [];
  const pull = row.pullRequest;
  const first = items[0];
  const last = items[items.length - 1];
  if (!pull || !first || !last) return null;
  const state = pullRequestState(items);
  const Icon = state.icon;
  const opens = items.length > 1;
  const toggle = () => onToggle(row.id);
  return (
    <ActivityLine time={last.sentAt} onToggle={opens ? toggle : undefined}
      anchorId={opens ? undefined : entryAnchorId(first)} attributes={{ "data-pull-request": `#${pull.number}` }}
      mark={<span className={AVATAR_COLUMN} aria-hidden="true"><Icon className={cn("size-3.5 shrink-0", state.className)} /></span>}
      below={expanded && opens && (
        <ol className={ENTRY_LIST}>
          {items.map((item) => (
            <li key={item.id} id={entryAnchorId(item)} className="flex min-w-0 items-start gap-2">
              <Time value={item.sentAt} className="min-w-16 whitespace-nowrap pt-px text-[11px]" />
              <span className="min-w-0"><PullRequestStep item={item} /></span>
            </li>
          ))}
        </ol>
      )}>
      <span className="mr-2 text-foreground/90"><PullRef {...pull} /></span>
      {state.title && <span className="mr-2 text-foreground/80">{state.title}</span>}
      {items.map((item, index) => (
        <Fragment key={item.id}>{index > 0 && " · "}<PullRequestStep item={item} /></Fragment>
      ))}
      {opens && (
        <button type="button" onClick={toggle} aria-expanded={expanded}
          aria-label={expanded ? "Hide steps" : "Show steps"} className="ml-1 inline-flex align-[-2px]">
          <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} aria-hidden="true" />
        </button>
      )}
    </ActivityLine>
  );
});

/**
 * A person's review or comment on a pull request, from GitHub: the same line
 * (`yiming requested changes on #121`), their words whole beneath it.
 */
export const GitHubFactRow = memo(function GitHubFactRow({ row }: { row: TimelineItem }) {
  const fact = timelineItemGitHubFact(row);
  if (!fact || (fact.event !== "reviewed" && fact.event !== "commented")) return null;
  const pull = <PullRef repository={fact.repository} number={fact.number} url={fact.url} />;
  const changes = fact.event === "reviewed" && fact.verdict === "changes requested";
  const Icon = fact.event === "reviewed" ? Eye : MessageSquare;
  return (
    <ActivityLine time={row.sentAt} attributes={{ "data-github-fact": fact.event }}
      mark={<span className={AVATAR_COLUMN} aria-hidden="true">
        <Icon className={cn("size-3.5 shrink-0", changes && statusInkClass("attention"))} />
      </span>}
      below={fact.words && (
        <div className="ml-[calc(var(--app-message-avatar-size)+var(--app-message-avatar-gap))] mt-1 text-[15px] text-foreground">
          <RichMessageContent body={fact.words} />
        </div>
      )}>
      <span className="sr-only">{row.author}: </span>
      {fact.event === "reviewed" ? (
        <>{fact.actor} {changes ? "requested changes on" : fact.verdict} {pull}</>
      ) : (
        <>
          {fact.actor} {fact.commentUrl ? <ExternalLink url={fact.commentUrl}>commented</ExternalLink> : "commented"} on {pull}
          {fact.path && <span className="ml-1.5 font-mono text-[11px] opacity-70">{fact.path}</span>}
        </>
      )}
    </ActivityLine>
  );
});
