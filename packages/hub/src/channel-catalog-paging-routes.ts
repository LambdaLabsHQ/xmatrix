import { base64DecodeBytes } from "./relay-v2-primitives";
import { Hono } from "hono";
import type { Context } from "hono";
import { HUB_ROUTES } from "@xmatrix/protocol";
import type {
  ChannelCatalogPage,
  ChannelCatalogPageFilter,
  ChannelCatalogPageRow,
  ChannelCatalogPageView,
  ChannelCatalogResolveResult,
  SerializedChannel,
} from "@xmatrix/protocol";
import type { Env } from "./types";
import { postgresMessageSearch } from "./postgres-message-authority";
import { getRelayRuntime, requestErrorResponse, requireAuth } from "./index-shared";
import { channelCatalogPage, resolveChannelCatalog } from "./spaces";
import {
  loadLiveHumanPresenceFromRuntime,
  tryLoadLiveHumanPresenceFromRuntime,
  overlayChannelsWithLiveHumanPresence,
} from "./runtime-transport/human-presence-fanout";
import type {
  LiveHumanSessionSnapshot,
  OpenChannelHumanMemberIdsBySpace,
} from "./runtime-transport/human-live-presence";

/**
 * The Hub services these routes reach: authentication, the Channel catalog
 * and the RelayRuntime binding. Production uses the real ones; tests
 * pass their own boundary instead of rewriting module resolution.
 */
export interface ChannelCatalogPagingBoundary {
  requireAuth: typeof requireAuth;
  getRelayRuntime: typeof getRelayRuntime;
  requestErrorResponse: typeof requestErrorResponse;
  channelCatalogPage: typeof channelCatalogPage;
  resolveChannelCatalog: typeof resolveChannelCatalog;
}

const hubBoundary: ChannelCatalogPagingBoundary = {
  requireAuth,
  getRelayRuntime,
  requestErrorResponse,
  channelCatalogPage,
  resolveChannelCatalog,
};

interface BoundChannelCatalogCursor {
  protocolVersion: 1;
  spaceId: string;
  view: ChannelCatalogPageView;
  filter: ChannelCatalogPageFilter;
  query: string;
  position: {
    sortGroup: number;
    pinRank: number;
    ownActivityAt: string;
    channelId: string;
  };
}

type PagingRouteContext = Context<{ Bindings: Env }>;
type PagingAuthorization =
  | { ok: true; userId: string }
  | { ok: false; response: Response };

async function authorizePagingRequest(
  c: PagingRouteContext,
  boundary: ChannelCatalogPagingBoundary,
): Promise<PagingAuthorization> {
  const authUser = await boundary.requireAuth(c.req.raw, c.env);
  if (authUser.agentRun) {
    return { ok: false, response: c.json({ error: "Human session required" }, 403) };
  }
  return { ok: true, userId: authUser.id };
}

function encodeChannelCatalogCursor(value: BoundChannelCatalogCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function decodeChannelCatalogCursor(
  raw: string,
  binding: Omit<BoundChannelCatalogCursor, "protocolVersion" | "position">,
): BoundChannelCatalogCursor["position"] {
  if (!raw || raw.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(raw)) {
    throw new Error("Channel catalog cursor is invalid");
  }
  const padded = raw.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - raw.length % 4) % 4);
  const bytes = base64DecodeBytes(padded);
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as BoundChannelCatalogCursor;
  if (parsed.protocolVersion !== 1 || parsed.spaceId !== binding.spaceId ||
      parsed.view !== binding.view || parsed.filter !== binding.filter ||
      parsed.query !== binding.query ||
      !parsed.position || !Number.isSafeInteger(parsed.position.sortGroup) ||
      !Number.isSafeInteger(parsed.position.pinRank) ||
      !parsed.position.channelId || !Number.isFinite(Date.parse(parsed.position.ownActivityAt))) {
    throw new Error("Channel catalog cursor does not match its query");
  }
  return parsed.position;
}

/**
 * Catalog authority serializes durable Agent presence only; live Humans exist
 * solely as RelayRuntime sessions. A response that carried the Agent half alone
 * would still look authoritative to clients, which replace `memberPresence`
 * wholesale — every Human in the Channel would read as offline. Complete the
 * projection here, the way the full catalog listing already does.
 */
interface CatalogHumanPresenceSource {
  sessions: readonly LiveHumanSessionSnapshot[];
  openChannelHumanMemberIdsBySpace: OpenChannelHumanMemberIdsBySpace;
}

function channelsWithLiveHumanPresence(
  channels: readonly SerializedChannel[],
  presence: CatalogHumanPresenceSource,
): SerializedChannel[] {
  return overlayChannelsWithLiveHumanPresence(
    channels,
    presence.sessions,
    presence.openChannelHumanMemberIdsBySpace,
  ) as SerializedChannel[];
}

function rowsWithLiveHumanPresence(
  rows: readonly ChannelCatalogPageRow[],
  presence: CatalogHumanPresenceSource,
): ChannelCatalogPageRow[] {
  const channels = channelsWithLiveHumanPresence(
    rows.map((row) => row.channel),
    presence,
  );
  return rows.map((row, index) => ({ ...row, channel: channels[index]! }));
}

export function registerChannelCatalogPagingRoutes(
  app: Hono<{ Bindings: Env }>,
  boundary: ChannelCatalogPagingBoundary = hubBoundary,
): void {
  const authorized = async (c: PagingRouteContext, work: (userId: string) => Promise<Response>) => {
    try {
      const authorization = await authorizePagingRequest(c, boundary);
      return authorization.ok ? await work(authorization.userId) : authorization.response;
    } catch (error) {
      return boundary.requestErrorResponse(c, error);
    }
  };

  app.get(HUB_ROUTES.message_search, async (c) => authorized(c, async (userId) => {
    const spaceId = (c.req.query("spaceId") || "").trim();
    const query = (c.req.query("query") || "").trim();
    const cursor = (c.req.query("cursor") || "").trim();
    if (!spaceId || spaceId.length > 300 || !query || query.length > 200 || cursor.length > 300) {
      return c.json({ error: "Message search query is invalid" }, 400);
    }
    const page = await postgresMessageSearch(c.env, {
      spaceId, query, principal: { kind: "user", id: userId },
      ...(cursor ? { resumeToken: cursor } : {}),
    });
    return c.json(page, 200, { "cache-control": "private, no-store" });
  }));

  app.get(HUB_ROUTES.channel_catalog_page, async (c) => authorized(c, async (userId) => {
    const spaceId = (c.req.query("spaceId") || "").trim();
    const view = (c.req.query("view") || "flat") as ChannelCatalogPageView;
    const filter = (c.req.query("filter") || "all") as ChannelCatalogPageFilter;
    const query = (c.req.query("query") || "").trim().toLocaleLowerCase();
    const countsOnly = c.req.query("countsOnly") === "true";
    const includeCounts = c.req.query("includeCounts") !== "false";
    if (!spaceId || spaceId.length > 300 ||
        !new Set<ChannelCatalogPageView>(["flat", "search", "intake"]).has(view) ||
        !new Set<ChannelCatalogPageFilter>(["all", "unread"]).has(filter) ||
        query.length > 200 ||
        (view === "search" && !query) || (countsOnly && Boolean(c.req.query("cursor")))) {
      return c.json({ error: "Channel catalog page query is invalid" }, 400);
    }
    const cursorBinding = { spaceId, view, filter, query };
    let cursor: BoundChannelCatalogCursor["position"] | undefined;
    const rawCursor = c.req.query("cursor");
    if (rawCursor) {
      try {
        cursor = decodeChannelCatalogCursor(rawCursor, cursorBinding);
      } catch {
        return c.json({ error: "Channel catalog cursor is invalid" }, 400);
      }
    }
    // Validate the complete query before starting optional work. Presence and
    // the authorized catalog read can then proceed concurrently.
    const sessionsPromise = countsOnly
      ? Promise.resolve([] as LiveHumanSessionSnapshot[])
      : tryLoadLiveHumanPresenceFromRuntime(boundary.getRelayRuntime(c.env), c.req.url, 250);
    const result = await boundary.channelCatalogPage(c.env, {
      spaceId, principal: { kind: "user", id: userId }, view, filter, query, limit: 50, countsOnly,
      includeCounts: countsOnly || includeCounts, ...(cursor ? { cursor } : {}),
    });
    const {
      openChannelHumanMemberIdsBySpace = {},
      ...payload
    } = result as unknown as Omit<ChannelCatalogPage, "nextCursor"> & {
      nextCursor: BoundChannelCatalogCursor["position"] | null;
      openChannelHumanMemberIdsBySpace?: OpenChannelHumanMemberIdsBySpace;
    };
    const sessions = await sessionsPromise;
    return c.json({
      ...payload,
      // Omission preserves a client's hydrated roster; an empty map would
      // falsely remove live Humans when only the optional read timed out.
      rows: sessions === null ? (payload.rows ?? []).map((row) => {
        const { memberPresence: _unavailable, ...channel } = row.channel;
        return { ...row, channel };
      }) : rowsWithLiveHumanPresence(payload.rows ?? [], {
        sessions,
        openChannelHumanMemberIdsBySpace,
      }),
      nextCursor: payload.nextCursor ? encodeChannelCatalogCursor({
        protocolVersion: 1, ...cursorBinding, position: payload.nextCursor,
      }) : null,
    }, 200, { "cache-control": "private, no-store" });
  }));

  app.post(HUB_ROUTES.channel_catalog_resolve, async (c) => authorized(c, async (userId) => {
    const body = await c.req.json<{
      spaceId?: unknown;
      channelIds?: unknown;
      routeToken?: unknown;
      includeParticipants?: unknown;
    }>().catch(() => null);
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
    const rawChannelIds = Array.isArray(body?.channelIds) ? body.channelIds : [];
    const routeToken = typeof body?.routeToken === "string"
      ? body.routeToken.trim().toLowerCase() : null;
    const validChannelIds = rawChannelIds.every((value) =>
      typeof value === "string" && Boolean(value.trim()) && value.trim().length <= 300);
    const validRouteToken = body?.routeToken === undefined ||
      Boolean(routeToken && /^c[a-z0-9]{8,12}$/u.test(routeToken));
    const channelIds = validChannelIds
      ? [...new Set((rawChannelIds as string[]).map((value) => value.trim()))]
      : [];
    if (!spaceId || spaceId.length > 300 || channelIds.length + (routeToken ? 1 : 0) < 1 ||
        channelIds.length + (routeToken ? 1 : 0) > 200 || !validChannelIds || !validRouteToken) {
      return c.json({ error: "Channel catalog resolve request is invalid" }, 400);
    }
    const includeParticipants = body?.includeParticipants !== false;
    const sessionsPromise = includeParticipants ? loadLiveHumanPresenceFromRuntime(
      boundary.getRelayRuntime(c.env), c.req.url,
    ) : Promise.resolve([]);
    const result = await boundary.resolveChannelCatalog(c.env, {
      spaceId, principal: { kind: "user", id: userId }, channelIds, ...(routeToken ? { routeToken } : {}),
      includeParticipants,
    });
    const {
      openChannelHumanMemberIdsBySpace = {},
      ...resolved
    } = result as unknown as ChannelCatalogResolveResult & {
      openChannelHumanMemberIdsBySpace?: OpenChannelHumanMemberIdsBySpace;
    };
    return c.json({
      ...resolved,
      channels: includeParticipants ? channelsWithLiveHumanPresence(resolved.channels ?? [], {
        sessions: await sessionsPromise,
        openChannelHumanMemberIdsBySpace,
      }) : resolved.channels ?? [],
    }, 200, { "cache-control": "private, no-store" });
  }));
}
