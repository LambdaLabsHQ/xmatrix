import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandlerFrom } from "@/lib/xmatrix-proxy";

/** Forwards a Space's secrets to the Hub, which decides who may read or change them. */
const route = ({ spaceId, path = [] }: { spaceId: string; path?: string[] }) =>
  // An alias may contain "/", which can arrive split into segments.
  path.length ? HUB_ROUTES.space_secret(spaceId, path.join("/")) : HUB_ROUTES.space_secrets(spaceId);

export const GET = hubRouteHandlerFrom("GET", route);
export const PUT = hubRouteHandlerFrom("PUT", route);
export const DELETE = hubRouteHandlerFrom("DELETE", route);
