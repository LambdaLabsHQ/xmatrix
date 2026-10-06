import { HUB_ROUTES } from "@xmatrix/protocol";
import { spaceSubpathHandlers } from "@/lib/xmatrix-proxy";

/** Forwards conversation ↔ page link requests to the Hub, which authorizes every one. */
export const { GET, POST, PUT, DELETE } = spaceSubpathHandlers(HUB_ROUTES.space_page_links, { search: true });
