import { plainRecord } from "@xmatrix/protocol";
/**
 * Reading the Channel catalog a principal may see.
 *
 * Split out of index-routes-channel-agent so the routing module stops carrying
 * this responsibility: the catalog read spans Space authorities, merges their
 * restart-cache material and attaches attention snapshots, none of which is
 * HTTP routing.
 */
import type {
  ChannelAttentionSnapshot,
  ChannelAttentionSummary,
  ChannelCatalogSyncMetadata,
  ChannelProjectionCacheManifest,
} from "@xmatrix/protocol";

import type { Env } from "./types";
import { listChannels, listSpaces } from "./spaces";
import { controlErrorResponse } from "./postgres-authority-http";
import {
  readSpaceAttentionProjection,
} from "./channel-messages";
import { readSpaceFanoutChannelCatalog } from "./space-fanout-channel-catalog";
import type { ChannelCatalogReadMetrics } from "./channel-catalog-observability";
import type { ChannelCatalogDeadline } from "./channel-catalog-deadline";

import type { AuthUser } from "./auth";

type CatalogPrincipal = { kind: "user"; id: string } | { kind: "agent"; id: string; spaceId?: string };

/** Agent catalog reads stay within the Space named by the authenticated Run. */
export function channelCatalogPrincipal(authUser: AuthUser): CatalogPrincipal {
  const run = authUser.agentRun;
  return run ? { kind: "agent", id: run.agentId, spaceId: run.spaceId } : { kind: "user", id: authUser.id };
}

function visibleChannelIdsBySpace(
  channels: unknown[],
  requestedSpaceId?: string,
): Map<string, string[]> {
  const bySpace = new Map<string, string[]>();
  if (requestedSpaceId) bySpace.set(requestedSpaceId, []);
  for (const candidate of channels) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const channel = candidate as Record<string, unknown>;
    if (typeof channel.id !== "string" || typeof channel.spaceId !== "string") continue;
    const ids = bySpace.get(channel.spaceId) ?? [];
    ids.push(channel.id);
    bySpace.set(channel.spaceId, ids);
  }
  return bySpace;
}

export type ChannelCatalogRead =
  | {
      ok: true;
      channels: unknown[];
      openChannelHumanMemberIdsBySpace: Record<string, readonly string[]>;
      projectionCacheManifest?: ChannelProjectionCacheManifest;
      catalogRevision?: number;
      catalogRevisionsBySpace?: Record<string, number>;
      catalogSync?: ChannelCatalogSyncMetadata;
      attentionSnapshot?: ChannelAttentionSnapshot;
    }
  | { ok: false; response: Response };

/**
 * The Hub services a catalog read reaches: the Channel and Space lists and
 * the family projections. Production uses the real ones;
 * tests build a reader over their own boundary instead of rewriting modules.
 */
export interface ChannelCatalogReadBoundary {
  listChannels: typeof listChannels;
  listSpaces: typeof listSpaces;
  readSpaceAttentionProjection: typeof readSpaceAttentionProjection;
}

const hubCatalogReadBoundary: ChannelCatalogReadBoundary = {
  listChannels,
  listSpaces,
  readSpaceAttentionProjection,
};

export function createChannelCatalogReader({
  listChannels,
  listSpaces,
  readSpaceAttentionProjection,
}: ChannelCatalogReadBoundary) {
  /**
   * The complete Channel catalog a principal may read.
   *
   * Nothing here can be answered by an Authority dispatch that names no Space: routing
   * derives its target from the request, not from the principal, so a Space-less
   * catalog read scans Space roots and takes the first that does not 404. Every
   * branch below therefore names the Space it means, or assembles the union
   * itself. See readSpaceFanoutChannelCatalog.
   */
  async function readChannelCatalogForPrincipal(
    env: Env,
    principal: CatalogPrincipal,
    spaceId?: string,
    metrics?: ChannelCatalogReadMetrics,
    deadline?: ChannelCatalogDeadline,
  ): Promise<ChannelCatalogRead> {
    if (principal.kind === "agent") {
      // An Agent catalog is one Space, its registration's own. The Space claim
      // is minted from the registration; a token without it fails closed here
      // rather than scanning for a Space that answers.
      const agentSpaceId = spaceId || principal.spaceId;
      if (!agentSpaceId) return agentSpaceUnavailable();
      return readCompleteAuthorityChannelCatalog(
        env, { kind: "agent", id: principal.id }, agentSpaceId, metrics, deadline,
      );
    }
    if (spaceId) {
      return readCompleteAuthorityChannelCatalog(
        env, principal, spaceId, metrics, deadline,
      );
    }
    return readSpaceFanoutChannelCatalog({
      noSpacesCatalog: {
        ok: true,
        channels: [],
        openChannelHumanMemberIdsBySpace: Object.create(null),
      },
      listSpaceIds: () => listChannelCatalogSpaceIds(env, principal, metrics, deadline),
      readSpaceCatalog: (routedSpaceId) => readCompleteAuthorityChannelCatalog(
        env, principal, routedSpaceId, metrics, deadline,
      ),
    });
  }

  function agentSpaceUnavailable(): ChannelCatalogRead {
    return { ok: false, response: Response.json(
      { error: "Agent Space is unavailable" },
      { status: 403, headers: { "cache-control": "private, no-store" } },
    ) };
  }

  /**
   * One Channel and its direct children, as the principal may see them.
   *
   * A single-Channel read (its Summary, archival and opened threads) needs only
   * this family; paging the whole Space catalog for it cost megabytes per read.
   * An Agent reads inside its token's Space; a user's read is routed by the
   * Channel itself, so no Space fan-out happens. The rows are the same
   * serialized rows the complete catalog carries, and a Channel the principal
   * cannot read answers 404 exactly as if it did not exist. Catalog-level
   * metadata (sync token, projection-cache manifest, attention snapshot)
   * describes a whole catalog, so a partial read never carries it.
   */
  async function readChannelForPrincipal(
    env: Env,
    principal: CatalogPrincipal,
    familyOfChannelId: string,
    spaceId?: string,
    metrics?: ChannelCatalogReadMetrics,
    deadline?: ChannelCatalogDeadline,
  ): Promise<ChannelCatalogRead> {
    const routedSpaceId = principal.kind === "agent" ? spaceId || principal.spaceId : spaceId;
    if (principal.kind === "agent" && !routedSpaceId) return agentSpaceUnavailable();
    const read = await readCompleteAuthorityChannelCatalog(
      env, { kind: principal.kind, id: principal.id }, routedSpaceId, metrics, deadline,
      familyOfChannelId,
    );
    if (!read.ok) return read;
    if (!read.channels.some((channel) => (channel as { id?: unknown }).id === familyOfChannelId)) {
      return { ok: false, response: Response.json(
        { error: "Channel not found" },
        { status: 404, headers: { "cache-control": "private, no-store" } },
      ) };
    }
    return {
      ok: true,
      channels: read.channels,
      openChannelHumanMemberIdsBySpace: read.openChannelHumanMemberIdsBySpace,
    };
  }

  /** Paginate Authority list-channels into one complete catalog (web clients never page). */
  async function readCompleteAuthorityChannelCatalog(
    env: Env,
    principal: { kind: "user" | "agent"; id: string },
    spaceId?: string,
    metrics?: ChannelCatalogReadMetrics,
    deadline?: ChannelCatalogDeadline,
    /** Narrow the read to this Channel and its direct children. */
    familyOfChannelId?: string,
  ): Promise<ChannelCatalogRead> {
    const channels: unknown[] = [];
    const openChannelHumanMemberIdsBySpace: Record<string, readonly string[]> =
      Object.create(null);
    let projectionCacheAuthority: ChannelProjectionCacheManifest["authority"] | undefined;
    const projectionCacheScopes = new Map<
      string,
      ChannelProjectionCacheManifest["scopes"][number]
    >();
    let projectionCacheEligible = principal.kind === "user";
    let catalogRevision: number | undefined;
    // Each page carries side data the catalog merges alongside its rows.
    const onPage = (payload: Record<string, unknown>, pageChannels: unknown[]) => {
      if (metrics) metrics.authorityCatalogPages += 1;
      const pageRevision = Number(payload.catalogRevision);
      if (catalogRevision === undefined && Number.isSafeInteger(pageRevision) && pageRevision >= 0) {
        catalogRevision = pageRevision;
      }
      Object.assign(
        openChannelHumanMemberIdsBySpace,
        (payload.openChannelHumanMemberIdsBySpace as Record<string, readonly string[]> | undefined) ?? {},
      );
      const pageManifest = payload.projectionCacheManifest as
        | ChannelProjectionCacheManifest
        | undefined;
      if (pageChannels.length > 0 && (!pageManifest || pageManifest.protocolVersion !== 1)) {
        projectionCacheEligible = false;
        return;
      }
      if (!pageManifest || !projectionCacheEligible) return;
      if (
        projectionCacheAuthority &&
        (projectionCacheAuthority.authorizationEpoch !==
          pageManifest.authority.authorizationEpoch ||
          projectionCacheAuthority.entitlementDigest !==
          pageManifest.authority.entitlementDigest)
      ) {
        projectionCacheEligible = false;
        return;
      }
      projectionCacheAuthority = pageManifest.authority;
      for (const scope of pageManifest.scopes) {
        const existing = projectionCacheScopes.get(scope.scopeId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(scope)) {
          projectionCacheEligible = false;
          break;
        }
        projectionCacheScopes.set(scope.scopeId, scope);
      }
    };
    const authorityStartedAt = Date.now();
    if (metrics) metrics.spaceCatalogReads += 1;
    try {
      let cursor: string | undefined;
      do {
        const listed = listChannels(env, { principal, limit: 200, ...(spaceId ? { spaceId } : {}),
          ...(familyOfChannelId ? { familyOfChannelId } : {}), ...(cursor ? { cursor } : {}) });
        const page = deadline ? await deadline.wait("authority_page", listed) : await listed;
        onPage(page as unknown as Record<string, unknown>, page.channels);
        channels.push(...page.channels);
        cursor = page.cursor ?? undefined;
      } while (cursor);
    } catch (error) {
      return { ok: false, response: controlErrorResponse(error) };
    } finally {
      if (metrics) metrics.authorityCatalogWallMs += Date.now() - authorityStartedAt;
    }
    const attentionSnapshot = principal.kind === "user"
      ? await attentionSnapshotForVisibleChannels(env, `user:${principal.id}`, channels, spaceId, metrics, deadline)
      : undefined;
    if (attentionSnapshot) {
      const completeSpaces = new Map(attentionSnapshot.spaces
        .filter((entry) => entry.complete)
        .map((entry) => [entry.spaceId, new Map(entry.summaries.map((summary) => [summary.channelId, summary]))]));
      for (let index = 0; index < channels.length; index += 1) {
        const channel = plainRecord(channels[index]);
        if (!channel) continue;
        if (typeof channel.id !== "string" || typeof channel.spaceId !== "string") continue;
        const summaries = completeSpaces.get(channel.spaceId);
        if (!summaries) continue;
        const { attention: _legacyAttention, ...withoutLegacyAttention } = channel;
        const attention = summaries.get(channel.id);
        channels[index] = { ...withoutLegacyAttention, ...(attention ? { attention } : {}) };
      }
    }
    return {
      ok: true,
      channels,
      openChannelHumanMemberIdsBySpace,
      ...(catalogRevision === undefined ? {} : { catalogRevision }),
      ...(attentionSnapshot ? { attentionSnapshot } : {}),
      ...(projectionCacheEligible && projectionCacheAuthority
        ? {
            projectionCacheManifest: {
              protocolVersion: 1 as const,
              authority: projectionCacheAuthority,
              scopes: Array.from(projectionCacheScopes.values()).sort((left, right) =>
                left.scopeId.localeCompare(right.scopeId)
              ),
            },
          }
        : {}),
    };
  }

  async function attentionSnapshotForVisibleChannels(
    env: Env,
    subjectId: string,
    channels: unknown[],
    requestedSpaceId?: string,
    metrics?: ChannelCatalogReadMetrics,
    deadline?: ChannelCatalogDeadline,
  ): Promise<ChannelAttentionSnapshot> {
    const bySpace = visibleChannelIdsBySpace(channels, requestedSpaceId);
    const spaces: ChannelAttentionSnapshot["spaces"] = [];
    for (const [projectedSpaceId, ids] of bySpace) {
      let complete = true;
      const summaries: ChannelAttentionSummary[] = [];
      for (let offset = 0; offset < ids.length; offset += 200) {
        const startedAt = Date.now();
        if (metrics) metrics.projectionReads += 1;
        try {
          const operation = readSpaceAttentionProjection(
            env, projectedSpaceId, subjectId, ids.slice(offset, offset + 200),
          );
          const rows = deadline
            ? await deadline.wait("projection", operation)
            : await operation;
          for (const row of rows) {
            if (row.summary && typeof row.summary === "object" && !Array.isArray(row.summary)) {
              summaries.push(row.summary as unknown as ChannelAttentionSummary);
            }
          }
        } catch (error) {
          complete = false;
          console.error("Space attention projection read failed", {
            spaceId: projectedSpaceId,
            channelCount: Math.min(200, ids.length - offset),
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        } finally {
          if (metrics) metrics.projectionWallMs += Date.now() - startedAt;
        }
      }
      spaces.push({ spaceId: projectedSpaceId, complete, summaries: complete ? summaries : [] });
    }
    return { protocolVersion: 1, spaces };
  }

  async function listChannelCatalogSpaceIds(
    env: Env,
    principal: { kind: "user"; id: string },
    metrics?: ChannelCatalogReadMetrics,
    deadline?: ChannelCatalogDeadline,
  ): Promise<{ ok: true; spaceIds: string[] } | { ok: false; response: Response }> {
    const startedAt = Date.now();
    try {
      const listed = listSpaces(env, principal);
      const spaces = deadline ? await deadline.wait("directory", listed) : await listed;
      return { ok: true, spaceIds: spaces.flatMap((candidate) => {
        const id = (candidate as { id?: unknown }).id;
        return typeof id === "string" && id ? [id] : [];
      }) };
    } catch (error) {
      return { ok: false, response: controlErrorResponse(error) };
    } finally {
      if (metrics) metrics.directoryWallMs += Date.now() - startedAt;
    }
  }

  return {
    readChannelCatalogForPrincipal,
    readChannelForPrincipal,
    readCompleteAuthorityChannelCatalog,
    listChannelCatalogSpaceIds,
  };
}

export const {
  readChannelCatalogForPrincipal,
  readChannelForPrincipal,
  readCompleteAuthorityChannelCatalog,
  listChannelCatalogSpaceIds,
} = createChannelCatalogReader(hubCatalogReadBoundary);
