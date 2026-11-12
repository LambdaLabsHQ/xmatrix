/**
 * Find in page: where a query stands in the page's text. The text is the
 * page's text nodes joined in reading order, with a line break between blocks
 * so a match never runs from one paragraph into the next.
 */

/** Each match's start and end in the joined text. Case is ignored, as in a
 * browser's find, and a run of spaces in the query matches any run of spaces. */
export function pageFindMatches(text: string, query: string): Array<[number, number]> {
  const needle = query.trim();
  if (!needle) return [];
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[^\\S\\n]+"), "giu");
  const matches: Array<[number, number]> = [];
  for (const match of text.matchAll(pattern)) {
    matches.push([match.index, match.index + match[0].length]);
  }
  return matches;
}

/** The match to show first: the first one at or below the reader's place. */
export function pageFindFirstFrom(tops: readonly number[], from: number): number {
  const index = tops.findIndex((top) => top >= from);
  return index === -1 ? 0 : index;
}

/** One step through the matches, round the ends. */
export function pageFindStep(current: number, count: number, step: 1 | -1): number {
  if (count === 0) return 0;
  return (current + step + count) % count;
}
