/**
 * A Durable Object call that failed because the object was moving, not
 * because the request was wrong: the Hub deployed and reset it, its
 * connection dropped, or it was briefly overloaded. The runtime marks the
 * first two `retryable`; the messages are matched too because an error that
 * crossed another object loses its properties.
 */
const TRANSIENT_DURABLE_OBJECT_MESSAGE =
  /Durable Object reset because its code was updated|Network connection lost|Durable Object is overloaded/u;

export function transientDurableObjectFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const flags = error as { retryable?: unknown; overloaded?: unknown; message?: unknown };
  if (flags.retryable === true || flags.overloaded === true) return true;
  return typeof flags.message === "string" && TRANSIENT_DURABLE_OBJECT_MESSAGE.test(flags.message);
}

/** Seconds a client waits before replaying a request a Durable Object refused in passing. */
export const DURABLE_OBJECT_RETRY_AFTER_SECONDS = 1;
