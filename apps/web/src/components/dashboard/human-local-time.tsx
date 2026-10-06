"use client";

import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatLocalClock, resolvedTimeZone } from "./time-display";

/**
 * What time it is where this person is.
 *
 * The point is not the clock, it is the hour. A colleague who has not answered
 * for three hours has done something very different depending on whether those
 * three hours were their afternoon or their night, and nothing else in the
 * product can tell those two apart. This is also the only place the product
 * ever states someone else's zone, which is what makes a quoted "4:23 AM"
 * resolvable after the fact.
 *
 * Renders nothing when the zone is unknown — an account whose client has not
 * reported one, or one that predates the column. Showing the viewer's own
 * clock under someone else's name would be worse than showing nothing: it
 * reads as a fact about them and is a fact about you.
 */
export function HumanLocalTime({
  timeZone,
  className,
}: {
  timeZone: string | undefined;
  className?: string;
}) {
  const label = useHumanLocalTimeLabel(timeZone);
  if (!label) return null;
  return (
    <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <Clock3 className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </p>
  );
}

/**
 * The label, or `undefined` when there is nothing honest to say.
 *
 * Rendered on the client only: the server and the browser can sit in different
 * zones, and a clock that arrives in the markup would be replaced a frame later
 * by a different one, which React reports as a hydration mismatch and a reader
 * sees as a value that changed by itself.
 */
function useHumanLocalTimeLabel(timeZone: string | undefined): string | undefined {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    /* A minute is the resolution shown, so a minute is how often it moves. */
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!timeZone || !now) return undefined;
  /* Their zone matching the reader's makes the line pure noise: it would say
     the time the reader can already see on their own screen. */
  if (timeZone === resolvedTimeZone()) return undefined;
  const clock = formatLocalClock(now, undefined, timeZone);
  return clock ? `${clock} local time` : undefined;
}
