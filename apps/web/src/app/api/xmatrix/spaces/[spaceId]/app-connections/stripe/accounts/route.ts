import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandlerFrom, withSearchParams, pickSearchParams } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandlerFrom<{ spaceId: string }>("GET", ({ spaceId }, url) =>
  withSearchParams(HUB_ROUTES.space_app_connection_stripe_accounts(spaceId), pickSearchParams(url.searchParams, ["after"])), { body: false });
