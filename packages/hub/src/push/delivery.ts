import { readBoundedStream } from "@xmatrix/protocol";

/** One outbound policy for all push providers, including OAuth and body reads. */
export const PUSH_DELIVERY_BUDGET = { timeoutMs: 10_000, batchTimeoutMs: 20_000, concurrency: 8, responseBytes: 16_384 };

export async function withPushBudget<T>(task: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal,
  timeoutMs = PUSH_DELIVERY_BUDGET.timeoutMs): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error("Push delivery deadline exceeded")), timeoutMs);
  try {
    return await Promise.race([task(signal), expired]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}

/** Crypto, token acquisition, HTTP and decoding share a single delivery lifetime. */
export function withPushDelivery<T>(request: typeof fetch,
  send: (request: typeof fetch, signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  return withPushBudget(async signal => {
    const bodies: ReadableStream<Uint8Array>[] = [];
    const boundedRequest: typeof fetch = async (url, init) => {
      signal.throwIfAborted();
      const response = await request(url, { ...init, signal });
      if (response.body) bodies.push(response.body);
      if (signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        signal.throwIfAborted();
      }
      return response;
    };
    try {
      return await send(boundedRequest, signal);
    } finally {
      // Status-only replies need no bytes, but still own a transport body.
      for (const body of bodies) if (!body.locked) void body.cancel().catch(() => undefined);
    }
  }, parent);
}

export async function pushResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const bytes = await readBoundedStream(response.body, PUSH_DELIVERY_BUDGET.responseBytes,
    () => new Error("Push response too large"), signal);
  return JSON.parse(new TextDecoder().decode(bytes));
}
