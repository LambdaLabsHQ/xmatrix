import { HUB_ROUTES } from "@xmatrix/protocol";
import { spaceSubpathHandlers } from "@/lib/xmatrix-proxy";

/** Forwards page requests to the Hub, which authorizes every one. */
export const { GET, POST, PUT, PATCH, DELETE } = spaceSubpathHandlers(HUB_ROUTES.space_pages, { search: true });
