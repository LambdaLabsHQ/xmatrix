// Product tail cache engine for the workspace shell (peeled by semantic
// domain from use-workspace-shell-state.ts). Owns the durable bounded-tail
// candidate store, the catalog-manifest admission gate, write-through
// persistence, and socket-generation tail-contiguity tracking.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildProductTailCacheEntry,
  decideProductTailCacheAdmission,
  type ProductTailCacheEntry,
  type ProductTailCacheMessage,
} from "@/lib/relay-v2/product-tail-cache";
import { ProductTailCacheStore } from "@/lib/relay-v2/product-tail-cache-store";
import {
  channelCatalogContentRevision,
  latestChannelContentRevision,
  noteChannelContentRevision,
} from "@/lib/relay-v2/channel-content-revision";
import {
  browserTailCacheNamespace,
  latestSequence,
  sortChannels,
  PRODUCT_TAIL_CACHE_PERSIST_DEBOUNCE_MS,
  type ChannelHistoryCacheEntry,
  type HistoryRenderAuthority,
} from "./workspace-shell-modules";
import type { ChannelMessage, SerializedChannel } from "@xmatrix/protocol";

export function useWorkspaceShellTailCache(deps: {
  user: { id: string } | null;
  mobileListFixture: unknown;
  channels: SerializedChannel[];
  channelsRef: React.MutableRefObject<SerializedChannel[]>;
  historyCacheRef: React.MutableRefObject<Map<string, ChannelHistoryCacheEntry>>;
  historyRenderAuthoritiesRef: React.MutableRefObject<Map<string, HistoryRenderAuthority>>;
  historyRevisionRef: React.MutableRefObject<number>;
  selectedChannelIdRef: React.MutableRefObject<string | null>;
  historyChannelIdRef: React.MutableRefObject<string | null>;
  historyRef: React.MutableRefObject<ChannelMessage[]>;
  hasOlderMessagesRef: React.MutableRefObject<boolean>;
  latestHistorySequenceRef: React.MutableRefObject<number>;
  relayPushConnectedRef: React.MutableRefObject<boolean>;
  relaySocketRef: React.MutableRefObject<WebSocket | null>;
  setHistory: (messages: ChannelMessage[]) => void;
  setHasOlderMessages: (value: boolean) => void;
  setLoadingHistory: (value: boolean) => void;
  authorizeHistoryRender: (authority: HistoryRenderAuthority) => void;
  bumpHistoryCacheRevision: () => void;
  clearChannelHistory: (channelId?: string) => void;
  syncChannelSummaryFromHistory: (channelId: string, messages: ChannelMessage[]) => void;
}) {
  const {
    user,
    mobileListFixture,
    channels,
    channelsRef,
    historyCacheRef,
    historyRenderAuthoritiesRef,
    historyRevisionRef,
    selectedChannelIdRef,
    historyChannelIdRef,
    historyRef,
    hasOlderMessagesRef,
    latestHistorySequenceRef,
    relayPushConnectedRef,
    relaySocketRef,
    setHistory,
    setHasOlderMessages,
    setLoadingHistory,
    authorizeHistoryRender,
    bumpHistoryCacheRevision,
    clearChannelHistory,
    syncChannelSummaryFromHistory,
  } = deps;

  // Tail-contiguity tracking for incremental (afterSequence) refresh. A cached
  // window's tail is provably gap-free only while the realtime socket has
  // stayed connected since the window's last full authorized page: deltas are
  // delivered in order on one connection, so cache + deltas === server tail.
  // Each socket loss bumps the generation, which invalidates every claim until
  // the next full page. A page applied while disconnected records -1 (never
  // contiguous) because messages appended between that fetch and the next
  // human_connected would be silently missing.
  const relaySocketGenerationRef = useRef(1);
  const historyTailBaseGenerationRef = useRef<Map<string, number>>(new Map());
  // Product tail cache (durable bounded-tail history behind the catalog's
  // per-channel content watermark). Candidates are loaded bytes that have
  // proven nothing yet; they render only after decideProductTailCacheAdmission
  // accepts them against a fresh authenticated catalog row. Stamps track what
  // an admitted channel proved so later catalogs can close the gate again
  // while the window is still made of disk bytes.
  const productTailCacheStoreRef = useRef<ProductTailCacheStore | null>(null);
  const productTailCacheUserIdRef = useRef<string | null>(null);
  const productTailCacheCandidatesRef = useRef<Map<string, ProductTailCacheEntry>>(new Map());
  const productTailCacheHydratedStampsRef = useRef<
    Map<string, { appliedContentRevision: number }>
  >(new Map());
  const productTailCacheGapRef = useRef<Map<string, number>>(new Map());
  const productTailCachePersistTimersRef = useRef<Map<string, number>>(new Map());
  // Presentation-only cold-start catalog (disk rows shown before auth resolves).
  const [cachedCatalogChannels, setCachedCatalogChannels] = useState<SerializedChannel[]>([]);

  // Read the last same-device catalog in parallel with native-session auth.
  // Only the inert list is rendered from this path; no token or authority is
  // inferred from the persisted user partition.
  useEffect(() => {
    if (user?.id || mobileListFixture) return;
    const cachedUserId = ProductTailCacheStore.lastCatalogUserId();
    if (!cachedUserId) return;
    let cancelled = false;
    void (async () => {
      const store = await ProductTailCacheStore.open(browserTailCacheNamespace(cachedUserId));
      if (!store) return;
      const catalog = await store.readCatalog();
      store.close();
      if (!cancelled && catalog.length > 0) setCachedCatalogChannels(sortChannels(catalog));
    })();
    return () => {
      cancelled = true;
    };
  }, [mobileListFixture, user?.id]);

  const relaySocketLive = useCallback((): boolean => (
    relayPushConnectedRef.current &&
    relaySocketRef.current?.readyState === WebSocket.OPEN
  ), [relayPushConnectedRef, relaySocketRef]);

  const recordHistoryTailBase = useCallback((channelId: string): void => {
    historyTailBaseGenerationRef.current.set(
      channelId,
      relaySocketLive() ? relaySocketGenerationRef.current : -1,
    );
  }, [relaySocketLive]);

  const historyTailContiguous = useCallback((channelId: string): boolean => (
    relaySocketLive() &&
    historyTailBaseGenerationRef.current.get(channelId) === relaySocketGenerationRef.current
  ), [relaySocketLive]);

  const [productTailCacheAdmissionInput, setProductTailCacheAdmissionInput] = useState(0);
  const [productTailCacheHydrationTick, setProductTailCacheHydrationTick] = useState(0);

  // Write-through persistence for the durable tail cache. An entry is only
  // stamped with a revision this session actually applied (history response
  // or admitted disk window); the catalog row's revision is the fallback —
  // it was fetched before the window's bytes, so it can only understate the
  // true revision, which admission fails closed on. No revision from either
  // source keeps the previous durable entry untouched.
  const scheduleProductTailCachePersist = useCallback((channelId: string) => {
    if (!productTailCacheStoreRef.current) return;
    const timers = productTailCachePersistTimersRef.current;
    if (timers.has(channelId)) return;
    timers.set(channelId, window.setTimeout(() => {
      timers.delete(channelId);
      const store = productTailCacheStoreRef.current;
      const userId = productTailCacheUserIdRef.current;
      if (!store || !userId) return;
      const channel = channelsRef.current.find((candidate) => candidate.id === channelId);
      const cached = historyCacheRef.current.get(channelId);
      if (!channel || !cached) return;
      const contentRevision = latestChannelContentRevision(channelId) ??
        channelCatalogContentRevision(channel);
      if (contentRevision === undefined) return;
      const entry = buildProductTailCacheEntry({
        userId,
        channelId,
        messages: cached.messages as unknown as ProductTailCacheMessage[],
        hasOlderMessages: cached.hasOlderMessages,
        cachedAt: Date.now(),
        contentRevision,
      });
      if (entry) void store.put(entry);
      else void store.delete(channelId);
    }, PRODUCT_TAIL_CACHE_PERSIST_DEBOUNCE_MS));
  }, [channelsRef, historyCacheRef]);

  const purgeProductTailCacheChannel = useCallback((channelId?: string) => {
    if (channelId === undefined) {
      productTailCacheCandidatesRef.current.clear();
      productTailCacheHydratedStampsRef.current.clear();
      productTailCacheGapRef.current.clear();
      void productTailCacheStoreRef.current?.clear();
    } else {
      productTailCacheCandidatesRef.current.delete(channelId);
      productTailCacheHydratedStampsRef.current.delete(channelId);
      productTailCacheGapRef.current.delete(channelId);
      void productTailCacheStoreRef.current?.delete(channelId);
    }
  }, []);

  // Boot: open the per-user durable store and load candidate bytes. Candidates
  // stay invisible until an authenticated catalog manifest admits them.
  useEffect(() => {
    const previousStore = productTailCacheStoreRef.current;
    const previousUserId = productTailCacheUserIdRef.current;
    const nextUserId = user?.id ?? null;
    if (previousStore && previousUserId && previousUserId !== nextUserId) {
      void previousStore.clearAll().finally(() => previousStore.close());
    } else {
      previousStore?.close();
    }
    productTailCacheStoreRef.current = null;
    productTailCacheCandidatesRef.current = new Map();
    productTailCacheHydratedStampsRef.current = new Map();
    productTailCacheGapRef.current = new Map();
    for (const timer of productTailCachePersistTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    productTailCachePersistTimersRef.current = new Map();
    // A pre-auth snapshot belongs to an unopened, user-partitioned store. Hide
    // it when auth resolves to another user, but retain that account's isolated
    // disk partition so an intentional multi-account switch can reuse it later.
    if (!nextUserId || ProductTailCacheStore.lastCatalogUserId() !== nextUserId) {
      setCachedCatalogChannels([]);
    }
    const userId = user?.id;
    productTailCacheUserIdRef.current = userId ?? null;
    if (!userId || mobileListFixture) return;
    let cancelled = false;
    void (async () => {
      const store = await ProductTailCacheStore.open(browserTailCacheNamespace(userId));
      if (!store) return;
      if (cancelled) {
        store.close();
        return;
      }
      productTailCacheStoreRef.current = store;
      const [entries, cachedCatalog] = await Promise.all([store.readAll(), store.readCatalog()]);
      if (cancelled) return;
      if (channelsRef.current.length > 0) {
        void store.putCatalog(channelsRef.current);
      } else {
        setCachedCatalogChannels(sortChannels(cachedCatalog));
      }
      productTailCacheCandidatesRef.current = new Map(
        entries.map((entry) => [entry.channelId, entry]),
      );
      if (entries.length > 0) setProductTailCacheAdmissionInput((current) => current + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, mobileListFixture, channelsRef]);

  // Admission: every fresh catalog re-judges both directions — loaded
  // candidates may open, and previously admitted channels still made of disk
  // bytes must close (and durably purge) when the catalog's content watermark
  // moves past what the cached window had applied.
  useEffect(() => {
    const store = productTailCacheStoreRef.current;
    const userId = productTailCacheUserIdRef.current;
    if (!store || !userId || channels.length === 0) return;
    for (const [channelId, stamp] of Array.from(productTailCacheHydratedStampsRef.current)) {
      const channel = channels.find((candidate) => candidate.id === channelId);
      const revision = channel ? channelCatalogContentRevision(channel) : undefined;
      if (
        !channel ||
        (revision !== undefined && revision !== stamp.appliedContentRevision)
      ) {
        clearChannelHistory(channelId);
      }
    }
    let hydrated = false;
    for (const [channelId, entry] of Array.from(productTailCacheCandidatesRef.current)) {
      const channel = channels.find((candidate) => candidate.id === channelId);
      if (!channel) {
        productTailCacheCandidatesRef.current.delete(channelId);
        void store.delete(channelId);
        continue;
      }
      const admission = decideProductTailCacheAdmission(
        entry,
        {
          channelId,
          historyHeadSequence: channel.historyHeadSequence,
          contentRevision: channelCatalogContentRevision(channel),
        },
        userId,
      );
      if (admission.decision === "closed") continue;
      productTailCacheCandidatesRef.current.delete(channelId);
      if (admission.decision === "purge") {
        void store.delete(channelId);
        continue;
      }
      if (historyCacheRef.current.has(channelId)) continue;
      const messages = admission.entry.messages as unknown as ChannelMessage[];
      historyCacheRef.current.set(channelId, {
        messages,
        hasOlderMessages: admission.entry.hasOlderMessages,
        cachedAt: admission.entry.cachedAt,
      });
      historyRenderAuthoritiesRef.current.set(channelId, {
        userId,
        channelId,
        historyRevision: historyRevisionRef.current,
      });
      productTailCacheHydratedStampsRef.current.set(channelId, {
        appliedContentRevision: entry.appliedContentRevision,
      });
      // These bytes now ARE the applied revision; later persists inherit it
      // even when the session never fetches this channel's history over HTTP.
      noteChannelContentRevision(channelId, entry.appliedContentRevision);
      // Appends never move the watermark, so an admitted window always
      // revalidates its tail with one afterSequence fetch (empty when fresh).
      productTailCacheGapRef.current.set(channelId, admission.revalidateAfterSequence);
      syncChannelSummaryFromHistory(channelId, messages);
      hydrated = true;
    }
    if (!hydrated) return;
    bumpHistoryCacheRevision();
    const selectedChannelId = selectedChannelIdRef.current;
    if (
      selectedChannelId &&
      historyChannelIdRef.current === selectedChannelId &&
      historyRef.current.length === 0
    ) {
      const cached = historyCacheRef.current.get(selectedChannelId);
      const authority = historyRenderAuthoritiesRef.current.get(selectedChannelId);
      if (cached && cached.messages.length > 0 && authority) {
        historyRef.current = cached.messages;
        hasOlderMessagesRef.current = cached.hasOlderMessages;
        latestHistorySequenceRef.current = latestSequence(cached.messages);
        setHistory(cached.messages);
        setHasOlderMessages(cached.hasOlderMessages);
        setLoadingHistory(false);
        authorizeHistoryRender(authority);
      }
    }
    setProductTailCacheHydrationTick((current) => current + 1);
  }, [
    authorizeHistoryRender,
    bumpHistoryCacheRevision,
    channels,
    clearChannelHistory,
    hasOlderMessagesRef,
    historyCacheRef,
    historyChannelIdRef,
    historyRef,
    historyRenderAuthoritiesRef,
    historyRevisionRef,
    latestHistorySequenceRef,
    productTailCacheAdmissionInput,
    selectedChannelIdRef,
    setHasOlderMessages,
    setHistory,
    setLoadingHistory,
    syncChannelSummaryFromHistory,
  ]);

  return {
    cachedCatalogChannels,
    setCachedCatalogChannels,
    relaySocketGenerationRef,
    historyTailBaseGenerationRef,
    productTailCacheGapRef,
    productTailCacheHydratedStampsRef,
    productTailCacheStoreRef,
    relaySocketLive,
    recordHistoryTailBase,
    historyTailContiguous,
    productTailCacheHydrationTick,
    scheduleProductTailCachePersist,
    purgeProductTailCacheChannel,
  };
}
