import type { ChannelCatalogSyncMetadata } from "@xmatrix/protocol";

import type { Env } from "./types";
import {
  listChannelCatalogSpaceIds,
  readChannelCatalogForPrincipal,
  readCompleteAuthorityChannelCatalog,
  type ChannelCatalogRead,
} from "./channel-catalog-read";
import type { ChannelCatalogReadMetrics } from "./channel-catalog-observability";
import type { ChannelCatalogDeadline } from "./channel-catalog-deadline";
import { readSpaceFanoutChannelCatalog } from "./space-fanout-channel-catalog";
import {
  decodeChannelCatalogSyncToken,
  encodeChannelCatalogSyncToken,
  planChannelCatalogDelta,
  type CatalogRevisionVector,
} from "./channel-catalog-sync-token";
import { getChannelCatalogRevision } from "./spaces";

const CATALOG_SYNC_PROTOCOL_VERSION = 1 as const;
export type SyncedChannelCatalogRead = ChannelCatalogRead;

function syncMetadata(
  revisions: CatalogRevisionVector,
  complete: boolean,
  replacedSpaceIds: string[],
  removedSpaceIds: string[],
): ChannelCatalogSyncMetadata | undefined {
  const token = encodeChannelCatalogSyncToken(revisions);
  return token === undefined ? undefined : {
    protocolVersion: CATALOG_SYNC_PROTOCOL_VERSION,
    token,
    complete,
    replacedSpaceIds,
    removedSpaceIds,
  };
}

function revisionVector(record: Record<string, number> | undefined): CatalogRevisionVector {
  return new Map(Object.entries(record ?? {}).filter(([, revision]) =>
    Number.isSafeInteger(revision) && revision >= 0
  ));
}

async function fullCatalog(
  env: Env,
  principal: { kind: "user"; id: string },
  metrics?: ChannelCatalogReadMetrics,
  deadline?: ChannelCatalogDeadline,
): Promise<SyncedChannelCatalogRead> {
  const catalog = await readChannelCatalogForPrincipal(
    env, principal, undefined, metrics, deadline,
  );
  if (!catalog.ok) return catalog;
  const revisions = revisionVector(catalog.catalogRevisionsBySpace);
  const catalogSync = syncMetadata(revisions, true, [...revisions.keys()], []);
  return { ...catalog, ...(catalogSync ? { catalogSync } : {}) };
}

async function readSpaceRevision(
  env: Env,
  principal: { kind: "user"; id: string },
  spaceId: string,
  deadline?: ChannelCatalogDeadline,
): Promise<number | undefined> {
  // A Space whose revision cannot be read keeps the whole read uncached.
  const operation = getChannelCatalogRevision(env, { principal, spaceId }).catch(() => undefined);
  const result = deadline ? await deadline.wait("revision_probe", operation) : await operation;
  if (!result) return undefined;
  const revision = Number(result.revision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined;
}

async function readRevisionVector(
  env: Env,
  principal: { kind: "user"; id: string },
  spaceIds: string[],
  deadline?: ChannelCatalogDeadline,
): Promise<CatalogRevisionVector | undefined> {
  const revisions: CatalogRevisionVector = new Map();
  let cursor = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(8, spaceIds.length) }, async () => {
    while (cursor < spaceIds.length && !failed) {
      const spaceId = spaceIds[cursor++];
      if (!spaceId) return;
      const revision = await readSpaceRevision(env, principal, spaceId, deadline);
      if (revision === undefined) {
        failed = true;
        return;
      }
      revisions.set(spaceId, revision);
    }
  }));
  return failed ? undefined : revisions;
}

/**
 * Incrementally replace complete Space slices. A token is only a read hint:
 * Space membership and every changed catalog are re-authorized at its scoped authority.
 * Invalid/unsupported tokens conservatively fall back to a complete read.
 */
export async function readSyncedChannelCatalogForUser(
  env: Env,
  principal: { kind: "user"; id: string },
  token: string | undefined,
  metrics?: ChannelCatalogReadMetrics,
  deadline?: ChannelCatalogDeadline,
): Promise<SyncedChannelCatalogRead> {
  const previous = decodeChannelCatalogSyncToken(token);
  if (!previous) {
    if (metrics && token) metrics.catalogSyncMode = "fallback";
    return fullCatalog(env, principal, metrics, deadline);
  }
  if (metrics) metrics.catalogSyncMode = "incremental";

  const directory = await listChannelCatalogSpaceIds(env, principal, metrics, deadline);
  if (!directory.ok) return directory;
  const spaceIds = [...new Set(directory.spaceIds)].sort();
  const revisionStartedAt = Date.now();
  if (metrics) metrics.revisionProbes += spaceIds.length;
  const revisions = await readRevisionVector(env, principal, spaceIds, deadline);
  if (metrics) metrics.revisionProbeWallMs += Date.now() - revisionStartedAt;
  if (!revisions) {
    if (metrics) metrics.catalogSyncMode = "fallback";
    return fullCatalog(env, principal, metrics, deadline);
  }

  const { replacedSpaceIds, removedSpaceIds } = planChannelCatalogDelta(previous, revisions);
  if (metrics) {
    metrics.replacedSpaces += replacedSpaceIds.length;
    metrics.removedSpaces += removedSpaceIds.length;
  }
  const catalog = await readSpaceFanoutChannelCatalog({
    noSpacesCatalog: {
      ok: true,
      channels: [],
      openChannelHumanMemberIdsBySpace: Object.create(null),
    },
    listSpaceIds: async () => ({ ok: true, spaceIds: replacedSpaceIds }),
    readSpaceCatalog: (spaceId) => readCompleteAuthorityChannelCatalog(
      env, principal, spaceId, metrics, deadline,
    ),
  });
  if (!catalog.ok) return catalog;
  const catalogSync = syncMetadata(
    revisions, false, replacedSpaceIds, removedSpaceIds,
  );
  // An oversized vector cannot safely describe a partial response. Return a
  // complete catalog instead of making the client guess its coverage.
  if (!catalogSync) {
    if (metrics) metrics.catalogSyncMode = "fallback";
    return fullCatalog(env, principal, metrics, deadline);
  }
  const attentionBySpace = new Map(
    (catalog.attentionSnapshot?.spaces ?? []).map((entry) => [entry.spaceId, entry]),
  );
  for (let offset = 0; offset < spaceIds.length; offset += 8) {
    await Promise.all(spaceIds.slice(offset, offset + 8).map(async (spaceId) => {
      if (attentionBySpace.has(spaceId)) return;
      const snapshot = await readCompleteAuthorityChannelCatalog(env, principal, spaceId, metrics, deadline);
      if (!snapshot.ok) {
        attentionBySpace.set(spaceId, { spaceId, complete: false, summaries: [] });
        return;
      }
      attentionBySpace.set(
        spaceId,
        snapshot.attentionSnapshot?.spaces.find((entry) => entry.spaceId === spaceId) ??
          { spaceId, complete: false, summaries: [] },
      );
    }));
  }
  return {
    ...catalog,
    catalogSync,
    attentionSnapshot: {
      protocolVersion: 1,
      spaces: [...attentionBySpace.values()].sort((left, right) =>
        left.spaceId.localeCompare(right.spaceId)),
    },
  };
}
