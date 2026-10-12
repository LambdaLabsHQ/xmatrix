/* Helpers shared by the read-only Google report connectors (Search Console, AdSense, Analytics). */

const DAY_MS = 86_400_000;

/** A provider value as one table cell: bounded, on one line, without tabs. */
export function cell(value: unknown): string {
  return String(value ?? "").slice(0, 300).replace(/[\r\n\t]/gu, " ");
}

export function isoDate(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

/** The first and last of `days` whole UTC days ending today, as epoch milliseconds. */
export function trailingDays(days: number, now: number): { start: number; end: number } {
  const end = Math.floor(now / DAY_MS) * DAY_MS;
  return { start: end - (days - 1) * DAY_MS, end };
}

/** `key=value` words, each key known and given at most once; otherwise the usage line. */
export function keyedOptions(input: string, keys: readonly string[], usage: string): Map<string, string> | string {
  const options = new Map<string, string>();
  for (const word of input.trim().split(/\s+/u).filter(Boolean)) {
    const [key, value, ...rest] = word.split("=");
    if (!key || !value || rest.length || !keys.includes(key) || options.has(key)) return usage;
    options.set(key, value);
  }
  return options;
}
