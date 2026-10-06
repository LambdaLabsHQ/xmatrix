/**
 * Shared backoff for routes that wait on a Relay authority status transition.
 *
 * These waits used a flat 100 ms probe against a 20 s deadline, so one user
 * action could issue up to 200 Relay authority requests while its own request stayed
 * open. Every probe is a separate request to the single Authority object, so the
 * amplification lands on the same queue that the caller is already waiting in.
 *
 * The schedule keeps the caller's observable contract: the first probe is still
 * issued before any sleep, the deadline is never overshot because the last
 * delay is clamped to the time remaining, and a wait that never resolves still
 * ends at the same deadline with the same result. Only the number of probes
 * changes — roughly fourteen instead of two hundred.
 */

/** First delay. Matches the previous flat interval, so fast paths are unchanged. */
export const AUTHORITY_PROBE_INITIAL_DELAY_MS = 100;

/** Ceiling for a single delay, so a long wait still reacts within a few seconds. */
export const AUTHORITY_PROBE_MAX_DELAY_MS = 500;

/**
 * Delay before the probe following `attempt` (1-based), clamped to `remainingMs`.
 * Returns 0 when the deadline is spent, which callers treat as "stop".
 */
export function probeDelayMs(attempt: number, remainingMs: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError("Relay authority probe attempt must be a positive integer");
  }
  if (!(remainingMs > 0)) return 0;
  const uncapped = AUTHORITY_PROBE_INITIAL_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(uncapped, AUTHORITY_PROBE_MAX_DELAY_MS, remainingMs);
}

/** Production timer. Tests inject their own clock, so this stays private. */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sleeps the backoff for `attempt` and reports whether the caller should probe
 * again. `false` means the deadline is spent and the loop must exit.
 *
 * This is the sleep-first shape: the deadline is checked before sleeping, so a
 * sleep that starts inside the budget still earns its probe, matching what the
 * flat interval did. Loops that probe first want `probeAuthorityUntilTerminal`.
 */
export async function awaitAuthorityProbeBackoff(
  attempt: number,
  deadlineAtMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<boolean> {
  const delay = probeDelayMs(attempt, deadlineAtMs - now());
  if (delay <= 0) return false;
  await sleep(delay);
  return true;
}

/**
 * Polls `probe` until it returns a terminal value or the deadline is spent, and
 * resolves to `undefined` on timeout.
 *
 * This is the probe-first shape: the caller's first probe runs immediately, and
 * the deadline is re-checked *after* each sleep. A wait that only checks before
 * sleeping would issue one extra probe at the deadline instant, which is a
 * request to the object the whole policy exists to spare.
 */
export async function probeAuthorityUntilTerminal<T>(input: {
  deadlineAtMs: number;
  /** Resolves to a terminal value, or undefined to keep waiting. */
  probe: (attempt: number) => Promise<T | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T | undefined> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? realSleep;
  for (let attempt = 1; ; attempt += 1) {
    if (now() >= input.deadlineAtMs) return undefined;
    const terminal = await input.probe(attempt);
    if (terminal !== undefined) return terminal;
    if (!await awaitAuthorityProbeBackoff(attempt, input.deadlineAtMs, now, sleep)) return undefined;
  }
}
