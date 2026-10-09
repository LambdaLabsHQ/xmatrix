// Pure, testable policy helpers for workspace loading: when the background
// refresh may be skipped, and which workspace fetch failures are worth retrying.
// Kept free of React/DOM imports so it can be unit-tested via node --test.
// Which failures are transient is not decided here: it is the one client rule
// in api-client.ts (isTransientFailure), shared with every Query.

import { XMatrixApiError, errorFromResponse, isTransientFailure } from "../../lib/query/api-client";

export const WORKSPACE_FETCH_MAX_ATTEMPTS = 3;

// One catalog hop must not hold the in-flight lock forever. After Mac sleep
// a dead keep-alive can hang until TCP gives up, which skipped every later
// retry and left "Failed to fetch" on screen.
export const WORKSPACE_FETCH_ATTEMPT_TIMEOUT_MS = 15_000;
export const CHANNEL_CATALOG_FETCH_TOTAL_TIMEOUT_MS = 20_000;

export function workspaceAttemptSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(WORKSPACE_FETCH_ATTEMPT_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

// Small, quick backoff: the workspace fetches are interactive GETs, so we want a
// couple of fast retries to ride out transient jitter, not a long tail.
export const WORKSPACE_FETCH_RETRY_DELAYS_MS = [400, 1200];

const GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * A failed response under the shared rule. A real Response is read for the
 * Hub's `retryable` label; a bare status (a test double) is read as a gateway
 * would answer it.
 */
export async function workspaceResponseIsTransient(response: WorkspaceFetchLike): Promise<boolean> {
  if (response.ok) return false;
  const error = typeof (response as Partial<Response>).clone === "function"
    ? await errorFromResponse(response as Response)
    : new XMatrixApiError({ message: "", status: response.status, retryable: GATEWAY_STATUSES.has(response.status) });
  return isTransientFailure(error);
}

export function workspaceFetchRetryDelayMs(attempt: number): number {
  return WORKSPACE_FETCH_RETRY_DELAYS_MS[attempt - 1] ?? 1800;
}

export interface WorkspaceFetchLike {
  ok: boolean;
  status: number;
  headers?: Pick<Headers, "get">;
}

/**
 * A valid positive Retry-After is an explicit server backpressure boundary.
 * Interactive callers must return that response now instead of sleeping inside
 * a UI deadline or multiplying one outage into several near-identical requests.
 * Their existing background/manual trigger owns the later attempt.
 */
export function workspaceResponseDefersRetry(
  response: WorkspaceFetchLike,
  nowMs = Date.now(),
): boolean {
  const value = response.headers?.get("retry-after")?.trim();
  if (!value) return false;
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Number(value) > 0;
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) && retryAt > nowMs;
}

// Retry a workspace fetch on transient failures (a transport failure or a
// transient response under isTransientFailure), with backoff. `attemptFetch` is invoked per attempt so each retry is a
// fresh request. Non-retriable responses (including a final-attempt retriable
// one) are returned to the caller to handle; a network throw on the last attempt
// is rethrown. `sleep` is injectable for tests.
export async function runWorkspaceFetchWithRetry<T extends WorkspaceFetchLike>(
  attemptFetch: () => Promise<T>,
  options: {
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
    /**
     * Bounds the whole retry sequence, not one attempt. Once it is aborted no
     * further attempt may start and a pending backoff must end immediately —
     * an uncancellable sleep would let the caller's deadline expire while this
     * policy kept issuing requests in the background.
     */
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? WORKSPACE_FETCH_MAX_ATTEMPTS;
  const signal = options.signal;
  const baseSleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Whichever of abort or sleep-settled happens first wins, and every path runs
  // the same cleanup. `sleep` is a public option, so a rejecting one must keep
  // propagating as it did before: swallowing it would leave this promise
  // unsettled and hang the very sequence the signal exists to bound.
  const sleep = (ms: number) => (signal
    ? new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        let settled = false;
        const settle = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          outcome();
        };
        function onAbort() {
          settle(() => reject(signal!.reason));
        }
        signal.addEventListener("abort", onAbort, { once: true });
        // `baseSleep` is injected and may throw synchronously before returning a
        // promise. Going through `Promise.resolve().then` keeps that on the same
        // `settle` path; letting the executor reject would skip cleanup and
        // leave the abort listener attached to the signal.
        Promise.resolve().then(() => baseSleep(ms)).then(
          () => settle(resolve),
          (error: unknown) => settle(() => reject(error)),
        );
      })
    : baseSleep(ms));

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason;
    try {
      const result = await attemptFetch();
      if (
        result.ok ||
        workspaceResponseDefersRetry(result) ||
        attempt >= maxAttempts ||
        !(await workspaceResponseIsTransient(result))
      ) {
        return result;
      }
    } catch (error) {
      lastError = error;
      // One attempt's own deadline (workspaceAttemptSignal) is a hop that hung,
      // as transient as a dropped one; a caller abort or a real answer is not.
      const attemptTimedOut = error instanceof DOMException && error.name === "TimeoutError" && !signal?.aborted;
      if (attempt >= maxAttempts || !(isTransientFailure(error) || attemptTimedOut)) throw error;
      if (signal?.aborted) throw signal.reason;
    }
    await sleep(workspaceFetchRetryDelayMs(attempt));
  }

  // Unreachable: the loop returns or throws on the final attempt. Satisfies the
  // compiler and guards against a future maxAttempts <= 0.
  throw lastError instanceof Error ? lastError : new Error("Workspace fetch failed");
}

// Mutating requests may use this policy only when every attempt carries the
// same server-enforced idempotency key. Message sends satisfy that contract by
// keeping one clientMessageId across retries, so an ambiguous post-commit
// network failure cannot create a duplicate message or duplicate Agent action.
export async function runIdempotentMutationFetchWithRetry<T extends WorkspaceFetchLike>(
  attemptFetch: () => Promise<T>,
  options: {
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  return runWorkspaceFetchWithRetry(attemptFetch, options);
}
