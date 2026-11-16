"use client";

import { Fragment, memo, type ReactNode } from "react";
import {
  ChevronRight, CircleCheck, CircleDashed, CircleX, Eye, GitMerge, GitPullRequest, GitPullRequestClosed, LoaderCircle,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { statusInkClass, type StatusTone } from "@/components/ui/status-tone";
import { formatMessageDateTime, formatMessageTimestamp } from "./channel-history";
import { MESSAGE_HEADER_TIMESTAMP_CLASS_NAME } from "./row-frames";
import { RichMessageContent } from "./workspace-shell-rich-message";
import { foldSummary, timelineItemActivity, timelineItemGitHubFact } from "./conversation-activity-rows";
import type { TimelineItem } from "./workspace-shell-message-model";

/*
 * What is not talk (docs/design/conversation-activity.md §4.1): a run of an
 * Instance's plan as one line, and GitHub's pull request facts and people's
 * reviews on the same tinted slip as every other App's receipt.
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
      className="text-foreground underline-offset-2 hover:underline">
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

/** One step of a pull request, in words: "opened by claude:1", "CI passed", "merged". */
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

type PullRequestState = { icon: LucideIcon; tone: StatusTone; title?: string };

/**
 * Where the pull request stands after these steps, said once by its mark (the
 * steps beneath say how it got there), and its title once GitHub said it.
 */
function pullRequestState(items: readonly TimelineItem[]): PullRequestState {
  let state: PullRequestState = { icon: GitPullRequest, tone: "settled" };
  for (const item of items) {
    const fact = timelineItemGitHubFact(item);
    if (fact?.event === "merged") state = { icon: GitMerge, tone: "settled", title: fact.title };
    else if (fact?.event === "closed") state = { icon: GitPullRequestClosed, tone: "secondary", title: fact.title };
    else if (fact?.event === "ci_failed") state = { ...state, icon: CircleX, tone: "alert" };
    else if (fact?.event === "ci_passed") state = { ...state, icon: CircleCheck, tone: "settled" };
  }
  return state;
}

/**
 * A slip of the tinted paper every App's receipt is drawn on
 * (connector-receipt-card.tsx), set in the text column: GitHub's facts read
 * like any other connector's.
 */
function GitHubSlip({ attributes, anchorId, children }: {
  attributes: Record<string, string>; anchorId?: string; children: ReactNode;
}) {
  return (
    <div className="px-5 py-1" id={anchorId} data-activity-row="" {...attributes}>
      <div className="app-connector-receipt ml-[calc(var(--app-message-avatar-size)+var(--app-message-avatar-gap))]">
        {children}
      </div>
    </div>
  );
}

function SlipHead({ icon: Icon, tone, children, time }: {
  icon: LucideIcon; tone: StatusTone; children: ReactNode; time: string;
}) {
  return (
    <p className="app-connector-receipt-head">
      <Icon aria-hidden="true" className={statusInkClass(tone)} />
      <span className="app-connector-receipt-subject">{children}</span>
      <Time value={time} className="ml-auto pl-3 text-xs text-muted-foreground" />
    </p>
  );
}

/**
 * One stretch of pull request facts: a slip with one entry per pull request,
 * its mark and `#121 Reload on reconnect`, over its steps
 * `opened by claude:1 · CI passed · merged`. Talk ends the stretch.
 */
export const PullRequestSlipRow = memo(function PullRequestSlipRow({ row }: { row: TimelineItem }) {
  const lines = row.pullRequests ?? [];
  const lone = lines.length === 1 && lines[0]!.items.length === 1 ? lines[0]!.items[0] : undefined;
  return (
    <GitHubSlip attributes={{ "data-pull-requests": lines.map((line) => `#${line.ref.number}`).join(" ") }}
      anchorId={lone ? entryAnchorId(lone) : undefined}>
      {lines.map(({ ref, items }) => {
        const state = pullRequestState(items);
        const last = items[items.length - 1]!;
        return (
          <div key={`${ref.repository}#${ref.number}`} className="app-connector-receipt-entry" data-pull-request={`#${ref.number}`}>
            <SlipHead icon={state.icon} tone={state.tone} time={last.sentAt}>
              <PullRef {...ref} />{state.title && <> {state.title}</>}
            </SlipHead>
            <p className="app-connector-receipt-detail text-[13px] text-muted-foreground">
              {items.map((item, index) => (
                <span key={item.id} id={lone ? undefined : entryAnchorId(item)} title={formatMessageDateTime(item.sentAt)}>
                  {index > 0 && " · "}<PullRequestStep item={item} />
                </span>
              ))}
            </p>
          </div>
        );
      })}
    </GitHubSlip>
  );
});

/**
 * A person's review or comment on a pull request, from GitHub: a slip headed
 * `yiming requested changes on #121`, their words whole beneath it.
 */
export const GitHubFactRow = memo(function GitHubFactRow({ row }: { row: TimelineItem }) {
  const fact = timelineItemGitHubFact(row);
  if (!fact || (fact.event !== "reviewed" && fact.event !== "commented")) return null;
  const pull = <PullRef repository={fact.repository} number={fact.number} url={fact.url} />;
  const changes = fact.event === "reviewed" && fact.verdict === "changes requested";
  return (
    <GitHubSlip attributes={{ "data-github-fact": fact.event }}>
      <div className="app-connector-receipt-entry">
        <SlipHead icon={fact.event === "reviewed" ? Eye : MessageSquare} tone={changes ? "attention" : "settled"}
          time={row.sentAt}>
          <span className="sr-only">{row.author}: </span>
          {fact.event === "reviewed" ? (
            <>{fact.actor} {changes ? "requested changes on" : fact.verdict} {pull}</>
          ) : (
            <>
              {fact.actor} {fact.commentUrl ? <ExternalLink url={fact.commentUrl}>commented</ExternalLink> : "commented"} on {pull}
              {fact.path && <span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground">{fact.path}</span>}
            </>
          )}
        </SlipHead>
        {fact.words && <div className="app-connector-receipt-detail"><RichMessageContent body={fact.words} /></div>}
      </div>
    </GitHubSlip>
  );
});
