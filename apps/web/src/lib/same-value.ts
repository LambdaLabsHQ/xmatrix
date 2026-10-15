/**
 * Whether two values say the same: the same primitive or function, arrays,
 * Maps and plain objects whose entries say the same, or Sets of the same
 * members. A key holding `undefined` says nothing, so it reads as an absent
 * key. Any other object is only itself.
 *
 * Display data is compared by what it holds, never by a list of its fields: a
 * list falls behind the first field added after it, and the screen then keeps
 * showing the old value of that field.
 */
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameValue(left[index], right[index])) return false;
    }
    return true;
  }
  if (left instanceof Map) {
    if (!(right instanceof Map) || left.size !== right.size) return false;
    for (const [key, value] of left) {
      if (!right.has(key) || !sameValue(value, right.get(key))) return false;
    }
    return true;
  }
  if (left instanceof Set) {
    if (!(right instanceof Set) || left.size !== right.size) return false;
    for (const member of left) if (!right.has(member)) return false;
    return true;
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  // `for…in` rather than Object.keys: timelines compare every row on every
  // rebuild, and it walks a plain object's own keys without a copy of them.
  let defined = 0;
  for (const key in left) {
    if (left[key] === undefined) continue;
    defined += 1;
    if (!sameValue(left[key], right[key])) return false;
  }
  for (const key in right) {
    if (right[key] !== undefined) defined -= 1;
  }
  return defined === 0;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

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
