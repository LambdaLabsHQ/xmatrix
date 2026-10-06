/**
 * Admin side of approval-gated Space invite codes, on the client.
 *
 * Kept out of the workspace action hook because that file sits at the
 * repository's 5000-line ceiling, and because these need nothing from the
 * hook's state beyond a token.
 */
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { queryOptions } from "@tanstack/react-query";

import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { xmatrixApiRequest } from "@/lib/query/api-client";

export type SpaceJoinRequest = {
  id: string;
  spaceId: string;
  userId: string;
  role: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  requestedAt: string;
};

export async function fetchSpaceJoinRequests(
  token: string | null | undefined,
  spaceId: string,
  signal?: AbortSignal,
): Promise<SpaceJoinRequest[]> {
  if (!token) return [];
  const response = await fetch(WEB_PROXY_ROUTES.space_join_requests(spaceId), {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => ({}))) as { joinRequests?: SpaceJoinRequest[] };
  return payload.joinRequests || [];
}

/**
 * Queue details are loaded only on Team. The always-visible rail count travels
 * with the Space snapshot, so ordinary channel navigation never needs this
 * endpoint. A short fresh window still protects Team route remounts.
 */
export function spaceJoinRequestsQueryOptions(input: {
  token: string | null | undefined;
  userId: string;
  spaceId: string;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: xmatrixQueryKeys.domain(
      { userId: input.userId }, "space-join-requests", [input.spaceId],
    ),
    queryFn: ({ signal }) => fetchSpaceJoinRequests(input.token, input.spaceId, signal),
    enabled: input.enabled !== false && Boolean(input.token && input.userId && input.spaceId),
    staleTime: 60_000,
  });
}

/**
 * Approving grants the membership the request was filed against; denying only
 * closes it, so the person may ask again later.
 */
export async function decideSpaceJoinRequest(input: {
  token: string | null | undefined;
  spaceId: string;
  requestId: string;
  approve: boolean;
}): Promise<void> {
  const { token, spaceId, requestId, approve } = input;
  if (!token) throw new Error("Sign in before deciding join requests");
  await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.space_join_request_decide(spaceId, requestId), token,
    method: "POST", body: { approve } });
}
