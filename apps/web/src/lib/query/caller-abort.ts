/**
 * Lets one caller stop waiting for a shared (deduplicated) query without
 * aborting the request every other caller is waiting on. The shared request
 * only follows Query's own signal; a caller's signal rejects that caller alone.
 */
export function untilCallerAborts<T>(shared: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return shared;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    // Even a caller that already left owns this shared promise's rejection.
    // Other callers still receive the query's result through their own waiters.
    shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
