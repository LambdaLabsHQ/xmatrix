import { concatenateBytes } from "./bytes.js";

/** Bound streamed bytes before allocating a joined body; release on every exit. */
export async function readBoundedStream(stream: ReadableStream<Uint8Array> | null, maximumBytes: number,
  tooLarge: () => Error, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  try {
    signal?.addEventListener("abort", abort, { once: true });
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  return concatenateBytes(chunks);
}
