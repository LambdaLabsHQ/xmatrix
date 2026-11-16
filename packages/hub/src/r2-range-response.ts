/**
 * One private object read, whole or — for a request with a `Range` header —
 * in part, so media of any size plays and seeks without the reader taking
 * every byte first. A range R2 cannot serve is answered with the whole object.
 */
export async function readR2Object(bucket: R2Bucket, key: string, request: Headers): Promise<{
  object: R2ObjectBody | null; ranged: boolean;
}> {
  const ranged = request.has("range");
  const object = await (ranged ? bucket.get(key, { range: request }).catch(() => bucket.get(key)) : bucket.get(key));
  return { object, ranged };
}

/** The response carrying a read: 200 with the whole length, or 206 with its `Content-Range`. */
export function r2ObjectResponse(object: R2ObjectBody, ranged: boolean, headers: Headers): Response {
  headers.set("accept-ranges", "bytes");
  const range = ranged ? object.range : undefined;
  if (!range) {
    headers.set("content-length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  }
  const offset = "suffix" in range ? object.size - range.suffix : range.offset ?? object.size - range.length!;
  const length = "suffix" in range ? range.suffix : range.length ?? object.size - offset;
  headers.set("content-length", String(length));
  headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
  return new Response(object.body, { status: 206, headers });
}
