"use client";

import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { consumeJevFillArrival, formatDecisionTag, jevFillShouldArrive, noteJevReading, type JevFilledTag } from "./jev-filled-tags";

/** Play the fill once when it arrives after the reader saw the choice still
 *  open. A decision already present when the message opens stays lit and still. */
function useJevFillArriving(fillKey: string | undefined, count: number): boolean {
  const [arriving, setArriving] = useState(false);
  useEffect(() => {
    if (!fillKey || count === 0 || !jevFillShouldArrive(fillKey)) return;
    let finished = false;
    consumeJevFillArrival(fillKey);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    setArriving(true);
    const timer = window.setTimeout(() => { finished = true; setArriving(false); }, 720 + count * 80);
    return () => {
      window.clearTimeout(timer);
      // A strict-mode remount cancels the timer before it finishes. Put the
      // arrival back so that remount still plays it once.
      if (!finished) noteJevReading(fillKey);
    };
  }, [fillKey, count]);
  return arriving;
}

/** Parameters a decision filled, in the same highlight a written summon condition uses.
 *  Jev's choices and the Machine routing bound announce themselves separately. */
export function JevFilledTagSpans({ tags, fillKey }: { tags: readonly JevFilledTag[]; fillKey?: string }) {
  const arriving = useJevFillArriving(fillKey, tags.length);
  if (!tags.length) return null;
  const parts: ReactNode[] = [];
  let announced = "";
  for (const [index, tag] of tags.entries()) {
    const source = tag.source ?? "jev";
    if (source !== announced) {
      parts.push(<span key={`filled-${source}-${index}`} className="sr-only">{source === "routing" ? " Routing filled" : " Jev filled"}</span>);
      announced = source;
    }
    parts.push(<Fragment key={`filled-gap-${tag.field}`}>{" "}</Fragment>);
    parts.push(<span key={`filled-${tag.field}`} className="app-summon-condition"
      data-jev={source === "jev" ? "true" : undefined}
      data-routing={source === "routing" ? "true" : undefined}
      data-jev-arriving={arriving ? "true" : undefined}
      style={{ "--jev-fill-index": index } as CSSProperties}>
      {formatDecisionTag(tag.field, tag.value)}
    </span>);
  }
  return <>{parts}</>;
}
