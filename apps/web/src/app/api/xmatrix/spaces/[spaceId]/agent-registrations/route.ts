import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandlerFrom } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandlerFrom("GET", ({ spaceId }: { spaceId: string }, url) => {
  // The Agents page asks the Hub to read quota again while it is open.
  const refresh = url.searchParams.get("quota") === "refresh" ? "?quota=refresh" : "";
  return `${HUB_ROUTES.space_agent_registrations(spaceId)}${refresh}`;
});
