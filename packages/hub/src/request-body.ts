/** Reads a stream whole, cancelling it with `cancelReason` once it passes `maxBytes`. */
async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  cancelReason: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel(cancelReason).catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  if (!request.body) return new ArrayBuffer(0);
  const bytes = await readBoundedStream(request.body, maxBytes, "request_too_large");
  return bytes ? bytes.buffer : null;
}
