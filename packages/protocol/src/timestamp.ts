/** Strict bounded RFC3339 instant with optional 1-9 digit fractional seconds. */
export function rfc3339TimestampEpochNanoseconds(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !value || value.length > 64 || value.trim() !== value) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([zZ]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[10] ?? "0");
  const offsetMinute = Number(match[11] ?? "0");
  if (hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 23 || offsetMinute > 59) return undefined;
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 ||
      local.getUTCDate() !== day || local.getUTCHours() !== hour ||
      local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) return undefined;
  const offsetSign = match[9] === "-" ? -1 : 1;
  const epochMilliseconds = local.getTime() -
    offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const utcYear = new Date(epochMilliseconds).getUTCFullYear();
  const fractionalNanoseconds = BigInt((match[7] ?? "").padEnd(9, "0") || "0");
  return Number.isSafeInteger(epochMilliseconds) && utcYear >= -9_999 && utcYear <= 9_999
    ? BigInt(epochMilliseconds) * 1_000_000n + fractionalNanoseconds
    : undefined;
}
