import { WEB_PROXY_ROUTES, type MessageSearchPage, type PageSearchHit } from "@xmatrix/protocol";
import { requireJson, xmatrixRawResponse } from "@/lib/query/api-client";

/**
 * Message search runs on the Hub: it scans the newest readable messages of the
 * Space up to a bounded budget and returns a resume token when the budget ran
 * out before the results filled.
 */
export async function searchWorkspaceMessages(input: {
  token: string;
  spaceId: string;
  query: string;
  resumeToken?: string;
  /** Only this conversation and its threads. */
  channelId?: string;
  /** The Hub's author filter: `user:<id>` or `agent:<name>`. */
  from?: string;
}): Promise<MessageSearchPage> {
  const params = new URLSearchParams({ spaceId: input.spaceId, query: input.query });
  if (input.resumeToken) params.set("cursor", input.resumeToken);
  if (input.channelId) params.set("channelId", input.channelId);
  if (input.from) params.set("from", input.from);
  const response = await xmatrixRawResponse(`${WEB_PROXY_ROUTES.message_search}?${params}`, {
    headers: { Authorization: `Bearer ${input.token}` },
    cache: "no-store",
  });
  return requireJson<MessageSearchPage>(response);
}

/** Page search runs on the Hub over every page the reader may read: title and current text. */
export async function searchWorkspacePages(input: {
  token: string;
  spaceId: string;
  query: string;
}): Promise<{ results: PageSearchHit[] }> {
  const params = new URLSearchParams({ query: input.query });
  const response = await xmatrixRawResponse(`${WEB_PROXY_ROUTES.space_pages(input.spaceId)}/search?${params}`, {
    headers: { Authorization: `Bearer ${input.token}` },
    cache: "no-store",
  });
  return requireJson<{ results: PageSearchHit[] }>(response);
}
