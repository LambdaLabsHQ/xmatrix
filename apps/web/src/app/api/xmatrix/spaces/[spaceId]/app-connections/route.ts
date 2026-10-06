import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandlerFrom } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandlerFrom("GET", ({ spaceId }: { spaceId: string }, url) =>
  HUB_ROUTES.space_app_connections(spaceId, url.searchParams.get("channelId")?.trim() || undefined));
