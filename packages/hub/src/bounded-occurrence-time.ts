const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** Preserve a trusted component's event time without accepting unbounded clocks. */
export function boundedOccurrenceAt(value: unknown, now = Date.now()): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && Math.abs(parsed - now) <= MAX_CLOCK_SKEW_MS
    ? new Date(parsed).toISOString()
    : new Date(now).toISOString();
}
