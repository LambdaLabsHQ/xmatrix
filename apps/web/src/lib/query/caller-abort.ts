/**
 * Lets one caller stop waiting for a shared (deduplicated) query without
 * aborting the request every other caller is waiting on. The shared request
 * only follows Query's own signal; a caller's signal rejects that caller alone.
 */
export function untilCallerAborts<T>(shared: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
