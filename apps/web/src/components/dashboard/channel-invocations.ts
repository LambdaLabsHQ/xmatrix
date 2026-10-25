import { WEB_PROXY_ROUTES, type AgentInvocationQueryPage } from "@xmatrix/protocol";
import { errorFromResponse, xmatrixRawResponse } from "@/lib/query/api-client";
import { InvocationAccessError, loadInvocationPages } from "./mention-invocation-query";

/** The invocation records of a conversation's messages: what each `@` in them started, and how far it got. */
export function readChannelInvocations(channelId: string, token: string, sourceMessageIds: readonly string[],
  signal: AbortSignal): Promise<AgentInvocationQueryPage> {
  return loadInvocationPages({ channelId, sourceMessageIds, signal,
    fetchPage: async (request, pageSignal) => {
      const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.channel_agent_launches(channelId), {
        method: "POST", signal: pageSignal, cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if ([401, 403, 404].includes(response.status)) throw new InvocationAccessError(response.status);
      if (!response.ok) throw await errorFromResponse(response);
      return response.json();
    },
  });
}
