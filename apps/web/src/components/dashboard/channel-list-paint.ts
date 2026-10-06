/** Rows to paint while a conversation list refreshes.
 *
 * A loaded answer, including an empty one, replaces whatever was held.
 * Until that answer, keep the last painted rows, then a disk snapshot.
 * The skeleton is only for a list that still has nothing to paint.
 */
export function channelRowsForPaint<T>(input: {
  loaded: boolean;
  live: readonly T[];
  /** Last rows this list painted. Null means it has not painted an answer yet. */
  held: readonly T[] | null;
  fallback: readonly T[];
}): { rows: readonly T[]; held: readonly T[] | null; confirmed: boolean } {
  if (input.loaded) {
    return { rows: input.live, held: input.live, confirmed: true };
  }
  if (input.held !== null) {
    return { rows: input.held, held: input.held, confirmed: true };
  }
  return { rows: input.fallback, held: null, confirmed: false };
}
