import { useEffect, useState } from "react";

/**
 * What an empty composer says: one of the things typing can open, in turn.
 * Each hint names a trigger the composer completes (@ mention-complete, /
 * slash-complete, [[ and # reference-complete), so the placeholder teaches
 * the composer instead of asking an open question.
 */
export const COMPOSER_HINTS = [
  "@ to mention",
  "/ for commands",
  "[[ for pages",
  "# for channels",
] as const;

export const COMPOSER_HINT_INTERVAL_MS = 4000;

export function composerHintAt(step: number): string {
  return COMPOSER_HINTS[step % COMPOSER_HINTS.length]!;
}

/** The hint to show now; it moves on only while `active` (the draft is empty). */
export function useComposerHint(active: boolean): string {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setStep((current) => current + 1);
    }, COMPOSER_HINT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return composerHintAt(step);
}
