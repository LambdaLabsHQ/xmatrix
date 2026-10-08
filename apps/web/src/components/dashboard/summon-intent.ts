import { parseAutoLaunchMentions, selectionLaunchConditions, type DraftSummonIntent,
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

/** The summons in an outgoing body Jev reads while the author types: launch
 *  mentions and picked Agents, each through its last condition (the text the
 *  Hub keys a launch by). `launch:force` already answers, and code spans,
 *  quotes and links are literal, so none of those is read. */
export function draftSummonRanges(body: string,
  selections: ReadonlyArray<{ start: number; end: number; text: string }> = []): Array<{ start: number; end: number }> {
  const ranges = new Map<number, { start: number; end: number }>();
  for (const mention of parseAutoLaunchMentions(body)) {
    if (!mention.error && mention.tags.launch !== "force") ranges.set(mention.start, { start: mention.start, end: mention.end });
  }
  for (const selection of selections) {
    const options = selectionLaunchConditions(body, selection);
    if (!options.error && options.tags.launch !== "force") ranges.set(selection.start, { start: selection.start, end: options.end });
  }
  return [...ranges.values()].sort((left, right) => left.start - right.start);
}

/** The faint words after the draft that say what sending will do with one summon. */
export function draftSummonHint(reading: DraftSummonIntent): string {
  const address = reading.mention.split(/\s/u)[0];
  if (reading.choice === "summon") return `${address} starts on send`;
  return `${address} won't start, read as ${DECLINED[reading.choice].reading} · launch:force starts it`;
}

/** Picked page/channel labels expand to id tokens when sent. Project preview
 * ranges back to the visible draft in summon order, preserving repeated names. */
export function draftSummonReadingsForDisplay(readings: ReadonlyArray<DraftSummonIntent>, body: string,
  selections: ReadonlyArray<{ start: number; end: number; text: string }> = []): DraftSummonIntent[] {
  const ranges = draftSummonRanges(body, selections);
  return readings.flatMap((reading, index) => {
    const range = ranges[index];
    return range && body.slice(range.start, range.end) === reading.mention ? [{ ...reading, ...range }] : [];
  });
}
