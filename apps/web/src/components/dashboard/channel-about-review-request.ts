import { WEB_PROXY_ROUTES, type SerializedChannel, type SpaceManagementAgentConfig } from "@xmatrix/protocol";

import { runIdempotentMutationFetchWithRetry } from "./workspace-refresh-policy";

export function channelAboutReviewConfigurationError(
  managementAgent?: SpaceManagementAgentConfig,
): string | undefined {
  if (managementAgent?.enabled !== true) {
    return "About summary needs an enabled xMatrix management agent.";
  }
  if (managementAgent.sideEffectsEnabled === false) {
    return "About summary is unavailable while management actions are paused.";
  }
  return undefined;
}

export async function requestChannelAboutReview(input: {
  token: string;
  channel: SerializedChannel;
  managementAgent?: SpaceManagementAgentConfig;
}): Promise<void> {
  const error = channelAboutReviewConfigurationError(input.managementAgent);
  if (error) throw new Error(error);
  const response = await runIdempotentMutationFetchWithRetry(() => fetch(
    WEB_PROXY_ROUTES.space_management_channel_about(input.channel.spaceId),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: JSON.stringify({ channelId: input.channel.id, requestId: crypto.randomUUID() }),
      cache: "no-store",
    },
  ));
  if (response.ok) return;
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(payload.error || "Could not request an About summary from xMatrix.");
}
