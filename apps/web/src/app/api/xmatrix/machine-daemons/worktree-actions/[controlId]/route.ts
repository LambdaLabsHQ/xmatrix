import { hubRouteHandler } from "@/lib/xmatrix-proxy";
import { HUB_ROUTES } from "@xmatrix/protocol";

export const GET = hubRouteHandler("GET", HUB_ROUTES.machine_worktree_action, ["controlId"]);
