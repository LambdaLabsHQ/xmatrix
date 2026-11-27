import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandlerFrom } from "@/lib/xmatrix-proxy";

/** Forwards a Space's admission policy to the Hub, which decides who reads, adopts or withdraws it. */
const route = ({ spaceId }: { spaceId: string }) => HUB_ROUTES.space_admission_policy(spaceId);

export const GET = hubRouteHandlerFrom("GET", route);
export const PUT = hubRouteHandlerFrom("PUT", route);
export const DELETE = hubRouteHandlerFrom("DELETE", route);
