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
