/**
 * How search orders what it found: by how well the text matches, then by how
 * recently it was active. The kind of thing found plays no part, so a
 * conversation from today is not pushed below an old one because of its id,
 * nor a page below a person because of its kind. Pure; no React.
 */

/** 0 the whole title, 1 the title's start, 2 anywhere in the title, 3 only in other text. */
export type SearchMatchTier = 0 | 1 | 2 | 3;

export type SearchRank = { tier: SearchMatchTier; activityMs: number };

/** Lowercased and trimmed, without a leading `#` or `@`, as search compares text. */
export function normalizeSearchNeedle(value: string): string {
  return value.trim().replace(/^[#@]/u, "").toLocaleLowerCase();
}

export function searchMatchTier(needle: string, title: string): SearchMatchTier {
  const wanted = normalizeSearchNeedle(needle);
  const text = normalizeSearchNeedle(title);
  if (!wanted) return 3;
  if (text === wanted) return 0;
  if (text.startsWith(wanted)) return 1;
  return text.includes(wanted) ? 2 : 3;
}

export function searchActivityMs(...timestamps: Array<string | null | undefined>): number {
  let latest = 0;
  for (const timestamp of timestamps) {
    const value = timestamp ? Date.parse(timestamp) : Number.NaN;
    if (Number.isFinite(value) && value > latest) latest = value;
  }
  return latest;
}

export function compareSearchRank(left: SearchRank, right: SearchRank): number {
  return left.tier - right.tier || right.activityMs - left.activityMs;
}

/** Best first; equal ranks keep their given order. */
export function rankSearchResults<T>(items: readonly T[], rankOf: (item: T) => SearchRank): T[] {
  return items
    .map((item, index) => ({ item, index, rank: rankOf(item) }))
    .sort((left, right) => compareSearchRank(left.rank, right.rank) || left.index - right.index)
    .map((entry) => entry.item);
}

/** One result as Jev reads it: what it is, its title and one line about it. */
export type SearchRerankCandidate = { key: string; kind: string; title: string; detail?: string };

/** How likely each result is what the search is for, and the one most likely. */
export type SearchRerankReading = { results: Array<{ key: string; probability: number }>; best: string | null };

/** The Space is not on Pro, so its searches are not sent to Jev. */
export class SearchRerankUnavailable extends Error {
  constructor() { super("search_rerank_unavailable"); }
}

/** Below this Jev reads a result as not what the search is for; it moves last but stays. */
const UNLIKELY = 0.1;

/**
 * Reorders ranked results by Jev's reading. Whole-title matches keep the top;
 * then Jev's best, then the rest it read by likelihood, then what it was not
 * shown, then what it read as unlikely. Nothing is added or removed.
 */
export function applySearchRerank<T>(items: readonly T[], keyOf: (item: T) => string,
  tierOf: (item: T) => SearchMatchTier, reading: SearchRerankReading | null): T[] {
  if (!reading) return [...items];
  const probability = new Map(reading.results.map((result) => [result.key, result.probability]));
  const place = (item: T): [number, number] => {
    if (tierOf(item) === 0) return [0, 0];
    const key = keyOf(item);
    if (key === reading.best) return [1, 0];
    const likely = probability.get(key);
    if (likely === undefined) return [3, 0];
    return likely < UNLIKELY ? [4, -likely] : [2, -likely];
  };
  return items
    .map((item, index) => ({ item, index, place: place(item) }))
    .sort((left, right) => left.place[0] - right.place[0] || left.place[1] - right.place[1] || left.index - right.index)
    .map((entry) => entry.item);
}
