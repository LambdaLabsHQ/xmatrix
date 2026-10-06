"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { parsePresentedRoutingDecision, type SerializedAgentLaunch } from "@xmatrix/protocol";
import { avatarImageSrc } from "./identity-avatar";
import { JevFilledTagSpans } from "./jev-filled-tag-spans";
import { jevFilledAnnouncement, jevFilledTagsForHandoff, launchMachineLabel, noteJevReading, type JevFilledTag } from "./jev-filled-tags";
import { HANDOFF_UNRECORDED_FLIGHT_MS, handoffView, invocationVendorIcon, summonView, type HandoffSide, type HandoffView } from "./mention-invocation-state";

/** One Agent of a handoff, drawn as the mention chip it is, in its own tone.
 *  Fills sit in the label, before the status, the same place a summon puts them. */
function HandoffEnd({ name, ordinal, avatarUrl, auto, side, filled, fillKey }: {
  name: string; ordinal?: number; avatarUrl?: string; auto?: boolean; side: HandoffSide;
  filled?: readonly JevFilledTag[]; fillKey?: string;
}) {
  const image = auto ? undefined : avatarImageSrc(invocationVendorIcon({ targetAvatarUrl: avatarUrl, targetName: name }));
  return <span className="app-mention-chip app-mention-invocation" data-tone={side.tone}>
    <span className="app-mention-chip-avatar" aria-hidden="true">
      <span className="app-mention-chip-avatar-face">
        {auto ? <Sparkles className="app-mention-chip-initial" />
          : image ? // eslint-disable-next-line @next/next/no-img-element -- Arbitrary identity avatar, same boundary as mention chips.
            <img src={image} alt="" referrerPolicy="no-referrer" draggable={false} />
            : <span className="app-mention-chip-initial">{name[0]?.toUpperCase() || "@"}</span>}
      </span>
    </span>
    <span className="app-mention-chip-label">@{auto ? "auto" : name}{ordinal !== undefined && <>:{ordinal}</>}
      {filled && <JevFilledTagSpans tags={filled} fillKey={fillKey} />}
    </span>
    {side.label && <span className="app-mention-invocation-status">
      <span aria-hidden="true">·</span><span className="app-mention-invocation-step"
        data-state={side.tone === "active" ? "current" : side.tone === "error" ? "failed" : undefined}>{side.label}</span>
    </span>}
  </span>;
}

/** `@source:n:handoff:@successor` drawn as what it does: the work leaves one
 *  Agent and arrives at the other, each with its own state. The successor is
 *  the Agent that took it when known, else the one written (`@auto` until
 *  xMatrix picks). */
export function HandoffArrowLabel({ sourceName, sourceOrdinal, successorName, successorAvatarUrl, view, filled, fillKey }: {
  sourceName: string; sourceOrdinal: number; successorName: string; successorAvatarUrl?: string; view: HandoffView;
  filled?: readonly JevFilledTag[]; fillKey?: string;
}) {
  const auto = successorName.trim().toLowerCase() === "auto";
  return <>
    <HandoffEnd name={sourceName} ordinal={sourceOrdinal} side={view.source} />
    <span className="app-handoff-arrow" aria-hidden="true" data-flowing={view.flowing ? "true" : undefined}
      data-tone={view.successor.tone}>
      <svg viewBox="0 0 44 12" width="44" height="12">
        <path className="app-handoff-line" d="M2 6h38" pathLength="40" />
        <path className="app-handoff-comet" d="M2 6h38" pathLength="40" />
        <path className="app-handoff-head" d="M36 1.5l4.5 4.5-4.5 4.5" />
      </svg>
    </span>
    <HandoffEnd name={successorName} avatarUrl={successorAvatarUrl} auto={auto} side={view.successor}
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
export function HandoffCard({ sourceName, sourceOrdinal, successorName, sentAt, launch, fillKey }: {
  sourceName: string; sourceOrdinal: number; successorName: string; sentAt?: string;
  launch?: SerializedAgentLaunch; fillKey?: string;
}) {
  const auto = successorName.trim().toLowerCase() === "auto";
  const fresh = useFresh(sentAt, HANDOFF_UNRECORDED_FLIGHT_MS);
  const picked = launch ? summonView(launch) : undefined;
  const base = handoffView(undefined, { auto, fresh });
  const view: HandoffView = picked
    ? { ...base, successor: { label: picked.label, tone: picked.tone }, flowing: picked.tone === "active" }
    : base;
  const decision = parsePresentedRoutingDecision(launch?.routingDecision);
  const filled = jevFilledTagsForHandoff(successorName, decision?.parameters, launchMachineLabel(decision));
  const announcement = jevFilledAnnouncement(filled);
  useEffect(() => {
    // Only a reader who saw the choice still open gets the arrival. History
    // that already carries the decision stays lit and still.
    if (auto && !launch && fresh && fillKey) noteJevReading(fillKey);
  }, [auto, launch, fresh, fillKey]);
  return <span className="app-mention-handoff" aria-label={`@${sourceName}:${sourceOrdinal} hands off to @${successorName}${announcement ? `. ${announcement}` : ""}`}>
    <HandoffArrowLabel sourceName={sourceName} sourceOrdinal={sourceOrdinal} successorName={successorName}
      view={view} filled={filled} fillKey={fillKey} />
  </span>;
}
