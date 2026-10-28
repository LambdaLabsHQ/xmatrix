/** Batch size for complete resource reads, never a limit on saved resources.
 * Callers use a stable keyset inside the owning session's existing deadline.
 * A failed batch fails the read; it must not return a truncated success.
 */
export const RESOURCE_PAGE_SIZE = 100;

export async function* resourcePages<Row, Cursor>(
  read: (after: Cursor | null) => Promise<readonly Row[]>,
  cursor: (row: Row) => Cursor,
  pageSize = RESOURCE_PAGE_SIZE,
): AsyncGenerator<readonly Row[]> {
  let after: Cursor | null = null;
  for (;;) {
    const rows = await read(after);
    if (rows.length) yield rows;
    if (rows.length < pageSize) return;
    after = cursor(rows[rows.length - 1]!);
  }
}
