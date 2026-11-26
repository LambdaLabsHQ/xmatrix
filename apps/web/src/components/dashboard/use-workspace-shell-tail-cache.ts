import type { SocketTransport } from "@/lib/connectivity/reconnecting-socket";
// Product tail cache engine for the workspace shell (peeled by semantic
// domain from use-workspace-shell-state.ts). Owns the durable bounded-tail
// candidate store, the strict catalog-manifest admission gate, leading-edge
// throttled write-through persistence, live same-origin BroadcastChannel
// request/reply + delta sync across running views, and socket-generation
// tail-contiguity tracking.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildProductTailCacheEntry,
  decideProductTailCacheAdmission,
  type ProductTailCacheEntry,
  type ProductTailCacheMessage,
} from "@/lib/relay-v2/product-tail-cache";
import { ProductTailCacheStore } from "@/lib/relay-v2/product-tail-cache-store";
import {
  openSharedWorkspaceBroadcast,
  type SharedOutgoingMessage,
  type SharedWorkspaceBroadcastEvent,
  type SharedWorkspaceBroadcastHandle,
} from "@/lib/relay-v2/shared-workspace-broadcast";
import {
  channelCatalogContentRevision,
  latestChannelContentRevision,
  noteChannelContentRevision,
} from "@/lib/relay-v2/channel-content-revision";
import { APP_CONNECTORS } from "@/lib/app-connectors";
import { parseAppMentions } from "./mention-complete";
import { replaceChannel } from "./workspace-admin-views";
import {
  browserTailCacheNamespace,
  latestSequence,
  sortChannels,
  PRODUCT_TAIL_CACHE_PERSIST_DEBOUNCE_MS,
  type ChannelHistoryCacheEntry,
  type HistoryRenderAuthority,
  type OutgoingMessage,
} from "./workspace-shell-modules";
import type { ChannelMessage, ChannelSnapshot } from "@xmatrix/protocol";

function sharedToOutgoing(row: SharedOutgoingMessage): OutgoingMessage {
  return {
    clientMessageId: row.clientMessageId,
    channelId: row.channelId,
    body: row.body,
    attachments: [],
    appMentions: parseAppMentions(row.body, APP_CONNECTORS),
    ...(row.metadata ? { metadata: row.metadata } : {}),
    sentAt: row.sentAt,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
  };
}

function outgoingToShared(userId: string, outgoing: OutgoingMessage): SharedOutgoingMessage {
  return {
    clientMessageId: outgoing.clientMessageId,
    userId,
    channelId: outgoing.channelId,
    body: outgoing.body,
    ...(outgoing.metadata ? { metadata: outgoing.metadata } : {}),
    sentAt: outgoing.sentAt,
    status: outgoing.status,
    ...(outgoing.error ? { error: outgoing.error } : {}),
  };
}

function snapshotChannelForBroadcast(channel: ChannelSnapshot): ChannelSnapshot {
  // Strip non-clonable runtime fields if any; keep the full snapshot fields.
  const copy = { ...channel };
  copy.presence = undefined;
  return copy;
}

export function useWorkspaceShellTailCache(deps: {
  user: { id: string } | null;
  mobileListFixture: unknown;
  channels: ChannelSnapshot[];
  channelsRef: React.MutableRefObject<ChannelSnapshot[]>;
  hasAuthoritativeCatalog: boolean;
  setChannels: (updater: ChannelSnapshot[] | ((current: ChannelSnapshot[]) => ChannelSnapshot[])) => void;
  outgoingMessagesRef: React.MutableRefObject<OutgoingMessage[]>;
  setOutgoingMessages: React.Dispatch<React.SetStateAction<OutgoingMessage[]>>;
  historyCacheRef: React.MutableRefObject<Map<string, ChannelHistoryCacheEntry>>;
  historyRenderAuthoritiesRef: React.MutableRefObject<Map<string, HistoryRenderAuthority>>;
  historyRevisionRef: React.MutableRefObject<number>;
  selectedChannelIdRef: React.MutableRefObject<string | null>;
  historyChannelIdRef: React.MutableRefObject<string | null>;
  historyRef: React.MutableRefObject<ChannelMessage[]>;
  hasOlderMessagesRef: React.MutableRefObject<boolean>;
  latestHistorySequenceRef: React.MutableRefObject<number>;
  relayPushConnectedRef: React.MutableRefObject<boolean>;
  relaySocketRef: React.MutableRefObject<SocketTransport | null>;
  setHistory: (messages: ChannelMessage[]) => void;
  setHasOlderMessages: (value: boolean) => void;
  setLoadingHistory: (value: boolean) => void;
  authorizeHistoryRender: (authority: HistoryRenderAuthority) => void;
  bumpHistoryCacheRevision: () => void;
  clearChannelHistory: (channelId?: string) => void;
  syncChannelSummaryFromHistory: (channelId: string, messages: ChannelMessage[]) => void;
  onRemoteHistoryMessages?: (
    channelId: string,
    messages: ChannelMessage[],
    hasOlderMessages: boolean,
    clientMessageId?: string,
  ) => void;
  onRemoteChannelDeleted?: (channelId: string) => void;
}) {
  const {
    user,
    mobileListFixture,
    channels,
    channelsRef,
    hasAuthoritativeCatalog,
    setChannels,
    outgoingMessagesRef,
    setOutgoingMessages,
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
    onRemoteHistoryMessages,
    onRemoteChannelDeleted,
  } = deps;

  const onRemoteHistoryMessagesRef = useRef(onRemoteHistoryMessages);
  onRemoteHistoryMessagesRef.current = onRemoteHistoryMessages;
  const onRemoteChannelDeletedRef = useRef(onRemoteChannelDeleted);
  onRemoteChannelDeletedRef.current = onRemoteChannelDeleted;
  const hasAuthoritativeCatalogRef = useRef(hasAuthoritativeCatalog);
  hasAuthoritativeCatalogRef.current = hasAuthoritativeCatalog;

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
  const productTailCacheLastPersistAtRef = useRef<Map<string, number>>(new Map());
  const broadcastRef = useRef<SharedWorkspaceBroadcastHandle | null>(null);
  // Presentation-only cold-start catalog (disk rows shown before auth resolves).
  const [cachedCatalogChannels, setCachedCatalogChannels] = useState<ChannelSnapshot[]>([]);

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

  /* A read taken outside the open path: its window is contiguous only if
     the socket was up when it started and has not dropped since. */
  const beginHistoryTailRead = useCallback(() => {
    const generation = relaySocketLive() ? relaySocketGenerationRef.current : -1;
    return (channelId: string): void => {
      historyTailBaseGenerationRef.current.set(
        channelId,
        generation === relaySocketGenerationRef.current ? generation : -1,
      );
    };
  }, [relaySocketLive]);

  const historyTailContiguous = useCallback((channelId: string): boolean => (
    relaySocketLive() &&
    historyTailBaseGenerationRef.current.get(channelId) === relaySocketGenerationRef.current
  ), [relaySocketLive]);

  const [productTailCacheAdmissionInput, setProductTailCacheAdmissionInput] = useState(0);
  const [productTailCacheHydrationTick, setProductTailCacheHydrationTick] = useState(0);

  const flushProductTailCacheChannel = useCallback((channelId: string) => {
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
    productTailCacheLastPersistAtRef.current.set(channelId, Date.now());
    if (entry) void store.put(entry);
    else void store.delete(channelId);
  }, [channelsRef, historyCacheRef]);

  // Write-through persistence for the durable tail cache: leading-edge
  // immediate once a real Hub contentRevision is known, then throttled at
  // PRODUCT_TAIL_CACHE_PERSIST_DEBOUNCE_MS so busy 100-event/sec channels
  // never rewrite disk per message.
  const scheduleProductTailCachePersist = useCallback((channelId: string) => {
    if (!productTailCacheStoreRef.current) return;
    const timers = productTailCachePersistTimersRef.current;
    const now = Date.now();
    const last = productTailCacheLastPersistAtRef.current.get(channelId) ?? 0;
    const elapsed = now - last;
    if (elapsed >= PRODUCT_TAIL_CACHE_PERSIST_DEBOUNCE_MS && !timers.has(channelId)) {
      flushProductTailCacheChannel(channelId);
      return;
    }
    if (timers.has(channelId)) return;
    const waitMs = Math.max(0, PRODUCT_TAIL_CACHE_PERSIST_DEBOUNCE_MS - elapsed);
    timers.set(channelId, window.setTimeout(() => {
      timers.delete(channelId);
      flushProductTailCacheChannel(channelId);
    }, waitMs));
  }, [flushProductTailCacheChannel]);

  const requestLiveChannelSnapshot = useCallback((channelId: string) => {
    if (!channelId || !broadcastRef.current) return;
    const requestId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    broadcastRef.current.post({ type: "snapshot-request", requestId, channelId });
  }, []);

  const broadcastChannelUpsert = useCallback((channel: ChannelSnapshot) => {
    broadcastRef.current?.post({
      type: "channel-upsert",
      channel: snapshotChannelForBroadcast(channel),
    });
  }, []);

  const broadcastChannelDelete = useCallback((channelId: string) => {
    broadcastRef.current?.post({ type: "channel-delete", channelId });
  }, []);

  const broadcastOutgoingUpsert = useCallback((outgoing: OutgoingMessage) => {
    const userId = productTailCacheUserIdRef.current;
    if (!userId) return;
    broadcastRef.current?.post({
      type: "outgoing-upsert",
      message: outgoingToShared(userId, outgoing),
    });
  }, []);

  const broadcastOutgoingRemove = useCallback((channelId: string, clientMessageId: string) => {
    broadcastRef.current?.post({ type: "outgoing-remove", channelId, clientMessageId });
  }, []);

  const broadcastHistoryMessages = useCallback((
    channelId: string,
    messages: ChannelMessage[],
    hasOlderMessages?: boolean,
    clientMessageId?: string,
  ) => {
    if (messages.length === 0) return;
    const channel = channelsRef.current.find((candidate) => candidate.id === channelId);
    const contentRevision = latestChannelContentRevision(channelId) ??
      (channel ? channelCatalogContentRevision(channel) : undefined);
    broadcastRef.current?.post({
      type: "history-messages",
      channelId,
      messages,
      ...(hasOlderMessages !== undefined ? { hasOlderMessages } : {}),
      ...(contentRevision !== undefined ? { contentRevision } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  }, [channelsRef]);

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

  // Boot: open the per-user durable store (strictly gated behind authenticated
  // catalog admission) AND open the same-origin BroadcastChannel so running
  // views share live Hub-authenticated state immediately without touching disk rules.
  useEffect(() => {
    const previousStore = productTailCacheStoreRef.current;
    const previousUserId = productTailCacheUserIdRef.current;
    const nextUserId = user?.id ?? null;
    if (previousStore && previousUserId && previousUserId !== nextUserId) {
      void previousStore.clearAll().finally(() => previousStore.close());
    } else {
      previousStore?.close();
    }
    broadcastRef.current?.close();
    broadcastRef.current = null;
    productTailCacheStoreRef.current = null;
    productTailCacheCandidatesRef.current = new Map();
    productTailCacheHydratedStampsRef.current = new Map();
    productTailCacheGapRef.current = new Map();
    productTailCacheLastPersistAtRef.current = new Map();
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

    const namespace = browserTailCacheNamespace(userId);
    const handleBroadcastEvent = (event: SharedWorkspaceBroadcastEvent) => {
      if (event.type === "snapshot-request") {
        const channel = channelsRef.current.find((candidate) => candidate.id === event.channelId);
        if (!channel) return;
        const selectedHere = selectedChannelIdRef.current === event.channelId &&
          historyChannelIdRef.current === event.channelId;
        const cached = historyCacheRef.current.get(event.channelId);
        const messages = selectedHere && historyRef.current.length > 0
          ? historyRef.current
          : (cached?.messages ?? []);
        const hasOlderMessages = selectedHere
          ? hasOlderMessagesRef.current
          : (cached?.hasOlderMessages ?? false);
        const outgoing = outgoingMessagesRef.current
          .filter((item) => item.channelId === event.channelId)
          .map((item) => outgoingToShared(userId, item));
        const contentRevision = latestChannelContentRevision(event.channelId) ??
          channelCatalogContentRevision(channel);
        broadcastRef.current?.post({
          type: "snapshot-reply",
          targetSenderId: event.senderId,
          requestId: event.requestId,
          channel: snapshotChannelForBroadcast(channel),
          messages,
          hasOlderMessages,
          ...(contentRevision !== undefined ? { contentRevision } : {}),
          outgoing,
        });
      } else if (event.type === "snapshot-reply") {
        setChannels((current) => replaceChannel(current, event.channel));
        if (event.contentRevision !== undefined) {
          noteChannelContentRevision(event.channel.id, event.contentRevision);
        }
        if (event.messages.length > 0) {
          onRemoteHistoryMessagesRef.current?.(
            event.channel.id,
            event.messages,
            event.hasOlderMessages,
          );
        }
        if (event.outgoing.length > 0) {
          const confirmedIds = new Set(
            (historyCacheRef.current.get(event.channel.id)?.messages ?? []).map((m) => m.messageId),
          );
          const additions = event.outgoing
            .filter((row) => row.userId === userId && !confirmedIds.has(row.clientMessageId))
            .map(sharedToOutgoing);
          if (additions.length > 0) {
            setOutgoingMessages((current) => {
              const byId = new Map(current.map((item) => [item.clientMessageId, item]));
              for (const item of additions) {
                if (!byId.has(item.clientMessageId)) byId.set(item.clientMessageId, item);
              }
              return [...byId.values()];
            });
          }
        }
      } else if (event.type === "channel-upsert") {
        setChannels((current) => replaceChannel(current, event.channel));
      } else if (event.type === "channel-delete") {
        onRemoteChannelDeletedRef.current?.(event.channelId);
      } else if (event.type === "history-messages") {
        if (event.contentRevision !== undefined) {
          noteChannelContentRevision(event.channelId, event.contentRevision);
        }
        onRemoteHistoryMessagesRef.current?.(
          event.channelId,
          event.messages,
          Boolean(event.hasOlderMessages),
          event.clientMessageId,
        );
      } else if (event.type === "outgoing-upsert") {
        if (event.message.userId !== userId) return;
        const confirmed = historyCacheRef.current.get(event.message.channelId)?.messages.some(
          (entry) => entry.messageId === event.message.clientMessageId,
        );
        if (confirmed) return;
        const nextOutgoing = sharedToOutgoing(event.message);
        setOutgoingMessages((current) => {
          const exists = current.some((item) => item.clientMessageId === nextOutgoing.clientMessageId);
          return exists
            ? current.map((item) => (item.clientMessageId === nextOutgoing.clientMessageId ? nextOutgoing : item))
            : [...current, nextOutgoing];
        });
      } else if (event.type === "outgoing-remove") {
        setOutgoingMessages((current) =>
          current.filter((item) => item.clientMessageId !== event.clientMessageId)
        );
      }
    };
    broadcastRef.current = openSharedWorkspaceBroadcast(namespace, handleBroadcastEvent);

    let cancelled = false;
    void (async () => {
      const store = await ProductTailCacheStore.open(namespace);
      if (!store) return;
      if (cancelled) {
        store.close();
        return;
      }
      productTailCacheStoreRef.current = store;
      const [entries, cachedCatalog] = await Promise.all([store.readAll(), store.readCatalog()]);
      if (cancelled) return;
      if (channelsRef.current.length > 0 && hasAuthoritativeCatalogRef.current) {
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
      broadcastRef.current?.close();
      broadcastRef.current = null;
    };
  }, [
    user?.id,
    mobileListFixture,
    channelsRef,
    hasOlderMessagesRef,
    historyCacheRef,
    historyChannelIdRef,
    historyRef,
    outgoingMessagesRef,
    selectedChannelIdRef,
    setChannels,
    setOutgoingMessages,
  ]);

  // Keep the pre-auth list current once the Hub catalog has arrived: the next
  // cold start paints the rows this account last saw while its session is still
  // being confirmed. Never overwrite the disk catalog with a single live-synced row.
  useEffect(() => {
    if (channels.length === 0 || !hasAuthoritativeCatalog) return;
    const timer = window.setTimeout(() => {
      void productTailCacheStoreRef.current?.putCatalog(channels);
    }, PRODUCT_TAIL_CACHE_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [channels, hasAuthoritativeCatalog]);

  // Admission: every fresh Hub catalog re-judges both directions — loaded
  // candidates may open, and previously admitted channels still made of disk
  // bytes must close (and durably purge) when the catalog's content watermark
  // moves past what the cached window had applied.
  useEffect(() => {
    const store = productTailCacheStoreRef.current;
    const userId = productTailCacheUserIdRef.current;
    if (!store || !userId || channels.length === 0 || !hasAuthoritativeCatalog) return;
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
    hasAuthoritativeCatalog,
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
    beginHistoryTailRead,
    historyTailContiguous,
    productTailCacheHydrationTick,
    scheduleProductTailCachePersist,
    requestLiveChannelSnapshot,
    broadcastChannelUpsert,
    broadcastChannelDelete,
    broadcastOutgoingUpsert,
    broadcastOutgoingRemove,
    broadcastHistoryMessages,
    purgeProductTailCacheChannel,
  };
}
