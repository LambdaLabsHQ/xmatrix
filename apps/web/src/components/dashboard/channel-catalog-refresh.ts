import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type { ChannelCatalogPage, ChannelCatalogPageRow } from "@xmatrix/protocol";

/** Flatten an infinite catalog query's pages into one row per channel, last write winning. */
export function rowsFromData(
  data: InfiniteData<ChannelCatalogPage, unknown> | undefined,
): ChannelCatalogPageRow[] {
  const rows = new Map<string, ChannelCatalogPageRow>();
  for (const page of data?.pages ?? []) {
    for (const row of page.rows) rows.set(row.channel.id, row);
  }
  return [...rows.values()];
}

export interface ChannelCatalogChangeDetail {
  kind?: string;
  channelId?: string;
  spaceId?: string;
  revision?: number;
}

const revisionWatermarks = new WeakMap<QueryClient, Map<string, number>>();
const staleRefetchWatermarks = new WeakMap<QueryClient, Map<string, number>>();

function watermarkMap(client: QueryClient): Map<string, number> {
  let watermarks = revisionWatermarks.get(client);
  if (!watermarks) {
    watermarks = new Map();
    revisionWatermarks.set(client, watermarks);
  }
  return watermarks;
}

function queryCatalogRevision(data: unknown): number {
  const pages = (data as InfiniteData<ChannelCatalogPage, unknown> | undefined)?.pages;
  if (!Array.isArray(pages) || pages.length === 0) return 0;
  const revisions = pages.map((page) => Number.isSafeInteger(page.catalogRevision)
    ? page.catalogRevision : 0);
  return Math.min(...revisions);
}

/**
 * Observe one authoritative Space watermark from either HTTP or WebSocket.
 * Revision zero is the explicit legacy/unknown sentinel and never advances it.
 */
export function observeSpaceCatalogRevision(input: {
  client: QueryClient;
  spaceId: string;
  prefix: QueryKey;
  countsKey: QueryKey;
  revision: number;
  sourceQueryKey?: QueryKey;
  sourceQueryHash?: string;
}): boolean {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) return false;
  const watermarks = watermarkMap(input.client);
  const current = watermarks.get(input.spaceId) ?? 0;
  if (input.revision < current && input.sourceQueryKey && input.sourceQueryHash) {
    let stale = staleRefetchWatermarks.get(input.client);
    if (!stale) {
      stale = new Map();
      staleRefetchWatermarks.set(input.client, stale);
    }
    if ((stale.get(input.sourceQueryHash) ?? 0) < current) {
      stale.set(input.sourceQueryHash, current);
      void input.client.invalidateQueries({
        queryKey: input.sourceQueryKey, exact: true, refetchType: "all",
      });
    }
    return false;
  }
  if (input.revision <= current) return false;
  watermarks.set(input.spaceId, input.revision);
  // Speculation is never a visible/authoritative index. Drop it on a newer
  // catalog revision rather than refetching every unopened branch.
  input.client.removeQueries({ queryKey: input.prefix,
    predicate: (query) => query.queryKey[5] === "child-prefetch" &&
      queryCatalogRevision(query.state.data) < input.revision });
  void input.client.invalidateQueries({
    queryKey: input.prefix,
    predicate: (query) => query.queryKey[5] === "catalog" &&
      query.queryKey.length === 10 &&
      queryCatalogRevision(query.state.data) < input.revision,
    refetchType: "all",
  });
  void input.client.invalidateQueries({ queryKey: input.countsKey, exact: true });
  return true;
}

/**
 * Bring one Space's cached catalog indexes back in line after a realtime change.
 *
 * Extracted from the hook so the guarantee is testable against a real
 * QueryClient rather than by scraping an effect closure, and so a shell holding
 * several Spaces refreshes each of them through the same path.
 */
export function refreshSpaceCatalogForEvent(input: {
  client: QueryClient;
  spaceId: string;
  /** This Space's channel query prefix; the caller owns key derivation. */
  prefix: QueryKey;
  /** This Space's catalog-counts key. */
  countsKey: QueryKey;
  detail?: ChannelCatalogChangeDetail;
  /** Whether the entity table already holds this channel. */
  hasChannel: (channelId: string) => boolean;
  /** Pull a channel into the entity table; `fresh` bypasses the cached read. */
  resolveChannel: (spaceId: string, channelId: string, fresh?: boolean) => void;
}): void {
  const { client, spaceId, prefix, countsKey, detail } = input;
  client.removeQueries({ queryKey: prefix,
    predicate: (query) => query.queryKey[5] === "child-prefetch" });

  if (detail?.kind === "revision" && detail.revision !== undefined) {
    observeSpaceCatalogRevision({
      client, spaceId, prefix, countsKey, revision: detail.revision,
    });
    return;
  }

  // `presence`: an Instance left or changed its rest, so the channel's member
  // presence must be read again even though the channel is already known.
  if ((detail?.kind === "message" || detail?.kind === "presence") && detail.channelId) {
    const channelId = detail.channelId;
    const affected = client.getQueryCache().findAll({ queryKey: prefix }).filter((query) => {
      if (query.queryKey[5] !== "catalog") return false;
      // Activity can move an unloaded Channel into the first flat page, or
      // make it enter a filtered list. Existing row membership is insufficient.
      if (query.queryKey[6] === "flat") return true;
      const data = query.state.data as InfiniteData<ChannelCatalogPage, string | null> | undefined;
      return rowsFromData(data).some((row) => row.channel.id === channelId);
    });
    for (const query of affected) {
      void client.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "all" });
    }
    void client.invalidateQueries({ queryKey: countsKey, exact: true });
    if (detail.kind === "presence") input.resolveChannel(spaceId, channelId, true);
    else if (!input.hasChannel(channelId)) input.resolveChannel(spaceId, channelId);
    return;
  }

  // Flat and expanded child pages are fetched imperatively, so they have no
  // active QueryObserver. Structural changes must refresh those cached indexes
  // too, otherwise new channels remain absent from their rows.
  void client.invalidateQueries({
    queryKey: prefix,
    predicate: (query) => query.queryKey[5] === "catalog" && query.queryKey.length === 10,
    refetchType: "all",
  });
  void client.invalidateQueries({
    queryKey: prefix,
    predicate: (query) => query.queryKey[5] !== "catalog" || query.queryKey.length !== 10,
  });
}

export const CATALOG_REFRESH_WINDOW_MS = 500;

/**
 * The refreshes a burst of catalog changes needs, merged: a structural change
 * re-reads everything once, so it absorbs the per-Channel ones; otherwise each
 * Channel's change is kept once (a presence change, which re-reads the Channel,
 * absorbs a message change) and only the highest revision watermark matters.
 */
export function coalesceCatalogChanges(
  details: readonly ChannelCatalogChangeDetail[],
): ChannelCatalogChangeDetail[] {
  let revision: ChannelCatalogChangeDetail | undefined;
  let structure: ChannelCatalogChangeDetail | undefined;
  const perChannel = new Map<string, ChannelCatalogChangeDetail>();
  for (const detail of details) {
    if (detail.kind === "revision" && detail.revision !== undefined) {
      if (!revision || detail.revision > revision.revision!) revision = detail;
    } else if ((detail.kind === "message" || detail.kind === "presence") && detail.channelId) {
      const known = perChannel.get(detail.channelId);
      if (!known || detail.kind === "presence") perChannel.set(detail.channelId, detail);
    } else {
      structure ??= detail;
    }
  }
  return [
    ...(revision ? [revision] : []),
    ...(structure ? [structure] : [...perChannel.values()]),
  ];
}

/**
 * Applies catalog changes at most once per window per Space: the first change
 * refreshes at once, the rest of the window is merged into one refresh at its
 * end. A Space with many working Agents would otherwise cancel and restart its
 * catalog read on every change and never finish one.
 */
export function createCatalogRefreshThrottle(
  apply: (spaceId: string, details: ChannelCatalogChangeDetail[]) => void,
  windowMs = CATALOG_REFRESH_WINDOW_MS,
) {
  const windows = new Map<string, { pending: ChannelCatalogChangeDetail[]; timer: ReturnType<typeof setTimeout> }>();
  const close = (spaceId: string) => {
    const open = windows.get(spaceId);
    windows.delete(spaceId);
    if (open?.pending.length) {
      apply(spaceId, coalesceCatalogChanges(open.pending));
      windows.set(spaceId, { pending: [], timer: setTimeout(() => close(spaceId), windowMs) });
    }
  };
  return {
    push(spaceId: string, detail: ChannelCatalogChangeDetail | undefined) {
      const open = windows.get(spaceId);
      if (open) {
        open.pending.push(detail ?? {});
        return;
      }
      apply(spaceId, [detail ?? {}]);
      windows.set(spaceId, { pending: [], timer: setTimeout(() => close(spaceId), windowMs) });
    },
    dispose() {
      for (const open of windows.values()) clearTimeout(open.timer);
      windows.clear();
    },
  };
}
