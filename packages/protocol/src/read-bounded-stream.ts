import { concatenateBytes } from "./bytes.js";

/** Bound streamed bytes before allocating a joined body; release on every exit. */
export async function readBoundedStream(stream: ReadableStream<Uint8Array> | null, maximumBytes: number,
  tooLarge: () => Error): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatenateBytes(chunks);
}
