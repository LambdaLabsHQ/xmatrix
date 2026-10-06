/**
 * Advance a fixed-rate schedule to the first slot strictly after `nowMs`.
 * Missed slots are coalesced into one due occurrence instead of replayed.
 */
export function nextAutomationRunAt(scheduledFor, intervalMinutes, nowMs) {
  const scheduledMs = Date.parse(scheduledFor);
  const intervalMs = Math.floor(intervalMinutes) * 60_000;
  if (!Number.isFinite(scheduledMs) || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 ||
      !Number.isFinite(nowMs)) {
    throw new TypeError("Automation cadence input is invalid");
  }
  const elapsed = Math.max(0, nowMs - scheduledMs);
  const steps = Math.floor(elapsed / intervalMs) + 1;
  return new Date(scheduledMs + steps * intervalMs).toISOString();
}
