import { useEffect, useState } from "react";

/**
 * What an empty composer says: one of the things typing can open, in turn.
 * Each hint names a trigger the composer completes (@ mention-complete, /
 * slash-complete, [[ and # reference-complete), so the placeholder teaches
 * the composer instead of asking an open question.
 */
export const COMPOSER_HINTS = [
  "@ to summon an agent",
  "/ for commands",
  "[[ for pages",
  "# for channels",
] as const;

/** A rotating hint split into the trigger it teaches and the words after it; null for any other placeholder. */
export function composerHintParts(hint: string): { trigger: string; rest: string } | null {
  if (!(COMPOSER_HINTS as readonly string[]).includes(hint)) return null;
  const space = hint.indexOf(" ");
  return { trigger: hint.slice(0, space), rest: hint.slice(space) };
}

export const COMPOSER_HINT_INTERVAL_MS = 4000;

/**
 * What this composer can complete. Every hint it shows works there (Daniel 2026-11-24): `/` completes the
 * commands of a conversation's live Agents, so a composer with no conversation yet does not offer it; `#`
 * completes the reader's channels, where a channel list is at hand.
 */
export type ComposerHintScope = { commands: boolean; channels: boolean };

/** The hints a composer with `scope` shows, in turn. */
export function composerHints(scope: ComposerHintScope = { commands: true, channels: true }): readonly string[] {
  return COMPOSER_HINTS.filter((hint) => (hint.startsWith("/") ? scope.commands : hint.startsWith("#") ? scope.channels : true));
}

export function composerHintAt(step: number, scope?: ComposerHintScope): string {
  const hints = composerHints(scope);
  return hints[step % hints.length]!;
}

/** The hint to show now; it moves on only while `active` (the draft is empty). */
export function useComposerHint(active: boolean, scope?: ComposerHintScope): string {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setStep((current) => current + 1);
    }, COMPOSER_HINT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return composerHintAt(step, scope);
}
