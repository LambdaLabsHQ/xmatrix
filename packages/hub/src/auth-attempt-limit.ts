import type { Env } from "./types";

/**
 * Exact per-key attempt counts for sign-in endpoints, kept in the device
 * login broker's Durable Object. One object sees every attempt, so a caller
 * cannot spread its attempts across isolates or edge locations the way it
 * can with an isolate's memory or the Workers Rate Limiting binding, neither
 * of which refused anyone in production.
 */

/** Attempts are counted over this rolling window unless a counter names its own. */
export const ATTEMPT_WINDOW_MS = 60_000;

/** The longest window a counter may name. */
export const MAX_ATTEMPT_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** One counter to charge, and how many attempts it allows per window. */
export interface AttemptLimit {
  key: string;
  max: number;
  /** A longer rolling window than ATTEMPT_WINDOW_MS, such as a day. */
  windowMs?: number;
}

/** Where the broker keeps a counter. A counter with its own window carries it
 * in the key, so pruning knows when its newest attempt has left the window. */
export function attemptStorageKey(limit: AttemptLimit): string {
  return limit.windowMs ? `attempts:window-${limit.windowMs}:${limit.key}` : `attempts:${limit.key}`;
}

/** The window of a counter kept under `storageKey`. */
export function attemptWindowMs(storageKey: string): number {
  const named = /^attempts:window-(\d+):/u.exec(storageKey);
  return named ? Number(named[1]) : ATTEMPT_WINDOW_MS;
}

/**
 * Whether one more attempt fits every counter, given each counter's recent
 * attempt times. Admitted attempts are charged to every counter; a refused
 * one is charged to none, so being refused does not extend the wait.
 */
export function chargeAttempt(recent: readonly number[][], limits: readonly AttemptLimit[], now: number):
  { admitted: boolean; next: number[][] } {
  const live = recent.map((times, index) =>
    times.filter((time) => time > now - (limits[index].windowMs ?? ATTEMPT_WINDOW_MS)));
  const admitted = limits.every((limit, index) => live[index].length < limit.max);
  return { admitted, next: admitted ? live.map((times) => [...times, now]) : live };
}

/** Asks the broker to charge one attempt to every counter; false when any is spent. */
export async function admitAttempt(env: Pick<Env, "DEVICE_AUTH">, limits: AttemptLimit[]): Promise<boolean> {
  const broker = env.DEVICE_AUTH.get(env.DEVICE_AUTH.idFromName("default"));
  const response = await broker.fetch("https://device-auth/internal/attempts/admit", {
    method: "POST",
    body: JSON.stringify({ limits }),
  });
  if (!response.ok) throw new Error(`Sign-in attempt counter answered ${response.status}`);
  return ((await response.json()) as { admitted: boolean }).admitted;
}
