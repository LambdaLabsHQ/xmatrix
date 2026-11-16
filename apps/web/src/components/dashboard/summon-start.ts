import { isMentionOnlyRejection } from "@xmatrix/protocol";

/** A summon its send did not ask to start: it stays a mention, and its card offers Start. */
export const mentionOnly = isMentionOnlyRejection;

/** How long after sending a summon still reads as starting. A launch or
 *  refusal normally lands in 1–3 s; past this the mention is only the
 *  author's text and must not keep pretending to work. */
export const SUMMON_STARTING_WINDOW_MS = 30_000;

export function summonStartingUntil(sentAt: string | undefined, now: number): number | undefined {
  const sent = sentAt ? Date.parse(sentAt) : NaN;
  if (!Number.isFinite(sent)) return undefined;
  const until = sent + SUMMON_STARTING_WINDOW_MS;
  return until > now && sent <= now + 5_000 ? until : undefined;
}
