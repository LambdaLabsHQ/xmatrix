/**
 * Bounded retry for post-commit live channel fanout.
 *
 * Relay authority commits a message and then publishes it to Relay Runtime outside
 * the request, so a rejected publish never fails the sender's write. Before
 * this policy the rejection was only logged: the message was durable, no
 * connected client ever received it, and nothing retried.
 *
 * Retrying live fanout is only safe when the attempt provably never reached a
 * socket. Relay Runtime broadcasts to its sockets and *then* builds its
 * response, so a non-ok status or a lost response can both follow a partial or
 * complete broadcast; replaying those would deliver the message twice, and the
 * Agent Instance path has no dedupe to absorb it. A Durable Object overload
 * rejection is different in kind: the platform refuses the request before the
 * object runs, which is exactly the failure that motivated this policy.
 *
 * So the predicate is deliberately narrow — overload rejections only — and the
 * budget is fixed and short, because the retry rides the committing object's
 * waitUntil and feeds load back into an object that is already refusing work.
 */

/** Total publish attempts, including the first. */
export const LIVE_DELIVERY_MAX_ATTEMPTS = 3;

/** Delay before attempt N+1. Length is LIVE_DELIVERY_MAX_ATTEMPTS - 1. */
export const LIVE_DELIVERY_RETRY_DELAYS_MS: readonly number[] = [100, 400];

/**
 * Relay Runtime answered and refused to broadcast. Never retried: the refusal
 * may have followed a partial fanout, and a validation refusal is deterministic.
 */
export class LiveDeliveryRejectedError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LiveDeliveryRejectedError";
  }
}

/**
 * Matches the Durable Object overload rejection. The platform surfaces it only
 * as an error message, so this is a string match by necessity; keep it narrow
 * rather than treating unrecognized transport errors as safe to replay.
 */
export function isRetriableLiveDeliveryFailure(error: unknown): boolean {
  if (error instanceof LiveDeliveryRejectedError) return false;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /durable object is overloaded/iu.test(message);
}

export interface LiveDeliveryRetryOptions {
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Observes every failed attempt, including the last. */
  onAttemptFailed?: (attempt: number, error: unknown) => void;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `publish` until it resolves, the attempt budget is spent, or it fails in
 * a way that cannot be safely replayed. Rethrows the final error so the caller
 * still owns terminal reporting.
 */
export async function publishWithLiveDeliveryRetry<T>(
  publish: (attempt: number) => Promise<T>,
  options: LiveDeliveryRetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? realSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= LIVE_DELIVERY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await publish(attempt);
    } catch (error) {
      lastError = error;
      options.onAttemptFailed?.(attempt, error);
      if (!isRetriableLiveDeliveryFailure(error)) break;
      const delay = LIVE_DELIVERY_RETRY_DELAYS_MS[attempt - 1];
      if (delay === undefined) break;
      await sleep(delay);
    }
  }
  throw lastError;
}
