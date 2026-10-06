/** Normalize a stored timestamp to ISO; invalid values retain Date's RangeError. */
export function storedIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/** Stored object metadata, with absent or malformed values represented as empty. */
export function storedObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Normalize a timestamp while preserving the caller's boundary error. */
export function checkedStoredIso(value: string | Date, invalid: () => Error): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid();
  return date.toISOString();
}
