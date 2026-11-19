"use client";

import { Fragment, type ReactNode } from "react";
import {
  CircleCheck, CircleX, Eye, GitMerge, GitPullRequest, GitPullRequestClosed, MessageSquare,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { statusInkClass, type StatusTone } from "@/components/ui/status-tone";
import { formatMessageDateTime, formatMessageTimestamp } from "./channel-history";
import { RichMessageContent } from "./workspace-shell-rich-message";
import { timelineItemActivity, timelineItemGitHubFact } from "./conversation-activity-rows";
import type { TimelineItem } from "./workspace-shell-message-model";
import type { GitHubPullRequestFact } from "@xmatrix/protocol";

/*
 * What is not talk (docs/design/conversation-activity.md §4.1): GitHub's pull
 * request facts and people's reviews are GitHub's messages whose bodies are
 * the same tinted slip as every other App's receipt (PullRequestSlip,
 * GitHubWordsSlip).
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

/**
 * Whether an entry is a step a person reads. The subscription is how the steps
 * after it get here, not a step of the pull request: it names the pull request
 * (its title) and is context for Agents, but says nothing on the line.
 */
function isPullRequestStep(item: TimelineItem): boolean {
  return timelineItemGitHubFact(item)?.event !== "subscribed";
}

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

type PullRequestState = { icon: LucideIcon; tone: StatusTone; title?: string; ended?: boolean };

/**
 * Where the pull request stands after these steps, said once by its mark (the
 * steps beneath say how it got there), and its title once GitHub said it.
 */
function pullRequestState(items: readonly TimelineItem[]): PullRequestState {
  let state: PullRequestState = { icon: GitPullRequest, tone: "settled" };
  for (const item of items) {
    const fact = timelineItemGitHubFact(item);
    if (fact?.event === "merged") state = { icon: GitMerge, tone: "settled", title: fact.title, ended: true };
    else if (fact?.event === "closed") {
      state = { icon: GitPullRequestClosed, tone: "secondary", title: fact.title, ended: true };
    }
    else if (fact?.event === "ci_failed") state = { ...state, icon: CircleX, tone: "alert" };
    else if (fact?.event === "ci_passed") state = { ...state, icon: CircleCheck, tone: "settled" };
  }
  return state;
}

function SlipHead({ icon: Icon, tone, children, time, passed }: {
  icon: LucideIcon; tone: StatusTone; children: ReactNode; time?: string;
  /** CI passed: the tick is green, like a connected App's tick, so a pass reads at a glance beside a red failure. */
  passed?: boolean;
}) {
  return (
    <p className="app-connector-receipt-head">
      <Icon aria-hidden="true" className={statusInkClass(tone)} {...(passed ? { "data-ci": "passed" } : {})} />
      <span className="app-connector-receipt-subject">{children}</span>
      {time && <Time value={time} className="ml-auto pl-3 text-xs text-muted-foreground" />}
    </p>
  );
}

/**
 * The body of GitHub's message for a stretch of pull request facts, on the
 * tinted slip every App's receipt is drawn on (connector-receipt-card.tsx):
 * one entry per pull request, its mark and `#121 Reload on reconnect`, over
 * its steps `opened by claude:1 · CI passed · merged`. A stretch of several
 * messages puts each step's time on its entry.
 */
export function PullRequestSlip({ lines }: { lines: NonNullable<TimelineItem["pullRequests"]> }) {
  const several = lines.length > 1 || lines.some((line) => line.items.length > 1);
  return (
    <div className="app-connector-receipt" data-pull-requests={lines.map((line) => `#${line.ref.number}`).join(" ")}>
      {lines.map(({ ref, items, title }) => {
        const state = pullRequestState(items);
        const steps = items.filter(isPullRequestStep);
        return (
          <div key={`${ref.repository}#${ref.number}`} className="app-connector-receipt-entry" data-pull-request={`#${ref.number}`}>
            <SlipHead icon={state.icon} tone={state.tone} passed={state.icon === CircleCheck} {...(several ? { time: items[items.length - 1]!.sentAt } : {})}>
              <PullRef {...ref} />{(state.title || title) && <> {state.title || title}</>}
            </SlipHead>
            {/* The subscription keeps its anchor, so a link to its message still lands on this entry. */}
            {items.filter((item) => !isPullRequestStep(item)).map((item) => (
              <span key={item.id} id={entryAnchorId(item)} aria-hidden="true" />
            ))}
            {steps.length > 0 && (
              <p className="app-connector-receipt-detail text-[13px] text-muted-foreground">
                {steps.map((item, index) => (
                  <span key={item.id} id={entryAnchorId(item)} title={formatMessageDateTime(item.sentAt)}>
                    {index > 0 && " · "}<PullRequestStep item={item} />
                  </span>
                ))}
              </p>
            )}

          </div>
        );
      })}
    </div>
  );
}

/**
 * The body of GitHub's message for a person's review or comment: a slip
 * headed `yiming requested changes on #121`, their words whole beneath it.
 */
export function GitHubWordsSlip({ fact }: { fact: GitHubPullRequestFact }) {
  if (fact.event !== "reviewed" && fact.event !== "commented") return null;
  const pull = <PullRef repository={fact.repository} number={fact.number} url={fact.url} />;
  const changes = fact.event === "reviewed" && fact.verdict === "changes requested";
  return (
    <div className="app-connector-receipt" data-github-fact={fact.event}>
      <div className="app-connector-receipt-entry">
        <SlipHead icon={fact.event === "reviewed" ? Eye : MessageSquare} tone={changes ? "attention" : "settled"}>
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
    </div>
  );
}
