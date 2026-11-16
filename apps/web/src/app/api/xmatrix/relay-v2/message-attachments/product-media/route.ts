import { RELAY_V2_MESSAGE_ATTACHMENT_PRODUCT_MEDIA_PATH } from "@xmatrix/protocol/relay-v2/message-attachment";

import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

/**
 * Binary product-media responses stream through without JSON parsing and
 * keep the attachment metadata headers the browser client reads. The body is
 * never held whole here, whatever its size, and a `Range` request is answered
 * in part by the Hub.
 */
export async function POST(request: Request) {
  const range = request.headers.get("range");
  return proxyXMatrixRequest({
    route: RELAY_V2_MESSAGE_ATTACHMENT_PRODUCT_MEDIA_PATH,
    method: "POST",
    authorization: request.headers.get("authorization") || undefined,
    body: await request.text(),
    ...(range ? { headers: { range } } : {}),
    streamResponse: true,
    responseHeaders: [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range",
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
