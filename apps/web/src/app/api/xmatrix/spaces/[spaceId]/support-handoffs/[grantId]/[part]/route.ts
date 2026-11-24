import { HUB_ROUTES, SUPPORT_HANDOFF_PARTS, type SupportHandoffPart } from "@xmatrix/protocol";
import { hubRouteHandlerFrom, pickSearchParams, withSearchParams } from "@/lib/xmatrix-proxy";

/** One part of a support handoff, as support reads it; the Hub refuses a part that is not one. */
export const GET = hubRouteHandlerFrom<{ spaceId: string; grantId: string; part: string }>("GET", (params, url) => {
  // Anything else goes on encoded, as one segment, for the Hub to refuse.
  const part = ((SUPPORT_HANDOFF_PARTS as readonly string[]).includes(params.part)
    ? params.part : encodeURIComponent(params.part)) as SupportHandoffPart;
  return withSearchParams(HUB_ROUTES.support_handoff_part(params.spaceId, params.grantId, part),
    pickSearchParams(url.searchParams, ["limit", "beforeSequence"]));
});
