import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandler("GET", HUB_ROUTES.space_app_connection_gmail_mailboxes, ["spaceId"], { body: false });
export const PUT = hubRouteHandler("PUT", HUB_ROUTES.space_app_connection_gmail_mailboxes, ["spaceId"]);
