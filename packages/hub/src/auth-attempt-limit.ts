import { sha256Hex } from "@xmatrix/protocol";
import type { Env } from "./types";

/**
 * Exact per-key attempt counts for sign-in endpoints, kept in the device
 * login broker's Durable Object. One object sees every attempt, so a caller
 * cannot spread its attempts across isolates or edge locations the way it
 * can with an isolate's memory or the Workers Rate Limiting binding, neither
 * of which refused anyone in production.
 */

/** Attempts are counted over this rolling window unless a limit names its own. */
export const ATTEMPT_WINDOW_MS = 60_000;

/** The longest window a limit may name; a counter idle this long is forgotten. */
export const MAX_ATTEMPT_WINDOW_MS = 24 * 60 * 60_000;

/** One counter to charge, and how many attempts it allows per window. */
export interface AttemptLimit {
  key: string;
  max: number;
  /** Defaults to ATTEMPT_WINDOW_MS; at most MAX_ATTEMPT_WINDOW_MS. */
  windowMs?: number;
}

/**
 * Whether one more attempt fits every counter, given each counter's recent
 * attempt times. Admitted attempts are charged to every counter; a refused
 * one is charged to none, so being refused does not extend the wait.
 */
export function chargeAttempt(recent: readonly number[][], limits: readonly AttemptLimit[], now: number):
  { admitted: boolean; next: number[][] } {
  const live = recent.map((times, index) =>
    times.filter((time) => time > now - (limits[index]?.windowMs ?? ATTEMPT_WINDOW_MS)));
  const admitted = limits.every((limit, index) => live[index].length < limit.max);
  return { admitted, next: admitted ? live.map((times) => [...times, now]) : live };
}

/**
 * The counters a login code sent to one address is charged to, whichever
 * route asks for it. Each code allows three guesses, so the daily allowance
 * bounds how many guesses anyone can make at one address.
 */
export async function loginEmailAttemptLimits(email: string): Promise<AttemptLimit[]> {
  const key = `login:email:${await sha256Hex(email.trim().toLowerCase())}`;
  return [
    { key, max: 5 },
    { key: `${key}:hour`, max: 20, windowMs: 60 * 60_000 },
    { key: `${key}:day`, max: 60, windowMs: MAX_ATTEMPT_WINDOW_MS },
  ];
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
