import { HUB_ROUTES } from "@xmatrix/protocol";
import { spaceSubpathHandlers } from "@/lib/xmatrix-proxy";

/** Forwards a Space's page migration requests to the Hub, which allows only its owners and admins. */
export const { GET, PUT, POST, PATCH } = spaceSubpathHandlers(HUB_ROUTES.space_page_migration);
