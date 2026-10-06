import { HUB_ROUTES } from "@xmatrix/protocol";
import { spaceSubpathHandlers } from "@/lib/xmatrix-proxy";

/** Forwards how an open project is run to the Hub, which decides who may change it. */
export const { GET, PUT, POST } = spaceSubpathHandlers(HUB_ROUTES.space_governance);
