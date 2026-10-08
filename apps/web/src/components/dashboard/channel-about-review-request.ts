import { WEB_PROXY_ROUTES, type SerializedChannel } from "@xmatrix/protocol";

import { runIdempotentMutationFetchWithRetry } from "./workspace-refresh-policy";
import { xmatrixRawResponse } from "@/lib/query/api-client";

export async function requestChannelAboutReview(input: {
  token: string;
  channel: SerializedChannel;
}): Promise<void> {
  const response = await runIdempotentMutationFetchWithRetry(() => xmatrixRawResponse(
    WEB_PROXY_ROUTES.space_channel_about(input.channel.spaceId),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: JSON.stringify({ channelId: input.channel.id, requestId: crypto.randomUUID() }),
      cache: "no-store",
    },
  ));
  if (response.ok) return;
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(payload.error || `About summary request failed with HTTP ${response.status}.`);
}
