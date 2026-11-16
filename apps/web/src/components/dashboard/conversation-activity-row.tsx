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
import type { GitHubPullRequestFact } from "@xmatrix/protocol";

/**
 * One folded run of an Instance's activity
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
  if (!activity) return null;
  if (activity.kind === "pull_request") {
    return <PullRequestLink {...activity} />;
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

/** A pull request reads as the same underlined reference GitHub's facts below it carry. */
function PullRequestLink({ repository, number, url, icon = true }: {
  repository: string; number: number; url: string; icon?: boolean;
}) {
  return (
    <span>
      {icon && <GitPullRequest className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />}
      opened <PullRef repository={repository} number={number} url={url} />
    </span>
  );
}

/**
 * The newest facts of a fold, oldest first, then the step in progress: one
 * line that truncates as a whole. Steps are text, pull requests links.
 */
function FoldFacts({ items, lone, inProgress }: {
  items: readonly TimelineItem[]; lone: boolean; inProgress?: string;
}) {
  const facts: ReactNode[] = [];
  items.forEach((item) => {
    const activity = timelineItemActivity(item);
    if (!activity) return;
    if (activity.kind === "pull_request") {
      facts.push(<PullRequestLink key={item.id} {...activity} icon={!lone} />);
      return;
    }
    activity.completed.forEach((step, index) => facts.push(<span key={`${item.id}:${index}`}>✓ {step}</span>));
    if (activity.completed.length === 0 && !activity.inProgress) {
      facts.push(<span key={item.id}>
        Plan · {activity.steps.length} step{activity.steps.length === 1 ? "" : "s"}
      </span>);
    }
  });
  return (
    <span className="min-w-0 truncate">
      {facts.slice(-4).map((fact, index) => <Fragment key={index}>{index > 0 && " · "}{fact}</Fragment>)}
      {inProgress && ` → ${inProgress}`}
    </span>
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
  // A lone pull request already says everything on its line: nothing to open,
  // so its mark stands in the avatar column instead of a disclosure.
  const lone = items.length === 1 && timelineItemActivity(first)?.kind === "pull_request";
  return (
    <div className="app-activity-row group px-5 py-1 text-[13px] text-muted-foreground"
      data-activity-row="" id={lone ? entryAnchorId(first) : undefined}>
      {/* Read like a message head: name, then its time, then what happened. A
          link inside opens itself; anywhere else on the line opens the fold. */}
      <div
        onClick={(event) => {
          if (!lone && !(event.target as Element).closest("a, button")) onToggle(row.id);
        }}
        className={cn("flex w-full min-w-0 items-center gap-(--app-message-avatar-gap)",
          !lone && "cursor-pointer transition hover:text-foreground")}
      >
        {/* The disclosure sits in the avatar column, so the name starts where a message's name does.
            A fixed 2.25rem gutter (the main timeline's avatar) shoved this row right in a comment card. */}
        {lone ? (
          <span className="flex w-(--app-message-avatar-size) shrink-0 justify-center" aria-hidden="true">
            <GitPullRequest className="size-3.5 shrink-0" />
          </span>
        ) : (
          <button type="button" onClick={() => onToggle(row.id)} aria-expanded={expanded}
            aria-label={expanded ? "Hide activity" : "Show activity"}
            className="flex w-(--app-message-avatar-size) shrink-0 justify-center rounded">
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} aria-hidden="true" />
          </button>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="shrink-0 font-bold text-foreground/80">{row.author}</span>
          <FoldFacts items={items} lone={lone} inProgress={summary.inProgress} />
          {items.length > 1 && <span className="shrink-0 text-xs">· {items.length} updates</span>}
        </span>
        <Time value={last.sentAt} className={cn(MESSAGE_HEADER_TIMESTAMP_CLASS_NAME, "pl-3")} />
      </div>
      {expanded && !lone && (
        <ol className="mt-1 mb-1 ml-[calc(var(--app-message-avatar-size)+var(--app-message-avatar-gap))] space-y-1 border-l border-border pl-3">
            {items.map((item) => (
              <li key={item.id} id={entryAnchorId(item)} className="flex min-w-0 items-start gap-2">
                <Time value={item.sentAt} className="min-w-16 whitespace-nowrap pt-px text-[11px]" />
                <FoldedEntry item={item} />
              </li>
            ))}
        </ol>
      )}
    </div>
  );
});

const GITHUB_FACT_MARK: Record<GitHubPullRequestFact["event"], { icon: LucideIcon; className?: string }> = {
  ci_passed: { icon: CircleCheck },
  ci_failed: { icon: CircleX, className: statusInkClass("alert") },
  merged: { icon: GitMerge },
  closed: { icon: GitPullRequestClosed },
  reviewed: { icon: Eye },
  commented: { icon: MessageSquare },
};

/** The fact's mark; a review asking for changes is a person's call to act. */
function githubFactMark(fact: GitHubPullRequestFact): { icon: LucideIcon; className?: string } {
  if (fact.event === "reviewed" && fact.verdict === "changes requested") {
    return { icon: Eye, className: statusInkClass("attention") };
  }
  return GITHUB_FACT_MARK[fact.event];
}

/** What GitHub reported, in the words of its message, with the same links. */
function GitHubFactText({ fact }: { fact: GitHubPullRequestFact }) {
  const pull = <PullRef repository={fact.repository} number={fact.number} url={fact.url} />;
  const sha = (value: string) => value && <span className="ml-1.5 font-mono text-[11px] opacity-70">{value}</span>;
  if (fact.event === "ci_passed") return <>CI passed on {pull}{sha(fact.sha)}</>;
  if (fact.event === "ci_failed") {
    return (
      <>
        CI failed on {pull}{sha(fact.sha)} ·{" "}
        {fact.failed.map((check, index) => (
          <Fragment key={`${index}:${check.name}`}>
            {index > 0 && ", "}
            {check.url ? <ExternalLink url={check.url}>{check.name}</ExternalLink> : check.name}
          </Fragment>
        ))}
        {fact.more > 0 && `, and ${fact.more} more`}
      </>
    );
  }
  if (fact.event === "reviewed") {
    const verb = fact.verdict === "changes requested" ? "requested changes on" : fact.verdict;
    return <>{fact.actor} {verb} {pull}</>;
  }
  if (fact.event === "commented") {
    return (
      <>
        {fact.actor} {fact.commentUrl ? <ExternalLink url={fact.commentUrl}>commented</ExternalLink> : "commented"} on{" "}
        {pull}{fact.path && <span className="ml-1.5 font-mono text-[11px] opacity-70">{fact.path}</span>}
      </>
    );
  }
  const verb = fact.event === "merged" ? "merged" : "closed";
  return (
    <>
      {fact.actor ? `${fact.actor} ${verb} ` : `${verb === "merged" ? "Merged" : "Closed"} `}
      {pull}
      {fact.title && <span className="ml-1.5 opacity-70">{fact.title}</span>}
    </>
  );
}

/**
 * A fact GitHub reported about a subscribed pull request (CI verdict, merge,
 * close, a person's review or comment), drawn as the same line as the "Opened" entry it follows: its mark in
 * the avatar column, then sender, time and what happened
 * (docs/design/conversation-activity.md §4.1).
 */
export const GitHubFactRow = memo(function GitHubFactRow({ row }: { row: TimelineItem }) {
  const fact = timelineItemGitHubFact(row);
  if (!fact) return null;
  const mark = githubFactMark(fact);
  const words = fact.event === "reviewed" || fact.event === "commented" ? fact.words : "";
  const Icon = mark.icon;
  return (
    <div className="app-activity-row px-5 py-1 text-[13px] text-muted-foreground"
      data-activity-row="" data-github-fact={fact.event}>
      <div className="flex w-full min-w-0 items-start gap-(--app-message-avatar-gap)">
        <span className="flex h-[1lh] w-(--app-message-avatar-size) shrink-0 items-center justify-center" aria-hidden="true">
          <Icon className={cn("size-3.5 shrink-0", mark.className)} />
        </span>
        {/* The mark and the sentence say it is GitHub's; the time steps aside to the right. */}
        <span className="min-w-0 flex-1">
          <span className="sr-only">{row.author}: </span>
          <GitHubFactText fact={fact} />
        </span>
        <Time value={row.sentAt} className={cn(MESSAGE_HEADER_TIMESTAMP_CLASS_NAME, "whitespace-nowrap pl-3 leading-[inherit]")} />
      </div>
      {/* A person's words stay whole, in message ink, under the line that says who wrote them. */}
      {words && (
        <div className="ml-[calc(var(--app-message-avatar-size)+var(--app-message-avatar-gap))] mt-1 text-[15px] text-foreground">
          <RichMessageContent body={words} />
        </div>
      )}
    </div>
  );
});
