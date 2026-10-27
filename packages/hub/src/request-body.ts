import { readBoundedStream } from "@xmatrix/protocol";

export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  const tooLarge = new Error("request_too_large");
  try {
    return (await readBoundedStream(request.body, maxBytes, () => tooLarge, request.signal)).buffer;
  } catch (error) {
    if (error === tooLarge) return null;
    throw error;
  }
}
