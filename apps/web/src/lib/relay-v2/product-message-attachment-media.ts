import type { RelayV2MessageAttachmentDescriptor } from "@xmatrix/protocol/relay-v2/message-attachment";

/** One attachment's bytes, read through the Hub or from this browser's media cache. */
export interface ProductMessageAttachmentResult {
  kind: "message_attachment_ready";
  attachment: RelayV2MessageAttachmentDescriptor;
  body: Blob;
  source: "network" | "cache";
  retained: boolean;
}

/** Browser-facing proxy path (hub path is /api/relay-v2/... without the /xmatrix segment). */
const WEB_PRODUCT_MEDIA_PATH =
  "/api/xmatrix/relay-v2/message-attachments/product-media";
const PRODUCT_MEDIA_CACHE_NAME = "xmatrix-product-media-v1";

export interface ProductMessageAttachmentCache {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete?(request: string): Promise<void>;
}

/**
 * Product UX media read-through companion to Authority channel-history.
 * Loads one attachment after the hub rechecks channel ACL and streams the
 * content-addressed object — no Local Replica lease required.
 *
 * Successful bodies are retained in Cache Storage (or an injected cache) so
 * later views of the same attachment do not re-download through the Hub.
 */
export class ProductMessageAttachmentMediaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly cache: ProductMessageAttachmentCache | null;

  constructor(
    // Native `fetch` requires its global receiver. Capturing the unbound
    // function and calling it as `this.fetchImpl(...)` throws
    // "Illegal invocation" in Chromium and permanently fail-closes the UI.
    fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
    cache: ProductMessageAttachmentCache | null | undefined = undefined,
  ) {
    this.fetchImpl =
      fetchImpl === globalThis.fetch
        ? (...args) => globalThis.fetch(...args)
        : fetchImpl;
    this.cache = cache === undefined ? browserProductMediaCache() : cache;
  }

  async loadMessageAttachment(
    accessToken: string,
    messageAttachment: { channelId: string; messageId: string; attachmentId: string },
  ): Promise<ProductMessageAttachmentResult> {
    const cacheKey = productMediaCacheKey(messageAttachment);
    const cached = await this.cache?.match(cacheKey);
    if (cached?.ok) {
      const result = await resultFromProductMediaResponse(cached, messageAttachment);
      return { ...result, source: "cache", retained: true };
    }

    const response = await this.fetchImpl(WEB_PRODUCT_MEDIA_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(messageAttachment),
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { error?: string; code?: string };
      const error = new Error(
        typeof detail.error === "string" ? detail.error : "Message attachment media is unavailable",
      ) as Error & { code?: string; status?: number };
      if (typeof detail.code === "string") error.code = detail.code;
      error.status = response.status;
      throw error;
    }
    const stored = await retainProductMediaResponse(this.cache, cacheKey, response);
    const result = await resultFromProductMediaResponse(stored, messageAttachment);
    return { ...result, source: "network", retained: this.cache !== null };
  }
}

export async function clearProductMessageAttachmentMediaCache(): Promise<void> {
  if (typeof caches === "undefined") return;
  await caches.delete(PRODUCT_MEDIA_CACHE_NAME).catch(() => false);
}

function productMediaCacheKey(
  messageAttachment: { channelId: string; messageId: string; attachmentId: string },
): string {
  return [
    "/xmatrix-product-media",
    encodeURIComponent(messageAttachment.channelId),
    encodeURIComponent(messageAttachment.messageId),
    encodeURIComponent(messageAttachment.attachmentId),
  ].join("/");
}

function browserProductMediaCache(): ProductMessageAttachmentCache | null {
  if (typeof caches === "undefined") return null;
  return {
    async match(request) {
      const cache = await caches.open(PRODUCT_MEDIA_CACHE_NAME);
      return await cache.match(request) ?? undefined;
    },
    async put(request, response) {
      const cache = await caches.open(PRODUCT_MEDIA_CACHE_NAME);
      await cache.put(request, response);
    },
  };
}

async function retainProductMediaResponse(
  cache: ProductMessageAttachmentCache | null,
  cacheKey: string,
  response: Response,
): Promise<Response> {
  if (!cache) return response;
  const clone = response.clone();
  try {
    await cache.put(cacheKey, clone);
  } catch {
    return response;
  }
  return response;
}

async function resultFromProductMediaResponse(
  response: Response,
  messageAttachment: { channelId: string; messageId: string; attachmentId: string },
): Promise<ProductMessageAttachmentResult> {
  const body = await response.blob();
  if (body.size < 1) {
    throw new Error("Message attachment product media body is empty");
  }
  const attachment = attachmentFromProductMediaResponse(
    response.headers,
    messageAttachment,
    body,
  );
  return {
    kind: "message_attachment_ready",
    attachment,
    body: body.type === attachment.mimeType
      ? body
      : new Blob([body], { type: attachment.mimeType }),
    source: "network",
    retained: false,
  };
}

function attachmentFromProductMediaResponse(
  headers: Headers,
  request: { attachmentId: string },
  body: Blob,
): RelayV2MessageAttachmentDescriptor {
  const id = headers.get("x-xmatrix-attachment-id")?.trim() || request.attachmentId;
  const nameEncoded = headers.get("x-xmatrix-attachment-name")?.trim() || "";
  const mimeType =
    headers.get("content-type")?.split(";")[0]?.trim() ||
    body.type ||
    "application/octet-stream";
  const versionHeader = Number(headers.get("x-xmatrix-attachment-version"));
  const version = Number.isSafeInteger(versionHeader) && versionHeader >= 1 ? versionHeader : 1;
  const sizeHeader = Number(
    headers.get("x-xmatrix-attachment-size") || headers.get("content-length"),
  );
  const size = Number.isSafeInteger(sizeHeader) && sizeHeader >= 1 ? sizeHeader : body.size;
  if (!id || size < 1) {
    throw new Error("Message attachment product media response is incomplete");
  }
  if (size !== body.size) {
    throw new Error("Message attachment response length does not match authority");
  }
  let name = request.attachmentId;
  if (nameEncoded) {
    try {
      name = decodeURIComponent(nameEncoded);
    } catch {
      name = nameEncoded;
    }
  }
  return { id, name, mimeType, size, version };
}
