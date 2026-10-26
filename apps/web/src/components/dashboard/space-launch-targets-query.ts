import { queryOptions } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type SpaceLaunchTargetsResponse } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

/** One read on entering a Space, shared by every composer. GitHub/connection
 * events and socket recovery invalidate it; typing and opening a picker don't. */
export function spaceLaunchTargetsQuery(userId: string | null | undefined,
  token: string | null | undefined, spaceId: string | null | undefined, enabled = true) {
  return queryOptions({
    queryKey: xmatrixQueryKeys.domain({ userId: userId ?? "anonymous" }, "space-launch-targets", [spaceId ?? null]),
    queryFn: async ({ signal }) => {
      const payload = await xmatrixApiRequest<SpaceLaunchTargetsResponse>({
        url: WEB_PROXY_ROUTES.space_launch_targets(spaceId!), token: token ?? undefined, signal,
      });
      if (payload.spaceId !== spaceId) throw new Error("Launch target response did not match the requested Space");
      return payload;
    },
    enabled: Boolean(enabled && userId && token && spaceId),
    staleTime: Infinity,
  });
}
