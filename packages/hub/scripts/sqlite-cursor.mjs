/** The Durable Object SQL cursor exposes its rows both as an array and an iterator. */
export function sqliteCursor(rows = []) {
  return { toArray: () => rows, *[Symbol.iterator]() { yield* rows; } };
}
