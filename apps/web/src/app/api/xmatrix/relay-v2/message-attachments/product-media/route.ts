import { RELAY_V2_MESSAGE_ATTACHMENT_PRODUCT_MEDIA_PATH } from "@xmatrix/protocol/relay-v2/message-attachment";

import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

/**
 * Binary product-media responses stream through without JSON parsing and
 * keep the attachment metadata headers the browser client reads.
 */
export async function POST(request: Request) {
  return proxyXMatrixRequest({
    route: RELAY_V2_MESSAGE_ATTACHMENT_PRODUCT_MEDIA_PATH,
    method: "POST",
    authorization: request.headers.get("authorization") || undefined,
    body: await request.text(),
    responseHeaders: [
      "content-type",
      "content-length",
      "cache-control",
      "x-content-type-options",
      "x-xmatrix-attachment-id",
      "x-xmatrix-attachment-name",
      "x-xmatrix-attachment-version",
      "x-xmatrix-attachment-size",
      "x-xmatrix-content-hash",
    ],
  });
}
