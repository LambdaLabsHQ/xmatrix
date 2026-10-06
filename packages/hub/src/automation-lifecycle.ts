export const AUTOMATION_RUN_TIMEOUT_DEFAULT_MS = 30 * 60_000;
const AUTOMATION_RUN_TIMEOUT_MIN_MS = 1_000;
const AUTOMATION_RUN_TIMEOUT_MAX_MS = 24 * 60 * 60_000;

export function resolveAutomationRunTimeoutMs(value: unknown): number {
  const configured = Number(value);
  return Number.isSafeInteger(configured) &&
      configured >= AUTOMATION_RUN_TIMEOUT_MIN_MS &&
      configured <= AUTOMATION_RUN_TIMEOUT_MAX_MS
    ? configured
    : AUTOMATION_RUN_TIMEOUT_DEFAULT_MS;
}
