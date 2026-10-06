"use client";

import { useEffect, useRef } from "react";

import { resolvedTimeZone } from "./time-display";

/**
 * Keep the stored zone equal to the one this browser is actually rendering in.
 *
 * Nobody is asked to pick a zone. A person who has flown somewhere is not
 * thinking about their profile, and a zone they set once and forgot is worse
 * than none: it reads as a fact and is a memory. The browser already knows,
 * and it is right every time, so it reports.
 *
 * Only on a difference. The profile write bumps `profileVersion` and fans out
 * to every store that mirrors it, so a write on each page load would be a
 * steady stream of no-op revisions across the whole directory.
 */
export function useHumanTimeZoneSync(
  storedTimeZone: string | undefined,
  report: (timeZone: string) => void | Promise<unknown>,
  enabled = true,
): void {
  /* Held in a ref so a report that is already in flight is not repeated by a
     re-render that has not yet seen the new stored value. */
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const timeZone = resolvedTimeZone();
    if (!timeZone || timeZone === storedTimeZone) return;
    if (reportedRef.current === timeZone) return;
    reportedRef.current = timeZone;
    /* Best effort by design: a failed report leaves the stored zone as it was,
       which is the state the product already handles, and is not worth
       interrupting anyone over. */
    void Promise.resolve(report(timeZone)).catch(() => undefined);
  }, [enabled, storedTimeZone, report]);
}
