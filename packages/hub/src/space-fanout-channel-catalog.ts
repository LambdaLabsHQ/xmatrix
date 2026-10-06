import type { ChannelAttentionSnapshot, ChannelProjectionCacheManifest } from "@xmatrix/protocol";

type CatalogFailure = { ok: false; response: Response };

export type SpaceFanoutChannelCatalog = {
  ok: true;
  channels: unknown[];
  openChannelHumanMemberIdsBySpace: Record<string, readonly string[]>;
  projectionCacheManifest?: ChannelProjectionCacheManifest;
  /** Conservative scoped-authority commit head sampled before this Space page was read. */
  catalogRevision?: number;
  catalogRevisionsBySpace?: Record<string, number>;
  attentionSnapshot?: ChannelAttentionSnapshot;
};

/**
 * Read a user's whole Channel catalog as the union over their Spaces.
 *
 * A catalog read that names no Space names no routable scope, so Authority routing
 * scans Space roots and answers with the first target that does not 404. That
 * is the right shape for finding one entity by id and the wrong one for a
 * list: a Space root answers a non-member's list with 200 and an empty page,
 * never 404, so the scan stops at the first Space in manifest order and the
 * reader is handed that Space alone. The union therefore has to be assembled
 * here, from the authoritative Space directory — for every user, not only for
 * the ones whose scan happened to land on a Space they have no Channel in.
 */
export async function readSpaceFanoutChannelCatalog(input: {
  /** Returned verbatim when the directory names no Space at all. */
  noSpacesCatalog: SpaceFanoutChannelCatalog;
  listSpaceIds: () => Promise<{ ok: true; spaceIds: string[] } | CatalogFailure>;
  readSpaceCatalog: (
    spaceId: string,
  ) => Promise<SpaceFanoutChannelCatalog | CatalogFailure>;
}): Promise<SpaceFanoutChannelCatalog | CatalogFailure> {
  const spaces = await input.listSpaceIds();
  if (!spaces.ok) return spaces;
  // A directory that named a Space twice would read it twice and hand back
  // each of its Channels twice; the union is over distinct Spaces.
  const spaceIds = [...new Set(spaces.spaceIds)];
  if (spaceIds.length === 0) return input.noSpacesCatalog;

  const channels: unknown[] = [];
  const openChannelHumanMemberIdsBySpace: Record<string, readonly string[]> =
    Object.create(null);
  const merge = beginProjectionCacheMerge();
  const catalogRevisionsBySpace: Record<string, number> = Object.create(null);
  const attentionSpaces: ChannelAttentionSnapshot["spaces"] = [];
  for (let offset = 0; offset < spaceIds.length; offset += 8) {
    const page = await Promise.all(
      spaceIds.slice(offset, offset + 8).map(async (spaceId) => ({
        spaceId,
        catalog: await input.readSpaceCatalog(spaceId),
      })),
    );
    for (const { spaceId, catalog } of page) {
      if (!catalog.ok) return catalog;
      channels.push(...catalog.channels);
      Object.assign(
        openChannelHumanMemberIdsBySpace,
        catalog.openChannelHumanMemberIdsBySpace,
      );
      if (catalog.catalogRevision !== undefined) {
        catalogRevisionsBySpace[spaceId] = catalog.catalogRevision;
      }
      merge.add(catalog);
      if (catalog.attentionSnapshot) attentionSpaces.push(...catalog.attentionSnapshot.spaces);
    }
  }
  const projectionCacheManifest = merge.result();
  return {
    ok: true,
    channels,
    openChannelHumanMemberIdsBySpace,
    catalogRevisionsBySpace,
    attentionSnapshot: { protocolVersion: 1, spaces: attentionSpaces },
    ...(projectionCacheManifest ? { projectionCacheManifest } : {}),
  };
}

/**
 * Fold the per-Space restart-cache manifests into one, on the same terms the
 * per-page merge already uses: every contributing manifest must agree on the
 * current authority, and a scope two Spaces both name must be byte-identical.
 * Anything else is a cache miss, which is a miss for the whole catalog —
 * presenting a cached tail under authority that is not provably current is the
 * one failure this material exists to prevent.
 */
function beginProjectionCacheMerge(): {
  add: (catalog: SpaceFanoutChannelCatalog) => void;
  result: () => ChannelProjectionCacheManifest | undefined;
} {
  let eligible = true;
  let authority: ChannelProjectionCacheManifest["authority"] | undefined;
  const scopes = new Map<string, ChannelProjectionCacheManifest["scopes"][number]>();
  return {
    add: (catalog) => {
      if (!eligible) return;
      const manifest = catalog.projectionCacheManifest;
      // A Space that contributed Channels without a manifest cannot be cached,
      // and a partial manifest would silently claim it could. A Space that
      // contributed nothing has nothing to verify, so it stays out of the way.
      if (!manifest || manifest.protocolVersion !== 1) {
        if (manifest || catalog.channels.length > 0) eligible = false;
        return;
      }
      if (
        authority &&
        (authority.authorizationEpoch !== manifest.authority.authorizationEpoch ||
          authority.entitlementDigest !== manifest.authority.entitlementDigest)
      ) {
        eligible = false;
        return;
      }
      authority = manifest.authority;
      for (const scope of manifest.scopes) {
        const existing = scopes.get(scope.scopeId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(scope)) {
          eligible = false;
          return;
        }
        scopes.set(scope.scopeId, scope);
      }
    },
    result: () => (eligible && authority
      ? {
          protocolVersion: 1 as const,
          authority,
          scopes: Array.from(scopes.values()).sort((left, right) =>
            left.scopeId.localeCompare(right.scopeId)
          ),
        }
      : undefined),
  };
}
