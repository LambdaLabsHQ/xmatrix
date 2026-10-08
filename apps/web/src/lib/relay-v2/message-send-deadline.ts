/**
 * Bounding one human message append and classifying how it ended.
 *
 * The three outcomes are not interchangeable, and the difference is the whole
 * point of this module:
 *
 * - `committed` — the server accepted it.
 * - `failed` — the server decided against it, or the request provably never
 *   landed. Safe to report as an error.
 * - `unconfirmed` — the deadline passed with the result genuinely unknown. The
 *   write may well have committed, so calling it a failure is a lie and calling
 *   it pending is the hang this exists to remove.
 *
 * Production and tests both go through `performBoundedMessageAppend`, so a
 * classification bug cannot pass by being re-implemented in a test.
 */

export interface BoundedAppendResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type MessageAppendOutcome =
  | { kind: "committed"; payload: Record<string, unknown> }
  | { kind: "unconfirmed" }
  | { kind: "failed"; status: number; message: string; code?: string; retryable?: boolean };

export const MESSAGE_SEND_DEADLINE_MS = 15_000;

export class MessageSendDeadlineError extends Error {
  constructor() {
    super("Message send exceeded its deadline");
    this.name = "MessageSendDeadlineError";
  }
}

export function isMessageSendDeadlineError(error: unknown): boolean {
  return error instanceof MessageSendDeadlineError;
}

export interface BoundedAppendInput {
  /** Issues one attempt; must honour the signal it is handed. */
  send: (signal: AbortSignal) => Promise<BoundedAppendResponse>;
  /**
   * The retry policy. It receives the same signal so an expired deadline stops
   * the sequence rather than merely aborting the request in flight.
   */
  withRetry: (
    attempt: () => Promise<BoundedAppendResponse>,
    options: { signal: AbortSignal },
  ) => Promise<BoundedAppendResponse>;
  deadlineMs?: number;
  fallbackMessage?: string;
}

export async function performBoundedMessageAppend(
  input: BoundedAppendInput,
): Promise<MessageAppendOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new MessageSendDeadlineError()),
    input.deadlineMs ?? MESSAGE_SEND_DEADLINE_MS,
  );
  const fallback = input.fallbackMessage ?? "Failed to send message";
  try {
    let response: BoundedAppendResponse;
    try {
      response = await input.withRetry(() => input.send(controller.signal), {
        signal: controller.signal,
      });
    } catch {
      // Nothing came back at all. Whether the deadline expired or every attempt
      // lost its response, the POST may still have committed — the shared
      // `clientMessageId` makes retrying safe but proves nothing about whether
      // the write landed. Calling this a failure would assert more than is known.
      return { kind: "unconfirmed" };
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      // Tolerating an unparseable body is deliberate — an error response may
      // carry none — but it must not swallow the deadline.
      if (controller.signal.aborted) {
        // Only a 2xx leaves the result unknown. A non-2xx already decided the
        // outcome, so a stalled *error* body is still a determinate failure and
        // must fail fast rather than be dressed up as unknown.
        if (response.ok) return { kind: "unconfirmed" };
        return { kind: "failed", status: response.status, message: fallback };
      }
      if (!response.ok) return { kind: "failed", status: response.status, message: fallback };
      // A 2xx that simply carries no parseable body is still a success: the
      // headers already decided that. Tolerating it preserves the behaviour
      // that existed before this logic moved here.
      return { kind: "committed", payload: {} };
    }

    if (!response.ok) {
      return {
        kind: "failed",
        status: response.status,
        message: typeof payload.error === "string" ? payload.error : fallback,
        ...(typeof payload.code === "string" ? { code: payload.code } : {}),
        ...(typeof payload.retryable === "boolean" ? { retryable: payload.retryable } : {}),
      };
    }
    return { kind: "committed", payload };
  } finally {
    clearTimeout(timer);
  }
}
