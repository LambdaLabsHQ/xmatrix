import { HUB_ROUTES } from "@xmatrix/protocol";
import { spaceSubpathHandlers } from "@/lib/xmatrix-proxy";

/**
 * Forwards page requests to the Hub, which authorizes every one. A read streams
 * through, so an image or video a page shows plays as it arrives and from where
 * it is sought.
 */
export const { GET, POST, PUT, PATCH, DELETE } = spaceSubpathHandlers(HUB_ROUTES.space_pages, {
  search: true, get: { streamResponse: true, requestHeaders: ["range"] },
});
