import { parseAutoLaunchMentions, type AutoLaunchMention,
  type SummonIntentCategory } from "@xmatrix/protocol";

/** Jev's reading of a launch mention, as the refusal code recorded it. */
export type DeclinedIntent = Exclude<SummonIntentCategory, "summon">;

const DECLINED: Record<DeclinedIntent, { reading: string; short: string }> = {
  reference: { reading: "naming the Agent", short: "Mentioned" },
  explanation: { reading: "an explanation or report", short: "Explained" },
  example: { reading: "an example or quotation", short: "Quoted" },
};

export function declinedIntent(code: string): DeclinedIntent | undefined {
  const category = code.startsWith("summon_intent_") ? code.slice("summon_intent_".length) : "";
  return Object.hasOwn(DECLINED, category) ? category as DeclinedIntent : undefined;
}

export function declinedIntentCopy(category: DeclinedIntent) { return DECLINED[category]; }

/** How long after sending a written summon still reads as Jev deciding. A
 *  launch or refusal normally lands in 1–3 s; past this the mention is only
 *  the author's text and must not keep pretending to work. */
export const INTENT_READING_WINDOW_MS = 30_000;

export function readingIntentUntil(sentAt: string | undefined, now: number): number | undefined {
  const sent = sentAt ? Date.parse(sentAt) : NaN;
  if (!Number.isFinite(sent)) return undefined;
  const until = sent + INTENT_READING_WINDOW_MS;
  return until > now && sent <= now + 5_000 ? until : undefined;
}

export type DraftSummon = { mention: AutoLaunchMention; forced: boolean };

/** Launch mentions the Hub will act on, in the order written. Code spans,
 *  quotes and links are literal and never reach Jev. */
export function draftSummons(draft: string): DraftSummon[] {
  return parseAutoLaunchMentions(draft).filter(mention => !mention.error)
    .map(mention => ({ mention, forced: mention.tags.launch === "force" }));
}

/** Add or remove `launch:force` on one summon; the rest of the draft is untouched. */
export function toggleLaunchForce(draft: string, mention: AutoLaunchMention): { draft: string; caret: number } {
  const condition = mention.conditions.find(item => item.field === "launch");
  if (condition) {
    // Remove the condition with the break that introduced it.
    let from = condition.start;
    while (from > mention.start && /[\t\p{Zs}]/u.test(draft[from - 1]!)) from--;
    return { draft: draft.slice(0, from) + draft.slice(condition.end), caret: from };
  }
  const insert = " launch:force";
  return { draft: draft.slice(0, mention.end) + insert + draft.slice(mention.end), caret: mention.end + insert.length };
}
