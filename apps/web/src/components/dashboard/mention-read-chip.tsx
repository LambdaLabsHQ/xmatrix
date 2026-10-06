"use client";

/**
 * The `@` itself carries its invocation progress or independent read receipt.
 *
 * A mention renders as the mentioned member's avatar plus their name and a
 * compact receipt on the avatar corner, matching Feishu's `@` affordance.
 * Anchoring the marker to the avatar (not the outer chip) keeps it attached
 * when long summon labels wrap across lines. Activating that marker exposes
 * the state for this one mentioned person, without a duplicate receipt row
 * elsewhere in the message.
 *
 * Scope comes from two contexts so markdown components stay identity-stable:
 * the Channel scope (members and their cursors) changes when the Channel does,
 * and the message scope supplies the one sequence each mention compares
 * against. Neither forces the memoized markdown body to re-render.
 */
import { listenForOverlayDismissal } from "./use-overlay-dismiss";
import { createContext, Fragment, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { LoadingImage } from "@/components/dashboard/content-skeleton";

import { parseAgentStopInvocation, type ChannelMentionReadStatus, type SerializedAgentLaunch, type SerializedAgentInvocationRejection, type SerializedAgentStop } from "@xmatrix/protocol";
import { avatarImageSrc } from "./identity-avatar";
import {
  mentionChipLabel,
  mentionReadResolution,
  splitMentionSegments,
  withInvocationMentionTargets,
  withWrittenInvocationTargets,
  type MentionReadIndex,
  type MentionReadTarget,
} from "./mention-read-state";
import { cn } from "@/lib/utils";
import { MentionInvocationChip, MentionInvocationRejectionChip, MentionContinuationChip, InvocationPopoverGroup,
  MentionIntentDeclinedChip, MentionStopChip, MentionSummonPending } from "./mention-invocation-chip";
import { declinedIntent, readingIntentUntil } from "./summon-intent";
import { handoffSuccessorLaunch, segmentMessageInteraction, type InteractionSegment } from "./mention-invocation-state";
import { HandoffCard } from "./handoff-arrow";
import { type AutoLaunchMention, isMentionAddressStart, isOperationalMentionStart, literalMentionSourceOffsets, nonOperationalMentionRanges, parsePresentedRoutingDecision, type NonOperationalMentionRange } from "@xmatrix/protocol";
import { jevFilledAnnouncement, jevFilledTags, launchMachineLabel, type JevFilledTag } from "./jev-filled-tags";
import { JevFilledTagSpans } from "./jev-filled-tag-spans";
import { PageReferenceRichText } from "./page-reference-chip";

export type MentionReadChannelScope = {
  index: MentionReadIndex | null;
  /** Absent when the Channel payload cannot report member read state. */
  memberReadSequences?: Record<string, number>;
  currentUserIdentityId?: string;
  /** Subjects on an unreachable machine; their unread mentions say so. */
  machineOfflineSubjectIds?: ReadonlySet<string>;
};

export type MentionReadMessageScope = {
  sequence?: number;
  launches?: readonly SerializedAgentLaunch[];
  /** Receipts for this message's stop command. Present only when this message is allowed to show one. */
  stops?: readonly SerializedAgentStop[];
  /** False while the invocation query has not answered. Absent hides the stop chip. */
  stopReceiptsLoaded?: boolean;
  rejections?: readonly SerializedAgentInvocationRejection[];
  continuations?: readonly import("@xmatrix/protocol").SerializedAgentContinuation[];
  executions?: readonly import("@xmatrix/protocol").SerializedAgentMessageExecution[];
  sourceBody?: string;
  nonOperationalRanges?: readonly NonOperationalMentionRange[];
  launchStatusUnavailable?: boolean;
  onRetryLaunch?: (launch: SerializedAgentLaunch) => Promise<void>;
  /** Present only for the message's author: start a summon Jev declined. */
  onLaunchAnyway?: (sourceMention: string) => Promise<void>;
  /** When the message was sent, so a fresh summon can show Jev reading it. */
  sentAt?: string;
  statuses?: readonly ChannelMentionReadStatus[];
};

/** True while a just-sent summon is within Jev's reading window; flips off on its own. */
function useIntentReading(sentAt: string | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());
  const until = readingIntentUntil(sentAt, now);
  useEffect(() => {
    if (until === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [until]);
  return until !== undefined;
}

function RecordedRejectionChip({ rejection, labelContent, announcement, scope }: {
  rejection: SerializedAgentInvocationRejection; labelContent?: ReactNode; announcement?: string; scope: MentionReadMessageScope | null;
}) {
  const category = declinedIntent(rejection.code);
  if (category) {
    const launchAnyway = scope?.onLaunchAnyway;
    return <MentionIntentDeclinedChip rejection={rejection} category={category} labelContent={labelContent}
      onLaunchAnyway={launchAnyway ? () => launchAnyway(rejection.sourceMention) : undefined} />;
  }
  return <MentionInvocationRejectionChip rejection={rejection} labelContent={labelContent} announcement={announcement} unavailable={scope?.launchStatusUnavailable} />;
}

const ChannelScopeContext = createContext<MentionReadChannelScope | null>(null);
const MessageScopeContext = createContext<MentionReadMessageScope | null>(null);
const OperationalMentionContext = createContext(true);

export function NonOperationalMentions({ children }: { children: ReactNode }) {
  return <OperationalMentionContext.Provider value={false}>{children}</OperationalMentionContext.Provider>;
}

export function MentionReadChannelScopeProvider({
  scope,
  children,
}: {
  scope: MentionReadChannelScope;
  children: ReactNode;
}) {
  return <ChannelScopeContext.Provider value={scope}><InvocationPopoverGroup>{children}</InvocationPopoverGroup></ChannelScopeContext.Provider>;
}

export function MentionReadMessageScopeProvider({
  scope,
  children,
}: {
  scope: MentionReadMessageScope;
  children: ReactNode;
}) {
  return <MessageScopeContext.Provider value={scope}>{children}</MessageScopeContext.Provider>;
}

/**
 * Replace resolved mentions inside plain-text children with read-state chips.
 * Only direct string children are rewritten: text nested in code spans, links,
 * or other markdown elements keeps whatever the author wrote.
 */
type SourcePosition = { start: number; end: number };
type MarkdownSourceNode = { children?: readonly { type: string; value?: unknown;
  position?: { start: { offset?: number }; end: { offset?: number } } }[] };

export function renderMentionChildren(children: ReactNode, node?: MarkdownSourceNode): ReactNode {
  let cursor = 0;
  const render = (text: string, key?: number) => {
    let sourcePosition: SourcePosition | null | undefined;
    if (node) {
      const index = node.children?.findIndex((child, index) => index >= cursor && child.type === "text" && child.value === text) ?? -1;
      const position = index >= 0 ? node.children?.[index]?.position : undefined;
      if (index >= 0) cursor = index + 1;
      sourcePosition = typeof position?.start.offset === "number" && typeof position.end.offset === "number"
        ? { start: position.start.offset, end: position.end.offset } : null;
    }
    return <MentionRichText key={key} text={text} sourcePosition={sourcePosition} />;
  };
  if (typeof children === "string") return render(children);
  if (!Array.isArray(children)) return children;
  return children.map((child, index) => typeof child === "string" ? render(child, index) : child);
}

export const MentionRichText = memo(function MentionRichText({ text, rawMarkdown = false, sourcePosition }: {
  text: string; rawMarkdown?: boolean; sourcePosition?: SourcePosition | null;
}) {
  const operational = useContext(OperationalMentionContext);
  const scope = useContext(MessageScopeContext);
  const allowed = useMemo(() => {
    if (rawMarkdown) {
      const ranges = /[@＠]/u.test(text) ? nonOperationalMentionRanges(text) : [];
      return (start: number) => isMentionAddressStart(text, start) && isOperationalMentionStart(start, ranges);
    }
    if (sourcePosition === undefined) return () => true;
    if (!sourcePosition || !scope?.sourceBody) return () => false;
    const source = scope.sourceBody;
    const positions = literalMentionSourceOffsets(source.slice(sourcePosition.start, sourcePosition.end), text);
    const ranges = scope.nonOperationalRanges ?? nonOperationalMentionRanges(source);
    return (start: number) => {
      const original = positions?.get(start);
      if (original === undefined) return false;
      const absolute = original + sourcePosition.start;
      return isMentionAddressStart(source, absolute) && isOperationalMentionStart(absolute, ranges);
    };
  }, [rawMarkdown, text, sourcePosition, scope?.sourceBody, scope?.nonOperationalRanges]);
  const channelScope = useContext(ChannelScopeContext);
  const reading = useIntentReading(scope?.launchStatusUnavailable ? undefined : scope?.sentAt);
  const segments = useMemo(() => {
    const launches = scope?.launches ?? [];
    const base = channelScope?.index;
    const index = base || launches.length
      ? (run: string) => withWrittenInvocationTargets(withInvocationMentionTargets(
        base ?? { tokens: [], byToken: new Map() }, launches), run)
      : null;
    const stopInvocation = scope?.stopReceiptsLoaded !== undefined && scope.sourceBody
      ? parseAgentStopInvocation(scope.sourceBody) : undefined;
    // Only the message that is the command carries the chip. A quote of it does not.
    const stop = stopInvocation ? { invocation: stopInvocation, receipts: scope?.stops ?? [] } : undefined;
    return segmentMessageInteraction<MentionReadTarget>(text, {
      continuations: scope?.continuations, rejections: scope?.rejections, launches,
      ...(stop ? { stop } : {}),
      launchStatusUnavailable: scope?.launchStatusUnavailable,
      mentions: run => splitMentionSegments(run, index ? index(run) : null),
    }, allowed);
  }, [text, allowed, channelScope?.index, scope?.continuations, scope?.rejections, scope?.launches,
    scope?.stops, scope?.stopReceiptsLoaded, scope?.sourceBody, scope?.launchStatusUnavailable]);
  if (!operational) return <PageReferenceRichText text={text} />;
  return <>{segments.map((segment, index) =>
    <InteractionSegmentView key={index} segment={segment} scope={scope} reading={reading} />)}</>;
});

/**
 * Each presentation contract maps to the component that already draws it;
 * the protocol chooses the contract, never the markup. A text run with no
 * interaction keeps the page-reference rendering every plain run gets.
 */
function InteractionSegmentView({ segment, scope, reading }: {
  segment: InteractionSegment<MentionReadTarget>; scope: MentionReadMessageScope | null; reading: boolean;
}) {
  switch (segment.presentationRef) {
    case null:
      return <PageReferenceRichText text={segment.text} />;
    case "reborn.v1":
      return <MentionContinuationChip record={segment.record} unavailable={scope?.launchStatusUnavailable} />;
    case "handoff.v1":
      return "record" in segment
        ? <MentionContinuationChip record={segment.record} unavailable={scope?.launchStatusUnavailable} />
        : <HandoffCard sourceName={segment.written.sourceName} sourceOrdinal={segment.written.sourceOrdinal}
          successorName={segment.written.successorName} sentAt={scope?.sentAt}
          launch={handoffSuccessorLaunch(scope?.launches, segment.text)}
          fillKey={scope?.sequence !== undefined ? `${scope.sequence}:${segment.text}` : undefined} />;
    case "launch.v1": {
      if (!segment.mention) {
        return segment.rejection ? <RecordedRejectionChip rejection={segment.rejection} scope={scope} /> : null;
      }
      /* The chip carries the whole `@` expression as written. Conditions the
         author typed are marked where they sit. What Jev and routing chose
         afterwards is drawn in the same highlight, after that text. The stored
         message is not edited: a quote, the CLI and the next Agent still read
         the original words. */
      const decision = parsePresentedRoutingDecision(segment.launch?.routingDecision ?? segment.rejection?.routingDecision);
      const filled = jevFilledTags(segment.mention, decision?.parameters,
        launchMachineLabel(decision, segment.mention.tags.machine));
      const fillKey = scope?.sequence !== undefined ? `${scope.sequence}:${segment.mention.start}` : undefined;
      const expression = <SummonExpression mention={segment.mention} filled={filled} fillKey={fillKey} />;
      const announcement = jevFilledAnnouncement(filled);
      return segment.launch
        ? <MentionInvocationChip label={segment.mention.text.replace(/^[@＠]/u, "")} labelContent={expression}
          announcement={announcement}
          launch={segment.launch} shared={false}
          unavailable={scope?.launchStatusUnavailable} executions={scope?.executions ?? []} />
        : segment.rejection ? <RecordedRejectionChip rejection={segment.rejection} labelContent={expression} announcement={announcement} scope={scope} />
        : <MentionSummonPending labelContent={expression} fillKey={fillKey} reading={reading && !segment.mention.error} />;
    }
    case "stop.v1":
      return <MentionStopChip invocation={segment.invocation} receipts={segment.receipts}
        sentAt={scope?.sentAt} pending={scope?.stopReceiptsLoaded === false}
        unavailable={scope?.launchStatusUnavailable} />;
    case "mention.v1":
      return <MentionReadChip target={segment.target} text={segment.text} token={segment.token} />;
    default:
      // A contract this client does not know stays the text it was written as.
      return <PageReferenceRichText text={(segment as { text: string }).text} />;
  }
}

/**
 * A summon drawn as the author wrote it, one highlight per condition, plus
 * the parameters Jev and routing filled after sending.
 *
 * Every character of the author's summon comes from the message: the grammar
 * reports where each `key:value` sits, and this only wraps those spans.
 * Nothing there is reordered, relabelled or left out, so a quote, the CLI and
 * the next Agent still read the original words. Filled choices are drawn after
 * that text, in summon order. They are a display of the decision, not an edit
 * of the message. Jev's choices and routing's Machine use the same grammar.
 *
 * A condition never breaks between its key and its value — `harness:` stranded
 * at the end of a line is the same phrase read twice — and the spaces between
 * conditions stay the break opportunities.
 */
function SummonExpression({ mention, filled, fillKey }: {
  mention: AutoLaunchMention; filled: readonly JevFilledTag[]; fillKey?: string;
}) {
  const slice = (from: number, to: number) => mention.text.slice(from - mention.start, to - mention.start);
  const parts: ReactNode[] = [];
  let cursor = mention.start;
  for (const condition of mention.conditions) {
    if (condition.start > cursor) parts.push(<Fragment key={`gap-${cursor}`}>{slice(cursor, condition.start)}</Fragment>);
    parts.push(<span key={condition.start} className="app-summon-condition">
      {slice(condition.start, condition.valueStart)}
      {slice(condition.valueStart, condition.end)}
    </span>);
    cursor = condition.end;
  }
  parts.push(<Fragment key="tail">{slice(cursor, mention.end)}</Fragment>);
  if (filled.length) parts.push(<JevFilledTagSpans key="jev-filled" tags={filled} fillKey={fillKey} />);
  return <>{parts}</>;
}

export function MentionReadChip({
  target,
  text,
  token,
}: {
  target: MentionReadTarget;
  text: string;
  /** The address that resolved this mention; the label shows the name instead. */
  token?: string;
}) {
  const channelScope = useContext(ChannelScopeContext);
  const messageScope = useContext(MessageScopeContext);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const receiptRef = useRef<HTMLSpanElement | null>(null);
  const resolution = mentionReadResolution({
    target,
    messageSequence: messageScope?.sequence,
    memberReadSequences: channelScope?.memberReadSequences,
    serverStatuses: messageScope?.statuses,
  });
  const mentionsViewer = Boolean(
    channelScope?.currentUserIdentityId &&
    channelScope.currentUserIdentityId === target.subjectId
  );
  const imageSrc = avatarImageSrc(target.avatarUrl);
  const label = mentionChipLabel(text, target.label, token);
  // The existing unread receipt is the delivery indicator; it only adds why
  // this one will not be read until the machine comes back.
  const machineOffline = resolution.state === "unread" &&
    channelScope?.machineOfflineSubjectIds?.has(target.subjectId) === true;
  const stateCopy = mentionReadStateCopy(resolution.state, machineOffline);

  useEffect(() => {
    if (!receiptOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!receiptRef.current?.contains(event.target as Node)) setReceiptOpen(false);
    };
    return listenForOverlayDismissal(closeOnOutsidePointer, () => setReceiptOpen(false));
  }, [receiptOpen]);

  return (
    <span
      className={cn(
        "app-mention-chip",
        mentionsViewer && "app-mention-chip-self"
      )}
      data-read-state={resolution.state}
      title={`${label} · ${stateCopy}`}
    >
      <span className="app-mention-chip-avatar">
        <span className="app-mention-chip-avatar-face" aria-hidden="true">
          {imageSrc ? (
            <LoadingImage
              src={imageSrc}
              alt=""
              announce={false}
              referrerPolicy="no-referrer"
              draggable={false}
              className="size-full object-cover"
              fallback={<span className="app-mention-chip-initial">{mentionInitial(label)}</span>}
            />
          ) : (
            <span className="app-mention-chip-initial">{mentionInitial(label)}</span>
          )}
        </span>
        <span ref={receiptRef} className="app-mention-chip-receipt">
          <button
            type="button"
            className="app-mention-chip-receipt-button"
            data-read-state={resolution.state}
            {...(machineOffline ? { "data-machine-offline": "true" } : {})}
            aria-label={`${label}: ${stateCopy}`}
            aria-expanded={receiptOpen}
            aria-haspopup="dialog"
            title={stateCopy}
            onClick={() => setReceiptOpen((current) => !current)}
          >
            {resolution.state === "read" ? <Check className="size-2" strokeWidth={3} aria-hidden="true" /> : null}
            <span className="sr-only">{stateCopy}</span>
          </button>
          {receiptOpen && (
            <span
              role="dialog"
              aria-label={`Read receipt for ${label}`}
              data-testid="mention-read-receipt"
              className="app-mention-chip-receipt-popover"
            >
              <span className="app-mention-chip-receipt-name">@{label}</span>
              <span className="app-mention-chip-receipt-state" data-read-state={resolution.state}>
                {stateCopy}
              </span>
            </span>
          )}
        </span>
      </span>
      <span className="app-mention-chip-label">@{label}</span>
    </span>
  );
}

export function mentionReadStateCopy(state: "read" | "unread" | "unknown", machineOffline = false): string {
  if (state === "read") return "Read";
  if (state === "unread") return machineOffline ? "Unread · machine offline" : "Unread";
  return "Unknown";
}

function mentionInitial(label: string): string {
  return Array.from(label.trim())[0]?.toUpperCase() || "@";
}
