/** `value` as a field map when it is a non-array object, else undefined. */
export function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return plainRecord(value) !== undefined;
}
