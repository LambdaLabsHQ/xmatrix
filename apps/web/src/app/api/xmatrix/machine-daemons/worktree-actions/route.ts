import { hubRouteHandler, hubRouteHandlerFrom, pickSearchParams, withSearchParams } from "@/lib/xmatrix-proxy";
import { HUB_ROUTES } from "@xmatrix/protocol";

export const POST = hubRouteHandler("POST", HUB_ROUTES.machine_worktree_actions);
export const GET = hubRouteHandlerFrom("GET", (_params, url) =>
  withSearchParams(HUB_ROUTES.machine_worktree_actions, pickSearchParams(url.searchParams, ["machineId"])));
