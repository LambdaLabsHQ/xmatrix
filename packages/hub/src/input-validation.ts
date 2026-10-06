/** Require nonblank text without normalizing persisted identities or digest inputs. */
export function requireNonblankText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is invalid`);
  return value;
}
