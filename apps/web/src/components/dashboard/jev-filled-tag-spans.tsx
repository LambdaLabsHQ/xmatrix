"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { consumeJevFillArrival, formatDecisionTag, jevFillShouldArrive, noteJevReading, type JevFilledTag } from "./jev-filled-tags";

/** Time between two parameters entering the mention. */
const JEV_FILL_BEAT_MS = 260;
/** How long one parameter's own sweep runs (`jev-fill-arrive` in globals.css). */
const JEV_FILL_SWEEP_MS = 720;

/** Play the fill once when it arrives after the reader saw the choice still
 *  open: one more parameter every beat, in the order they were decided.
 *  Returns how many are drawn so far, or undefined once all are. A decision
 *  already present when the message opens stays lit and still. */
function useJevFillReveal(fillKey: string | undefined, count: number): number | undefined {
  const [shown, setShown] = useState<number>();
  useEffect(() => {
    if (!fillKey || count === 0 || !jevFillShouldArrive(fillKey)) return;
    let finished = false;
    consumeJevFillArrival(fillKey);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setShown(1);
    const timers = Array.from({ length: count - 1 }, (_, index) =>
      window.setTimeout(() => setShown(index + 2), (index + 1) * JEV_FILL_BEAT_MS));
    // The last parameter finishes its own sweep before the fill settles.
    timers.push(window.setTimeout(() => { finished = true; setShown(undefined); },
      (count - 1) * JEV_FILL_BEAT_MS + JEV_FILL_SWEEP_MS));
    return () => {
      timers.forEach(window.clearTimeout);
      // A strict-mode remount cancels the timers before they finish. Put the
      // arrival back so that remount still plays it once.
      if (!finished) noteJevReading(fillKey);
    };
  }, [fillKey, count]);
  return shown;
}

/** Parameters a decision filled, in the same highlight a written summon condition uses.
 *  Jev's choices and the Machine routing bound announce themselves separately.
 *  While the fill arrives, a parameter not yet revealed is not drawn at all, so
 *  the chip grows one parameter at a time instead of holding empty space. */
export function JevFilledTagSpans({ tags, fillKey }: { tags: readonly JevFilledTag[]; fillKey?: string }) {
  const shown = useJevFillReveal(fillKey, tags.length);
  if (!tags.length) return null;
  const arriving = shown !== undefined;
  const parts: ReactNode[] = [];
  let announced = "";
  for (const [index, tag] of tags.slice(0, shown ?? tags.length).entries()) {
    const source = tag.source ?? "jev";
    if (source !== announced) {
      parts.push(<span key={`filled-${source}-${index}`} className="sr-only">{source === "routing" ? " Routing filled" : " xMatrix filled"}</span>);
      announced = source;
    }
    parts.push(<Fragment key={`filled-gap-${tag.field}`}>{" "}</Fragment>);
    parts.push(<span key={`filled-${tag.field}`} className="app-summon-condition"
      data-jev={source === "jev" ? "true" : undefined}
      data-routing={source === "routing" ? "true" : undefined}
      data-jev-arriving={arriving ? "true" : undefined}>
      {formatDecisionTag(tag.field, tag.value)}
    </span>);
  }
  return <>{parts}</>;
}
