import {
  WEB_PROXY_ROUTES,
  type ChannelCatalogPage,
  type ChannelCatalogPageCounts,
  type ChannelCatalogPageFilter,
  type ChannelCatalogPageRow,
  type ChannelCatalogPageView,
  type ChannelCatalogResolveResult,
  type SerializedChannel,
} from "@xmatrix/protocol";

import { errorFromResponse, xmatrixRawResponse } from "@/lib/query/api-client";
import { fetchChannelCatalog } from "./workspace-admin-views";

export interface NormalizedChannelCatalogQuery {
  view: ChannelCatalogPageView;
  filter: ChannelCatalogPageFilter;
  scopeChannelId: string | null;
  query: string;
}

export function normalizeChannelCatalogQuery(input: {
  view: ChannelCatalogPageView;
  filter?: ChannelCatalogPageFilter;
  scopeChannelId?: string | null;
  query?: string;
}): NormalizedChannelCatalogQuery {
  return {
    view: input.view,
    filter: input.filter ?? "all",
    scopeChannelId: input.scopeChannelId?.trim() || null,
    query: input.query?.trim().toLocaleLowerCase() || "",
  };
}

function legacyRows(
  channels: SerializedChannel[],
  input: NormalizedChannelCatalogQuery,
): ChannelCatalogPageRow[] {
  const scoped = channels.filter((channel) => input.view !== "search" ||
    String(channel.name || "").toLocaleLowerCase().includes(input.query)).slice(0, 50);
  return scoped.map((channel) => ({
    channel,
    ownActivityAt: channel.lastMessage?.sentAt || channel.updatedAt,
  }));
}

/**
 * Requests one catalog page. A Hub too old to serve pages answers from the
 * legacy channel list, read as `legacyQuery`, with only an active count.
 */
async function requestCatalogPage(input: {
  token: string;
  spaceId: string;
  params: URLSearchParams;
  legacyQuery: NormalizedChannelCatalogQuery;
  signal?: AbortSignal;
}): Promise<ChannelCatalogPage> {
  // The shared transport turns a dropped connection into a retryable error, so
  // Query retries it instead of showing the browser's "Failed to fetch".
  const response = await xmatrixRawResponse(`${WEB_PROXY_ROUTES.channel_catalog_page}?${input.params}`, {
    headers: { Authorization: `Bearer ${input.token}` },
    signal: input.signal,
    cache: "no-store",
  });
  if (response.status === 404 || response.status === 426) {
    const legacy = await fetchChannelCatalog(input.token, { spaceId: input.spaceId });
    const rows = legacyRows(legacy.channels, input.legacyQuery);
    return {
      protocolVersion: 1, catalogRevision: 0, rows, nextCursor: null,
      counts: { active: rows.length, unread: 0, mentions: 0 },
    };
  }
  if (!response.ok) throw await errorFromResponse(response);
  return response.json() as Promise<ChannelCatalogPage>;
}

export async function fetchChannelCatalogPage(input: {
  token: string;
  spaceId: string;
  query: NormalizedChannelCatalogQuery;
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<ChannelCatalogPage> {
  const params = new URLSearchParams({
    spaceId: input.spaceId, view: input.query.view, filter: input.query.filter,
    includeCounts: "false",
  });
  if (input.query.scopeChannelId) params.set("scopeChannelId", input.query.scopeChannelId);
  if (input.query.query) params.set("query", input.query.query);
  if (input.cursor) params.set("cursor", input.cursor);
  return requestCatalogPage({
    token: input.token, spaceId: input.spaceId, params, legacyQuery: input.query, signal: input.signal,
  });
}

export async function fetchChannelCatalogCounts(input: {
  token: string;
  spaceId: string;
  signal?: AbortSignal;
}): Promise<ChannelCatalogPageCounts> {
  const params = new URLSearchParams({
    spaceId: input.spaceId,
    view: "flat",
    filter: "all",
    countsOnly: "true",
  });
  const page = await requestCatalogPage({
    token: input.token,
    spaceId: input.spaceId,
    params,
    legacyQuery: normalizeChannelCatalogQuery({ view: "flat" }),
    signal: input.signal,
  });
  if (!page.counts) throw new Error("Channel catalog counts are unavailable");
  return page.counts;
}

export async function fetchChannelCatalogResolve(input: {
  token: string;
  spaceId: string;
  channelIds: string[];
  routeToken?: string;
  includeParticipants?: boolean;
  signal?: AbortSignal;
}): Promise<ChannelCatalogResolveResult> {
  const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.channel_catalog_resolve, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      spaceId: input.spaceId, channelIds: input.channelIds,
      ...(input.routeToken ? { routeToken: input.routeToken } : {}),
      includeParticipants: input.includeParticipants !== false,
    }),
    signal: input.signal,
    cache: "no-store",
  });
  if (response.status !== 404 && response.status !== 426) {
    if (!response.ok) throw await errorFromResponse(response);
    return response.json() as Promise<ChannelCatalogResolveResult>;
  }
  const legacy = await fetchChannelCatalog(input.token, { spaceId: input.spaceId });
  const byId = new Map(legacy.channels.map((channel) => [channel.id, channel]));
  const visibleIds = [...new Set(input.channelIds)].filter((channelId) => byId.has(channelId));
  return {
    protocolVersion: 1,
    channels: legacy.channels.filter((channel) => visibleIds.includes(channel.id)),
    pathsByChannelId: Object.fromEntries(visibleIds.map((channelId) => [channelId, [channelId]])),
  };
}
