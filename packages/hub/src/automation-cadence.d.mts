/**
 * Type declarations for the pure cadence helper (JS runtime module).
 */
export function nextAutomationRunAt(
  scheduledFor: string,
  intervalMinutes: number,
  nowMs: number,
): string;
