"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { parseHandoffInstanceMentions, parsePresentedRoutingDecision, type AutoLaunchCondition, type AutoLaunchTags, type FaceOf, type SerializedAgentLaunch } from "@xmatrix/protocol";
import { JevFilledTagSpans } from "./jev-filled-tag-spans";
import { jevFilledAnnouncement, jevFilledTagsForHandoff, launchMachineLabel, noteJevReading, type JevFilledTag } from "./jev-filled-tags";
import { MentionChipFace } from "./mention-chip-face";
import { HANDOFF_UNRECORDED_FLIGHT_MS, addressedAgentFace, handoffView, launchFace, summonView, type HandoffSide,
  type HandoffView } from "./mention-invocation-state";

/** One Agent of a handoff, drawn as the mention chip it is, in its own tone.
 *  Fills sit in the label, before the status, the same place a summon puts them. */
function HandoffEnd({ name, ordinal, labelContent, face, auto, side, filled, fillKey }: {
  name: string; ordinal?: number; labelContent?: ReactNode; face: FaceOf; auto?: boolean; side: HandoffSide;
  filled?: readonly JevFilledTag[]; fillKey?: string;
}) {
  return <span className="app-mention-chip app-mention-invocation" data-tone={side.tone}>
    <span className="app-mention-chip-avatar" aria-hidden="true">
      <span className="app-mention-chip-avatar-face">
        {auto ? <Sparkles className="app-mention-chip-initial" /> : <MentionChipFace of={face} />}
      </span>
    </span>
    <span className="app-mention-chip-label">{labelContent ?? <>@{auto ? "auto" : name}{ordinal !== undefined && <>:{ordinal}</>}</>}
      {filled && <JevFilledTagSpans tags={filled} fillKey={fillKey} />}
    </span>
    {side.label && <span className="app-mention-invocation-status">
      <span aria-hidden="true">·</span><span className="app-mention-invocation-step"
        data-state={side.tone === "active" ? "current" : side.tone === "error" ? "failed" : undefined}>{side.label}</span>
    </span>}
  </span>;
}

/** The written successor expression with each `key:value` condition highlighted where it sits. */
function WrittenSuccessorLabel({ text, conditions }: { text: string; conditions: readonly AutoLaunchCondition[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const condition of conditions) {
    if (condition.start > cursor) parts.push(<Fragment key={`gap-${cursor}`}>{text.slice(cursor, condition.start)}</Fragment>);
    parts.push(<span key={condition.start} className="app-summon-condition">
      {text.slice(condition.start, condition.valueStart)}
      {text.slice(condition.valueStart, condition.end)}
    </span>);
    cursor = condition.end;
  }
  if (cursor < text.length) parts.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>);
  return <>{parts}</>;
}

/** What a handoff's author wrote for its successor, read back from the stored
 *  mention: the label with each condition marked, plus the picks its launch
 *  added. A recorded handoff keeps drawing what was asked for after the
 *  successor took over, as the unrecorded card does while it is in flight. */
export function writtenHandoffSuccessor(mention: string, launch?: SerializedAgentLaunch) {
  const written = parseHandoffInstanceMentions(mention)[0];
  if (!written) return {};
  const text = mention.slice(written.successorStart, written.end);
  const conditions = written.conditions.map(condition => ({ ...condition,
    start: condition.start - written.successorStart, end: condition.end - written.successorStart,
    valueStart: condition.valueStart - written.successorStart }));
  const decision = parsePresentedRoutingDecision(launch?.routingDecision);
  return {
    label: conditions.length ? <WrittenSuccessorLabel text={text} conditions={conditions} /> : undefined,
    filled: launch ? jevFilledTagsForHandoff(written.successorName, decision?.parameters,
      launchMachineLabel(decision, written.tags.machine), written.tags) : undefined,
  };
}

/** `@source:n:handoff:@successor [conditions]` drawn as what it does: the work leaves
 *  one Agent and arrives at the other, each with its own state. The successor is
 *  the Agent that took it when known, else the one written (`@auto` or condition-first
 *  until xMatrix picks). */
export function HandoffArrowLabel({ sourceName, sourceOrdinal, sourceFace, successorName, successorLabel, successorFace,
  successorAuto, view, filled, fillKey }: {
  sourceName: string; sourceOrdinal: number; sourceFace: FaceOf; successorName: string; successorLabel?: ReactNode;
  successorFace: FaceOf; successorAuto?: boolean; view: HandoffView; filled?: readonly JevFilledTag[]; fillKey?: string;
}) {
  const auto = successorAuto ?? (successorName.trim().toLowerCase() === "auto");
  return <>
    <HandoffEnd name={sourceName} ordinal={sourceOrdinal} face={sourceFace} side={view.source} />
    <span className="app-handoff-arrow" aria-hidden="true" data-flowing={view.flowing ? "true" : undefined}
      data-tone={view.successor.tone}>
      <svg viewBox="0 0 44 12" width="44" height="12">
        <path className="app-handoff-line" d="M2 6h38" pathLength="40" />
      </svg>
      <span className="app-handoff-comet-window"><span className="app-handoff-comet" /></span>
      <span className="app-handoff-head">
        <svg viewBox="0 0 44 12" width="44" height="12">
          <path d="M36 1.5l4.5 4.5-4.5 4.5" />
        </svg>
      </span>
    </span>
    <HandoffEnd name={successorName} labelContent={successorLabel} face={successorFace} auto={auto} side={view.successor}
      filled={filled} fillKey={fillKey} />
  </>;
}

/** Whether a message sent at `sentAt` is still inside its flight window;
 *  re-renders once when the window closes. */
function useFresh(sentAt: string | undefined, windowMs: number): boolean {
  const sent = sentAt ? Date.parse(sentAt) : NaN;
  const [now, setNow] = useState(() => Date.now());
  const fresh = Number.isFinite(sent) && now - sent < windowMs;
  useEffect(() => {
    if (!fresh) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, sent + windowMs - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [fresh, sent, windowMs]);
  return fresh;
}

/** A handoff the Channel has no successor record for: being picked, or
 *  moving to another machine. In flight while fresh, then names alone.
 *  A launch drawn on this mention replaces "Picking" with that launch's
 *  status and appends the same picks a summon shows. The stored message is unchanged. */
export function HandoffCard({ sourceName, sourceOrdinal, successorName, successorText, conditionFirst, tags, conditions,
  sentAt, launch, fillKey }: {
  sourceName: string; sourceOrdinal: number; successorName: string;
  successorText?: string; conditionFirst?: boolean; tags?: AutoLaunchTags; conditions?: readonly AutoLaunchCondition[];
  sentAt?: string; launch?: SerializedAgentLaunch; fillKey?: string;
}) {
  const auto = (Boolean(conditionFirst) && !tags?.harness) || successorName.trim().toLowerCase() === "auto";
  const fresh = useFresh(sentAt, HANDOFF_UNRECORDED_FLIGHT_MS);
  const picked = launch ? summonView(launch) : undefined;
  const base = handoffView(undefined, { auto, fresh });
  const view: HandoffView = picked
    ? { ...base, successor: { label: picked.label, tone: picked.tone }, flowing: picked.tone === "active" }
    : base;
  const decision = parsePresentedRoutingDecision(launch?.routingDecision);
  const filled = jevFilledTagsForHandoff(successorName, decision?.parameters,
    launchMachineLabel(decision, tags?.machine), tags);
  const announcement = jevFilledAnnouncement(filled);
  const successorLabel = successorText && conditions?.length
    ? <WrittenSuccessorLabel text={successorText} conditions={conditions} />
    : undefined;
  useEffect(() => {
    // Only a reader who saw the choice still open gets the arrival. History
    // that already carries the decision stays lit and still.
    if (auto && !launch && fresh && fillKey) noteJevReading(fillKey);
  }, [auto, launch, fresh, fillKey]);
  return <span className="app-mention-handoff" aria-label={`@${sourceName}:${sourceOrdinal} hands off to ${successorText ?? `@${successorName}`}${announcement ? `. ${announcement}` : ""}`}>
    <HandoffArrowLabel sourceName={sourceName} sourceOrdinal={sourceOrdinal}
      sourceFace={addressedAgentFace({ name: sourceName, address: `@${sourceName}` })}
      successorName={successorName} successorLabel={successorLabel} successorAuto={auto && !launch}
      successorFace={launch ? launchFace(launch, successorName)
        : addressedAgentFace({ name: successorName, address: `@${successorName}` })}
      view={view} filled={filled} fillKey={fillKey} />
  </span>;
}
