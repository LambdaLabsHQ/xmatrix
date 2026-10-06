import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandler("GET", HUB_ROUTES.workspaces);
export const POST = hubRouteHandler("POST", HUB_ROUTES.workspaces);
export const DELETE = hubRouteHandler("DELETE", HUB_ROUTES.workspaces, [], { body: true });
