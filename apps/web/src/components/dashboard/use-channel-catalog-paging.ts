"use client";

import {
  InfiniteQueryObserver,
  infiniteQueryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createElement, Fragment, useCallback, useEffect, useMemo, useReducer, useRef,
  type Dispatch, type ReactNode, type SetStateAction,
} from "react";
import type {
  ChannelCatalogPage,
  ChannelCatalogPageFilter,
  ChannelCatalogPageRow,
  ChannelCatalogPageView,
  ChannelCatalogResolveResult,
  SerializedChannel,
} from "@xmatrix/protocol";

import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import {
  fetchChannelCatalogPage,
  fetchChannelCatalogCounts,
  fetchChannelCatalogResolve,
  normalizeChannelCatalogQuery,
  type NormalizedChannelCatalogQuery,
} from "./channel-catalog-query";
import {
  createCatalogRefreshThrottle,
  observeSpaceCatalogRevision,
  refreshSpaceCatalogForEvent,
  rowsFromData,
  type ChannelCatalogChangeDetail,
} from "./channel-catalog-refresh";
import { exactChannelIdFromRouteKey, routeEntityTokenFromKey } from "./channel-links";
import { mergeChannelListHydratedFields } from "./workspace-admin-views";
import { listenForForegroundRefresh } from "./foreground-refresh";
import { userErrorMessage } from "../../lib/user-facing-error";

export interface ChannelCatalogQuery {
  view: ChannelCatalogPageView;
  filter?: ChannelCatalogPageFilter;
  scopeChannelId?: string | null;
  query?: string;
}

export interface ChannelCatalogClientPage {
  rows: ChannelCatalogPageRow[];
  nextCursor: string | null;
  counts: ChannelCatalogPage["counts"] | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

/**
 * The catalog of one named Space. Every read and load is bound to the Space it
 * was asked for, so nothing here inherits an ambient "current" Space: a view
 * showing two Spaces holds two of these instead of switching one.
 */
export interface SpaceChannelCatalog {
  spaceId: string | null;
  page(query: ChannelCatalogQuery): ChannelCatalogClientPage;
  load(query: ChannelCatalogQuery, options?: { append?: boolean; force?: boolean }): Promise<void>;
  resolve(channelIds: string[], routeToken?: string): Promise<ChannelCatalogResolveResult>;
}

export interface ChannelCatalogPagingModel {
  /** Every Space this shell is loading, in the order it was asked for. */
  spaceIds: readonly string[];
  /**
   * The catalog of one Space. An id outside `spaceIds` — or null — answers an
   * inert catalog rather than throwing, so a view can render before the Space
   * list resolves.
   */
  forSpace(spaceId: string | null): SpaceChannelCatalog;
  /**
   * Live root subscriptions, one per Space, for the shell to render. They are
   * elements rather than hooks because the Space count is dynamic and each
   * Space needs its own `useInfiniteQuery`: a catalog cursor is bound to that
   * Space's Durable Object, and TanStack Query cannot hold N infinite queries
   * in one `useQueries`. Dropping the observer instead was the other option and
   * a worse one — an unobserved root is garbage collected at `gcTime` and the
   * sidebar empties until something reloads it.
   */
  roots: ReactNode;
}

const EMPTY_PAGE: ChannelCatalogClientPage = Object.freeze({
  rows: [], nextCursor: null, counts: null, loading: false, loaded: false, error: null,
});

/** Answers for a Space this shell is not loading: every read empty, every write a no-op. */
const INERT_SPACE_CATALOG: SpaceChannelCatalog = Object.freeze({
  spaceId: null,
  page: () => EMPTY_PAGE,
  load: async () => undefined,
  resolve: async () => ({ protocolVersion: 1 as const, channels: [], pathsByChannelId: {} }),
});

function mergeChannels(current: SerializedChannel[], incoming: readonly SerializedChannel[]) {
  const byId = new Map(current.map((channel) => [channel.id, channel]));
  for (const channel of incoming) {
    const prior = byId.get(channel.id);
    // Page/resolve responses race live presence just like channel_updated.
    // Use its merge contract rather than replacing a hydrated instance with
    // a sparse or older catalog row (and losing tags and busy status).
    byId.set(channel.id, mergeChannelListHydratedFields(prior, channel));
  }
  return [...byId.values()];
}

function catalogOptions(input: {
  token: string;
  userId: string;
  spaceId: string;
  query: NormalizedChannelCatalogQuery;
}) {
  return infiniteQueryOptions({
    queryKey: xmatrixQueryKeys.channelCatalog({
      userId: input.userId, spaceId: input.spaceId, ...input.query,
    }) as QueryKey,
    queryFn: ({ pageParam, signal }) => fetchChannelCatalogPage({
      token: input.token, spaceId: input.spaceId, query: input.query,
      cursor: pageParam, signal,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 15_000,
  });
}

function pageFromCache(client: QueryClient, queryKey: QueryKey): ChannelCatalogClientPage {
  const state = client.getQueryState<InfiniteData<ChannelCatalogPage, string | null>>(queryKey);
  const data = state?.data;
  const last = data?.pages.at(-1);
  return {
    rows: rowsFromData(data),
    nextCursor: last?.nextCursor ?? null,
    counts: data?.pages[0]?.counts ?? null,
    loading: state?.fetchStatus === "fetching",
    loaded: Boolean(data?.pages.length),
    error: state?.status === "error"
      ? userErrorMessage(state.error, "Couldn't load channels")
      : null,
  };
}

/** The one list every Channel view reads: every conversation, most recently active first. */
export const CONVERSATION_QUERY = { view: "flat", filter: "all" } as const;
/** An open project's intake (open-project-governance.md §3). */
export const INTAKE_QUERY = { view: "intake", filter: "all" } as const;

/**
 * Holds one Space's conversation list and counts open. Rendering nothing is the point:
 * it exists so each Space has its own live QueryObserver. Counts land in the
 * query cache rather than in state so the model can read them for any Space
 * without this component having to report upward.
 */
function SpaceCatalogRoot({ token, userId, spaceId, onRows, enabled }: {
  enabled: boolean;
  token: string;
  userId: string;
  spaceId: string;
  onRows: (rows: readonly ChannelCatalogPageRow[]) => void;
}): null {
  const rootQuery = useMemo(() => normalizeChannelCatalogQuery(CONVERSATION_QUERY), []);
  const rootCatalog = useInfiniteQuery({
    ...catalogOptions({ token, userId, spaceId, query: rootQuery }),
    enabled,
  });
  useQuery({
    queryKey: xmatrixQueryKeys.channelCatalogCounts({ userId, spaceId }),
    queryFn: ({ signal }) => fetchChannelCatalogCounts({ token, spaceId, signal }),
    enabled: rootCatalog.isSuccess && enabled,
    staleTime: 15_000,
  });

  // A memory-speed response (tests, service worker, warm browser cache) can
  // settle before the query-cache subscription effect is installed. Project the
  // observed result too so the entity table cannot miss that first success.
  const data = rootCatalog.data;
  useEffect(() => {
    if (data) onRows(rowsFromData(data));
  }, [data, onRows]);
  return null;
}

export function useChannelCatalogPaging(input: {
  token?: string;
  backgroundReady?: boolean;
  /** Every Space to load. One entry is the ordinary shell; more is a multi-Space view. */
  spaceIds: readonly string[];
  /** The Space named by the URL, which owns route channel resolution. */
  routeSpaceId?: string | null;
  routeChannelId?: string | null;
  routeChannelKey?: string | null;
  channels: SerializedChannel[];
  setChannels: Dispatch<SetStateAction<SerializedChannel[]>>;
  setSelectedChannelId: Dispatch<SetStateAction<string | null>>;
}): ChannelCatalogPagingModel {
  const {
    token,
    backgroundReady = true,
    spaceIds,
    routeSpaceId,
    routeChannelId,
    routeChannelKey,
    channels,
    setChannels,
    setSelectedChannelId,
  } = input;
  const auth = useAuth();
  const userId = auth.user?.id ?? "";
  const client = useQueryClient();
  const [, rerender] = useReducer((value) => value + 1, 0);
  // Identity, not just contents: a new array of the same ids must not remount
  // every Space's root subscription and refetch its whole tree.
  const spaceIdKey = [...spaceIds].join("\u0000");
  const loadedSpaceIds = useMemo(
    () => (token && userId ? spaceIds.filter(Boolean) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spaceIdKey, token, userId],
  );
  const loadedSpaceIdSet = useMemo(() => new Set(loadedSpaceIds), [loadedSpaceIds]);

  const commitRows = useCallback((rows: readonly ChannelCatalogPageRow[]) => {
    setChannels((current) => mergeChannels(current, rows.map((row) => row.channel)));
  }, [setChannels]);

  const roots = useMemo(() => createElement(
    Fragment,
    null,
    ...loadedSpaceIds.map((id) => createElement(SpaceCatalogRoot, {
      key: id, token: token ?? "", userId, spaceId: id, onRows: commitRows, enabled: backgroundReady,
    })),
  ), [backgroundReady, commitRows, loadedSpaceIds, token, userId]);

  useEffect(() => client.getQueryCache().subscribe((event) => {
    if (event.type !== "added" && event.type !== "removed" && event.type !== "updated") return;
    const key = event.query.queryKey;
    if (key[0] !== "xmatrix" || key[3] !== "channels") return;
    if (typeof key[4] !== "string" || !loadedSpaceIdSet.has(key[4])) return;
    const data = event.query.state.data as InfiniteData<ChannelCatalogPage, string | null> | undefined;
    if (key[5] === "catalog" && data) {
      commitRows(rowsFromData(data));
      for (const page of data.pages) {
        observeSpaceCatalogRevision({
          client,
          spaceId: key[4],
          prefix: xmatrixQueryKeys.channels({ userId, spaceId: key[4] }),
          countsKey: xmatrixQueryKeys.channelCatalogCounts({ userId, spaceId: key[4] }),
          revision: page.catalogRevision,
          sourceQueryKey: key,
          sourceQueryHash: event.query.queryHash,
        });
      }
    }
    rerender();
  }), [client, commitRows, loadedSpaceIdSet, userId]);

  const queryKey = useCallback((spaceId: string, query: ChannelCatalogQuery) => {
    if (!spaceId || !userId) return null;
    return xmatrixQueryKeys.channelCatalog({
      userId, spaceId, ...normalizeChannelCatalogQuery(query),
    });
  }, [userId]);

  const load = useCallback(async (
    spaceId: string,
    rawQuery: ChannelCatalogQuery,
    request: { append?: boolean; force?: boolean } = {},
  ) => {
    if (!token || !spaceId || !userId) return;
    const query = normalizeChannelCatalogQuery(rawQuery);
    const options = catalogOptions({ token, userId, spaceId, query });
    const current = client.getQueryData<InfiniteData<ChannelCatalogPage, string | null>>(options.queryKey);
    if (request.force) await client.cancelQueries({ queryKey: options.queryKey, exact: true });
    if (!request.append) {
      if (current && !request.force) return;
      // Retry keeps the rows on screen. resetQueries would drop them and the
      // list would flash a skeleton until the same catalog came back.
      if (request.force && current) {
        await client.invalidateQueries({
          queryKey: options.queryKey,
          exact: true,
          refetchType: "all",
        }).catch(() => undefined);
        return;
      }
      // Every caller fires and forgets: the list reads the cache, and a failure
      // stays in the query's state. A fetch would reject when its last observer
      // unmounts mid-request (CancelledError), and nobody would catch it.
      await client.prefetchInfiniteQuery(options);
      return;
    }
    // The next page extends the same infinite query, so the cache holds one
    // shape and a continuation requests only the page after the last one.
    if (!current?.pages.at(-1)?.nextCursor) return;
    await new InfiniteQueryObserver(client, options).fetchNextPage();
  }, [client, token, userId]);

  const resolve = useCallback(async (spaceId: string, channelIds: string[], routeToken?: string, fresh = false) => {
    if (!token || !spaceId || !userId) {
      return { protocolVersion: 1 as const, channels: [], pathsByChannelId: {} };
    }
    const ids = [...new Set(channelIds)].slice(0, 200);
    const result = await client.fetchQuery({
      queryKey: xmatrixQueryKeys.channelResolve({
        userId, spaceId, channelIds: ids, routeToken, includeParticipants: true,
      }),
      queryFn: ({ signal }) => fetchChannelCatalogResolve({
        token, spaceId, channelIds: ids, routeToken, includeParticipants: true, signal,
      }),
      staleTime: fresh ? 0 : 30_000,
    });
    setChannels((current) => mergeChannels(current, result.channels));
    return result;
  }, [client, setChannels, token, userId]);

  const resolvedRouteKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || !token) return;
    return listenForForegroundRefresh(() => {
      window.dispatchEvent(new CustomEvent("xmatrix:channel-catalog-change", {
        detail: { kind: "resume" },
      }));
    });
  }, [userId, token]);

  useEffect(() => {
    const routeKey = routeChannelKey?.trim() || "";
    const exactRouteChannelId = exactChannelIdFromRouteKey(routeKey);
    const routeToken = routeChannelId || exactRouteChannelId
      ? null : routeEntityTokenFromKey(routeKey, "c");
    const requestedChannelId = routeChannelId?.trim() || exactRouteChannelId ||
      (routeToken ? null : routeKey);
    if ((!requestedChannelId && !routeToken) || !token || !userId || !routeSpaceId) return;
    const resolveKey = `${userId}\u0000${routeSpaceId}\u0000${routeKey}`;
    if (resolvedRouteKeyRef.current === resolveKey) return;
    resolvedRouteKeyRef.current = resolveKey;
    let active = true;
    void resolve(routeSpaceId, requestedChannelId ? [requestedChannelId] : [],
      routeToken ?? undefined).then((result) => {
      const path = requestedChannelId
        ? result.pathsByChannelId[requestedChannelId]
        : result.pathsByRouteToken?.[routeToken!];
      const resolvedChannelId = path?.at(-1);
      if (active && resolvedChannelId) setSelectedChannelId(resolvedChannelId);
    }).catch(() => undefined);
    return () => {
      active = false;
      if (resolvedRouteKeyRef.current === resolveKey) resolvedRouteKeyRef.current = null;
    };
  }, [resolve, routeChannelId, routeChannelKey, routeSpaceId, setSelectedChannelId, token, userId]);

  const refreshCatalogRef = useRef<(spaceId: string, details: ChannelCatalogChangeDetail[]) => void>(() => {});
  useEffect(() => {
    refreshCatalogRef.current = (spaceId, details) => {
      if (!userId) return;
      for (const detail of details) {
        refreshSpaceCatalogForEvent({
          client,
          spaceId,
          prefix: xmatrixQueryKeys.channels({ userId, spaceId }),
          countsKey: xmatrixQueryKeys.channelCatalogCounts({ userId, spaceId }),
          detail,
          hasChannel: (channelId) => channels.some((channel) => channel.id === channelId),
          resolveChannel: (targetSpaceId, channelId, fresh) => {
            void resolve(targetSpaceId, [channelId], undefined, fresh).catch(() => undefined);
          },
        });
      }
    };
  }, [channels, client, resolve, userId]);

  useEffect(() => {
    // Busy Spaces change their catalog many times a second; the reads are
    // merged per Space instead of restarted per change.
    const throttle = createCatalogRefreshThrottle((spaceId, details) => refreshCatalogRef.current(spaceId, details));
    const onChange = (raw: Event) => {
      const detail = (raw as CustomEvent<ChannelCatalogChangeDetail>).detail;
      if (!userId) return;
      // An event that names a Space refreshes that one; an unnamed event cannot
      // say which Space moved, so every loaded Space has to re-read.
      const targets = detail?.spaceId
        ? (loadedSpaceIdSet.has(detail.spaceId) ? [detail.spaceId] : [])
        : loadedSpaceIds;
      for (const spaceId of targets) throttle.push(spaceId, detail);
    };
    window.addEventListener("xmatrix:channel-catalog-change", onChange);
    return () => {
      window.removeEventListener("xmatrix:channel-catalog-change", onChange);
      throttle.dispose();
    };
  }, [loadedSpaceIdSet, loadedSpaceIds, userId]);

  return useMemo(() => {
    // Live entities, shared by every Space: catalog snapshots select the rows,
    // but may predate realtime message activity on those channels.
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const liveRow = (row: ChannelCatalogPageRow): ChannelCatalogPageRow => ({
      ...row, channel: byId.get(row.channel.id) ?? row.channel,
    });

    const catalogFor = (spaceId: string): SpaceChannelCatalog => {
      const counts = client.getQueryData<ChannelCatalogPage["counts"]>(
        xmatrixQueryKeys.channelCatalogCounts({ userId, spaceId }),
      );
      return {
        spaceId,
        page: (query: ChannelCatalogQuery) => {
          const key = queryKey(spaceId, query);
          if (!key) return EMPTY_PAGE;
          const page = pageFromCache(client, key);
          return { ...page, counts: counts ?? page.counts, rows: page.rows.map(liveRow) };
        },
        load: (query, options) => load(spaceId, query, options),
        resolve: (channelIds, routeToken) => resolve(spaceId, channelIds, routeToken),
      };
    };

    const catalogs = new Map(loadedSpaceIds.map((id) => [id, catalogFor(id)]));
    return {
      spaceIds: loadedSpaceIds,
      forSpace: (spaceId: string | null) =>
        (spaceId ? catalogs.get(spaceId) : undefined) ?? INERT_SPACE_CATALOG,
      roots,
    };
  }, [channels, client, load, loadedSpaceIds, queryKey, resolve, roots, userId]);
}
