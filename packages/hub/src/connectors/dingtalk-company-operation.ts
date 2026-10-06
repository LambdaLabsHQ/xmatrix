import { ProviderRequestError } from "./http";

export type DingTalkOperation = { signal: AbortSignal; current: () => Promise<void> };

/** One deadline includes primary authority, credential reads and all provider calls. */
export async function dingtalkOperation<T>(
  current: () => Promise<void>,
  work: (operation: DingTalkOperation) => Promise<T>,
): Promise<T> {
  const controller = new AbortController(),
    expired = () => new ProviderRequestError(502, "DingTalk company operation did not complete"),
    timer = setTimeout(() => controller.abort(expired()), 45_000);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      work({
        signal: controller.signal,
        async current() {
          controller.signal.throwIfAborted();
          await current();
          controller.signal.throwIfAborted();
        },
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    // Cancel sibling reads after a rejection; late callbacks cannot start another request.
    controller.abort(expired());
  }
}
