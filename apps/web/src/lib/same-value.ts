import { sameValue } from "@xmatrix/protocol";
export { sameValue } from "@xmatrix/protocol";


/**
 * `next`, with every item that says what the `previous` item of its key said
 * kept as that item, and `previous` itself when each item stands where it did.
 * Whatever is keyed on an item's identity (row memos, per-message queries)
 * then sees only the items that changed.
 */
export function shareByKey<T>(previous: readonly T[], next: T[], key: (item: T) => string): T[] {
  const held = new Map(previous.map((item) => [key(item), item]));
  let unchanged = previous.length === next.length;
  const shared = next.map((item, index) => {
    const before = held.get(key(item));
    const kept = before !== undefined && sameValue(before, item) ? before : item;
    if (kept !== previous[index]) unchanged = false;
    return kept;
  });
  return unchanged ? (previous as T[]) : shared;
}
