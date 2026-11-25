import { HUMAN_HEARTBEAT_PING } from "@xmatrix/protocol";
import { createHumanFramePackets, type HumanWorkerEvent } from "./human-frame-packets";
import type { ParsedSocketFrame, SocketTransport } from "./reconnecting-socket";

export type SharedClientRole = "panel" | "inline" | "app";

export type SharedHumanWorkerCommand =
  | { type: "connect"; url: string; userId: string; focusKey?: string | null; clientRole?: SharedClientRole }
  | { type: "send"; data: string }
  | { type: "close"; code?: number; reason?: string }
  | { type: "dispose" }
  | { type: "clear-user"; userId: string }
  | { type: "port-pong" };

export type SharedHumanWorkerEvent = HumanWorkerEvent | { type: "port-ping" };

export interface SharedWorkerPortLike {
  postMessage(message: SharedHumanWorkerEvent): void;
  addEventListener(type: "message", listener: (event: MessageEvent<SharedHumanWorkerCommand>) => void): void;
  start?(): void;
  close?(): void;
}

export interface SharedHumanWorkerScope {
  addEventListener(type: "connect", listener: (event: MessageEvent & { ports?: readonly SharedWorkerPortLike[] }) => void): void;
}

export interface InstallHumanSharedSocketWorkerOptions {
  open?: (url: string) => SocketTransport;
  idleKeepAliveMs?: number;
  portLivenessIntervalMs?: number;
  requestTtlMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
}

const DEFAULT_KEY = "__default__";
const DEFAULT_IDLE_KEEPALIVE_MS = 30_000;
const DEFAULT_PORT_LIVENESS_MS = 15_000;
const DEFAULT_REQUEST_TTL_MS = 60_000;
const BROWSER_READ_DEDUP_TTL_MS = 60_000;
const PONG_COALESCE_MS = 2_000;
const LIVENESS_CLOSE_CODE = 4001;

interface ClientSession {
  id: string;
  userId: string;
  port: SharedWorkerPortLike;
  role: SharedClientRole;
  entry: PoolEntry | null;
  closed: boolean;
  missedPings: number;
  hasReceivedHandshake: boolean;
  lastConnectMessage: Record<string, unknown> | null;
  pendingBeforeAuth: Array<{ parsed: Record<string, unknown>; raw: string }>;
}

interface PendingRequestEntry {
  client: ClientSession;
  originalRequestId: string;
  createdAt: number;
}

interface PoolEntry {
  userId: string;
  url: string;
  focusKey: string;
  socket: SocketTransport;
  clients: Set<ClientSession>;
  idleTimer: unknown;
  authState: "none" | "pending" | "authenticated";
  authRequestId: string | null;
  cachedConnected: Record<string, unknown> | null;
  cachedAgentList: Record<string, unknown> | null;
  awaitingAuth: Map<ClientSession, string | undefined>;
  /** Already-authenticated clients that moved here on focus switch: flush queued sends without re-emitting human_connected. */
  silentAuthWaiters: Set<ClientSession>;
  pendingRequests: Map<string, PendingRequestEntry>;
  pingWaiters: Map<ClientSession, string | undefined>;
  pingInFlight: boolean;
  lastPongAt: number;
  packets: ReturnType<typeof createHumanFramePackets>;
  disposed: boolean;
}

function poolKey(userId: string, url: string, focusKey: string): string {
  return `${userId}\0${url}\0${focusKey}`;
}

function normalizeFocusKey(focusKey: string | null | undefined): string {
  return typeof focusKey === "string" && focusKey.trim() ? focusKey.trim() : DEFAULT_KEY;
}

function parseJsonObject(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function withAuthRequestId(message: Record<string, unknown>, authRequestId: string): string {
  return JSON.stringify({ ...message, requestId: authRequestId });
}

function parseClientPrefix(prefixedId: string): { clientId: string; originalRequestId: string } | null {
  const sep = prefixedId.indexOf(":");
  if (sep <= 1 || prefixedId[0] !== "c") return null;
  const clientId = prefixedId.slice(0, sep);
  if (!/^c\d+$/u.test(clientId)) return null;
  return { clientId, originalRequestId: prefixedId.slice(sep + 1) };
}

function safePost(port: SharedWorkerPortLike, event: SharedHumanWorkerEvent): boolean {
  try {
    port.postMessage(event);
    return true;
  } catch {
    return false;
  }
}

/**
 * SharedWorker hub connection pool for the Chrome extension:
 * - Strictly partitioned by `(userId, url, focusedChannelId)` and cleared
 *   immediately on sign-out (`clear-user`), preventing any cross-account reuse.
 * - Pools one physical `/ws/humans` WebSocket per `(userId, url, focusedChannelId)`
 *   so views showing the same conversation share one authenticated connection.
 * - Keeps idle focused channel connections hot for 30s (`idleKeepAliveMs`) while
 *   promoting or immediately closing empty unfocused default entries so startup
 *   never leaves duplicate sockets behind.
 * - Swallows duplicate `human_connect` frames and replays the cached handshake
 *   with each client's `requestId`, and silently authenticates focus-switched
 *   clients without emitting a second `human_connected`.
 * - Routes request-scoped replies (`requestId`) by client prefix across
 *   multi-frame responses with TTL expiration.
 * - Keeps `HUMAN_CLIENT_BROWSER_READ` on every extension connection (never lost
 *   when one connection closes) and deduplicates `browser_read_requested` by
 *   `requestId` to deliver to at most one client port.
 * - Sends real periodic `HUMAN_HEARTBEAT_PING` frames (coalescing only
 *   concurrent in-flight pings) and notifies evicted ports with a close event
 *   so frozen tabs reconnect cleanly on resume.
 */
export function installHumanSharedSocketWorker(
  scope: SharedHumanWorkerScope,
  options: InstallHumanSharedSocketWorkerOptions = {},
): {
  poolSize(): number;
  dispose(): void;
} {
  const openNative = options.open ?? ((url: string) => new WebSocket(url));
  const idleKeepAliveMs = options.idleKeepAliveMs ?? DEFAULT_IDLE_KEEPALIVE_MS;
  const portLivenessIntervalMs = options.portLivenessIntervalMs ?? DEFAULT_PORT_LIVENESS_MS;
  const requestTtlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const setIntervalFn = options.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn = options.clearIntervalFn ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));

  const pool = new Map<string, PoolEntry>();
  const clientsById = new Map<string, ClientSession>();
  const seenBrowserReadIds = new Map<string, number>();
  let nextClientSeq = 1;
  let nextAuthSeq = 1;

  function clearIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer !== null) {
      clearTimer(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  function destroyPoolEntry(entry: PoolEntry, closeCode?: number, closeReason?: string): void {
    if (entry.disposed) return;
    entry.disposed = true;
    clearIdleTimer(entry);
    entry.packets.dispose();
    const key = poolKey(entry.userId, entry.url, entry.focusKey);
    if (pool.get(key) === entry) pool.delete(key);
    try {
      if (closeCode !== undefined && entry.socket.readyState <= 1) {
        entry.socket.close(closeCode, closeReason);
      }
    } catch {
      // Socket already closed.
    }
  }

  function maybeScheduleIdleClose(entry: PoolEntry): void {
    if (entry.disposed || entry.clients.size > 0) return;
    // Unfocused default entries and unauthenticated/non-open sockets are closed
    // right away; only live focused channel connections stay hot for 30s.
    if (entry.focusKey === DEFAULT_KEY || entry.authState !== "authenticated" || entry.socket.readyState !== 1) {
      destroyPoolEntry(entry, 1000, "idle");
      return;
    }
    clearIdleTimer(entry);
    entry.idleTimer = setTimer(() => {
      entry.idleTimer = null;
      if (entry.clients.size === 0) destroyPoolEntry(entry, 1000, "idle-timeout");
    }, idleKeepAliveMs);
  }

  function deliverPacket(client: ClientSession, frames: readonly ParsedSocketFrame[]): void {
    if (client.closed) return;
    if (!safePost(client.port, { type: "packet", frames: [...frames] })) {
      detachClient(client, false);
    }
  }

  function deliverJsonWithRequestId(
    client: ClientSession,
    value: Record<string, unknown>,
    clientReqId: string | undefined,
  ): void {
    deliverPacket(client, [{
      kind: "json",
      value: clientReqId !== undefined ? { ...value, requestId: clientReqId } : { ...value },
    }]);
  }

  function closeAffectedClients(
    affected: readonly ClientSession[],
    code: number,
    reason: string,
    wasClean: boolean,
  ): void {
    for (const client of affected) {
      client.entry = null;
      if (client.closed) continue;
      client.closed = true;
      clientsById.delete(client.id);
      safePost(client.port, { type: "close", code, reason, wasClean });
    }
  }

  function pickBrowserReadClient(entry: PoolEntry): ClientSession | null {
    // Prefer a side panel port for this account on this entry, then any client
    // on this entry, then any side panel port for this account across the pool.
    for (const client of entry.clients) {
      if (!client.closed && client.userId === entry.userId && client.role === "panel") return client;
    }
    for (const client of entry.clients) {
      if (!client.closed && client.userId === entry.userId) return client;
    }
    for (const client of clientsById.values()) {
      if (!client.closed && client.userId === entry.userId && client.entry && client.role === "panel") return client;
    }
    for (const client of clientsById.values()) {
      if (!client.closed && client.userId === entry.userId && client.entry) return client;
    }
    return null;
  }

  function replayCachedHandshake(entry: PoolEntry, client: ClientSession, requestId: string | undefined): void {
    if (!entry.cachedConnected) return;
    client.hasReceivedHandshake = true;
    const frames: ParsedSocketFrame[] = [
      {
        kind: "json",
        value: {
          ...entry.cachedConnected,
          ...(requestId !== undefined ? { requestId } : {}),
        },
      },
    ];
    if (entry.cachedAgentList) {
      frames.push({
        kind: "json",
        value: {
          ...entry.cachedAgentList,
          ...(requestId !== undefined ? { requestId } : {}),
        },
      });
    }
    deliverPacket(client, frames);
  }

  function flushPendingBeforeAuth(client: ClientSession): void {
    if (client.pendingBeforeAuth.length === 0) return;
    const queued = client.pendingBeforeAuth;
    client.pendingBeforeAuth = [];
    for (const item of queued) {
      handleClientSend(client, item.raw);
    }
  }

  function startAuthIfNeeded(entry: PoolEntry, parsed: Record<string, unknown>): void {
    if (entry.authState !== "none") return;
    entry.authState = "pending";
    const authRequestId = `shared-auth:${nextAuthSeq++}`;
    entry.authRequestId = authRequestId;
    if (entry.socket.readyState === 1) {
      entry.socket.send(withAuthRequestId(parsed, authRequestId));
    }
  }

  function sendConnectOnEntry(
    entry: PoolEntry,
    client: ClientSession,
    parsed: Record<string, unknown>,
    { silent = false } = {},
  ): void {
    const clientRequestId = typeof parsed.requestId === "string" ? parsed.requestId : undefined;
    if (entry.authState === "authenticated" && entry.cachedConnected) {
      if (!silent) replayCachedHandshake(entry, client, clientRequestId);
      flushPendingBeforeAuth(client);
      return;
    }
    if (silent) {
      entry.silentAuthWaiters.add(client);
    } else {
      entry.awaitingAuth.set(client, clientRequestId);
    }
    startAuthIfNeeded(entry, parsed);
  }

  function routeServerFrames(entry: PoolEntry, frames: readonly ParsedSocketFrame[]): void {
    if (entry.disposed) return;
    const broadcastFrames: ParsedSocketFrame[] = [];

    for (const frame of frames) {
      if (frame.kind !== "json" || !frame.value || typeof frame.value !== "object" || Array.isArray(frame.value)) {
        broadcastFrames.push(frame);
        continue;
      }
      const value = frame.value as Record<string, unknown>;
      const type = typeof value.type === "string" ? value.type : "";
      const reqId = typeof value.requestId === "string" ? value.requestId : undefined;

      // 1. Handshake frames (`human_connected`, `agent_list`, or auth `error`)
      if (entry.authRequestId && reqId === entry.authRequestId) {
        if (type === "human_connected") {
          const authUser = value.user as { id?: unknown } | undefined;
          // Defensive check: never cache a handshake whose user differs from this pool partition.
          if (typeof authUser?.id === "string" && authUser.id && authUser.id !== entry.userId) {
            destroyPoolEntry(entry, 4000, "user-mismatch");
            continue;
          }
          entry.cachedConnected = value;
          entry.authState = "authenticated";
          for (const [client, clientReqId] of entry.awaitingAuth) {
            client.hasReceivedHandshake = true;
            deliverJsonWithRequestId(client, value, clientReqId);
            flushPendingBeforeAuth(client);
          }
          for (const silentClient of Array.from(entry.silentAuthWaiters)) {
            entry.silentAuthWaiters.delete(silentClient);
            flushPendingBeforeAuth(silentClient);
          }
          continue;
        }
        if (type === "agent_list") {
          entry.cachedAgentList = value;
          for (const [client, clientReqId] of entry.awaitingAuth) {
            deliverJsonWithRequestId(client, value, clientReqId);
          }
          entry.awaitingAuth.clear();
          continue;
        }
        if (type === "error") {
          const awaiting = Array.from(entry.awaitingAuth.entries());
          const silent = Array.from(entry.silentAuthWaiters);
          entry.awaitingAuth.clear();
          entry.silentAuthWaiters.clear();
          entry.authState = "none";
          entry.authRequestId = null;
          for (const [client, clientReqId] of awaiting) {
            deliverJsonWithRequestId(client, value, clientReqId);
          }
          for (const client of silent) {
            deliverPacket(client, [{ kind: "json", value }]);
          }
          continue;
        }
      }

      // 2. Real Hub heartbeat pong
      if (type === "pong") {
        entry.pingInFlight = false;
        entry.lastPongAt = now();
        const waiters = Array.from(entry.pingWaiters.entries());
        entry.pingWaiters.clear();
        for (const [client, clientReqId] of waiters) {
          deliverJsonWithRequestId(client, value, clientReqId);
        }
        continue;
      }

      // 3. Request-scoped replies: route by client prefix without deleting on
      //    first frame so multi-frame responses for one requestId all reach
      //    only the caller; mappings expire via TTL or on client detach.
      if (reqId) {
        const mapped = entry.pendingRequests.get(reqId);
        if (mapped) {
          if (!mapped.client.closed && mapped.client.entry === entry) {
            deliverPacket(mapped.client, [{
              kind: "json",
              value: { ...value, requestId: mapped.originalRequestId },
            }]);
          }
          continue;
        }
        const parsedPrefix = parseClientPrefix(reqId);
        if (parsedPrefix) {
          const owner = clientsById.get(parsedPrefix.clientId);
          if (owner && !owner.closed && owner.entry === entry) {
            deliverPacket(owner, [{
              kind: "json",
              value: { ...value, requestId: parsedPrefix.originalRequestId },
            }]);
          }
          // Drop late replies for detached clients rather than broadcasting a prefixed id.
          continue;
        }
      }

      // 4. Single-consumer browser read requests deduplicated across all connections by requestId.
      if (type === "browser_read_requested") {
        const readId = typeof value.requestId === "string" ? value.requestId : "";
        if (readId && seenBrowserReadIds.has(readId)) continue;
        if (readId) seenBrowserReadIds.set(readId, now());
        const target = pickBrowserReadClient(entry);
        if (target) deliverPacket(target, [frame]);
        continue;
      }

      // 5. Broadcast all other frames to attached clients on this entry.
      broadcastFrames.push(frame);
    }

    if (broadcastFrames.length > 0) {
      for (const client of Array.from(entry.clients)) {
        deliverPacket(client, broadcastFrames);
      }
    }
  }

  function createPoolEntry(userId: string, url: string, focusKey: string): PoolEntry {
    const socket = openNative(url);
    const entry: PoolEntry = {
      userId,
      url,
      focusKey,
      socket,
      clients: new Set(),
      idleTimer: null,
      authState: "none",
      authRequestId: null,
      cachedConnected: null,
      cachedAgentList: null,
      awaitingAuth: new Map(),
      silentAuthWaiters: new Set(),
      pendingRequests: new Map(),
      pingWaiters: new Map(),
      pingInFlight: false,
      lastPongAt: 0,
      packets: createHumanFramePackets({
        deliver: (frames) => routeServerFrames(entry, frames),
        setTimer,
        clearTimer,
      }),
      disposed: false,
    };
    pool.set(poolKey(userId, url, focusKey), entry);

    socket.addEventListener("open", () => {
      if (entry.disposed) return;
      for (const client of Array.from(entry.clients)) {
        if (client.closed) continue;
        if (!client.hasReceivedHandshake) {
          if (!safePost(client.port, { type: "open" })) {
            detachClient(client, false);
            continue;
          }
        }
        if (client.lastConnectMessage) {
          sendConnectOnEntry(entry, client, client.lastConnectMessage, {
            silent: client.hasReceivedHandshake,
          });
        }
      }
    });

    socket.addEventListener("message", (event) => {
      if (entry.disposed) return;
      entry.packets.push(event.data);
    });

    socket.addEventListener("close", (event) => {
      if (entry.disposed) return;
      entry.packets.flush();
      const affected = Array.from(entry.clients);
      entry.clients.clear();
      destroyPoolEntry(entry);
      closeAffectedClients(affected, event.code, event.reason, event.wasClean);
    });

    socket.addEventListener("error", () => {
      if (entry.disposed) return;
      entry.packets.flush();
      for (const client of Array.from(entry.clients)) {
        if (!client.closed) safePost(client.port, { type: "error" });
      }
    });

    return entry;
  }

  function acquireEntry(userId: string, url: string, focusKey: string): PoolEntry {
    const exact = pool.get(poolKey(userId, url, focusKey));
    if (exact && !exact.disposed && exact.socket.readyState <= 1) {
      clearIdleTimer(exact);
      return exact;
    }
    // Reuse any idle default-key connection for the same user (even while
    // still connecting/authenticating) by promoting it to `focusKey`.
    if (focusKey !== DEFAULT_KEY) {
      const idleDefault = pool.get(poolKey(userId, url, DEFAULT_KEY));
      if (
        idleDefault &&
        !idleDefault.disposed &&
        idleDefault.clients.size === 0 &&
        idleDefault.socket.readyState <= 1
      ) {
        clearIdleTimer(idleDefault);
        pool.delete(poolKey(userId, url, DEFAULT_KEY));
        idleDefault.focusKey = focusKey;
        pool.set(poolKey(userId, url, focusKey), idleDefault);
        return idleDefault;
      }
    }
    return createPoolEntry(userId, url, focusKey);
  }

  function attachClient(client: ClientSession, url: string, focusKey: string, emitOpen: boolean): PoolEntry {
    const entry = acquireEntry(client.userId, url, focusKey);
    clearIdleTimer(entry);
    entry.clients.add(client);
    client.entry = entry;
    if (emitOpen && entry.socket.readyState === 1) {
      safePost(client.port, { type: "open" });
    }
    return entry;
  }

  function detachClientFromEntry(client: ClientSession): void {
    const entry = client.entry;
    if (!entry) return;
    client.entry = null;
    entry.clients.delete(client);
    entry.awaitingAuth.delete(client);
    entry.silentAuthWaiters.delete(client);
    entry.pingWaiters.delete(client);
    for (const [reqId, pending] of Array.from(entry.pendingRequests.entries())) {
      if (pending.client === client) entry.pendingRequests.delete(reqId);
    }
    maybeScheduleIdleClose(entry);
  }

  function detachClient(client: ClientSession, notifyClose: boolean, code = 1000, reason = ""): void {
    if (client.closed) return;
    client.closed = true;
    clientsById.delete(client.id);
    const entry = client.entry;
    detachClientFromEntry(client);
    // An explicit forced replacement (code 4000, e.g. refused token or suspended laptop)
    // drops an unshared or unauthenticated socket so the next dial starts fresh.
    if (entry && !entry.disposed && code === 4000 && (entry.clients.size === 0 || entry.authState !== "authenticated")) {
      destroyPoolEntry(entry, code, reason);
    }
    if (notifyClose) {
      safePost(client.port, { type: "close", code, reason, wasClean: code === 1000 });
    }
  }

  function clearUserConnections(userId: string): void {
    if (!userId) return;
    for (const entry of Array.from(pool.values())) {
      if (entry.userId !== userId) continue;
      const affected = Array.from(entry.clients);
      entry.clients.clear();
      destroyPoolEntry(entry, 1000, "sign-out");
      closeAffectedClients(affected, 1000, "sign-out", true);
    }
  }

  function switchClientFocus(client: ClientSession, nextFocusKey: string): PoolEntry | null {
    const current = client.entry;
    if (!current || current.disposed) return null;
    if (current.focusKey === nextFocusKey) return current;

    const existingTarget = pool.get(poolKey(current.userId, current.url, nextFocusKey));
    if (!existingTarget && current.clients.size === 1) {
      // Sole client on this connection: re-key in place without opening a second WebSocket.
      pool.delete(poolKey(current.userId, current.url, current.focusKey));
      current.focusKey = nextFocusKey;
      pool.set(poolKey(current.userId, current.url, nextFocusKey), current);
      return current;
    }

    // Move client onto the target channel's shared connection. Authenticate
    // silently if this client already received its initial handshake so the App
    // never sees a bogus second `human_connected`.
    const url = current.url;
    detachClientFromEntry(client);
    const nextEntry = attachClient(client, url, nextFocusKey, false);
    if (client.lastConnectMessage && nextEntry.socket.readyState === 1 && nextEntry.authState !== "authenticated") {
      sendConnectOnEntry(nextEntry, client, client.lastConnectMessage, {
        silent: client.hasReceivedHandshake,
      });
    }
    return nextEntry;
  }

  function handleClientSend(client: ClientSession, raw: string): void {
    const entry = client.entry;
    if (!entry || entry.disposed) return;
    const parsed = parseJsonObject(raw);
    if (!parsed) {
      if (entry.socket.readyState === 1) entry.socket.send(raw);
      return;
    }

    // 1. Authentication frame (`human_connect`)
    if (parsed.type === "human_connect") {
      client.lastConnectMessage = parsed;
      sendConnectOnEntry(entry, client, parsed, { silent: false });
      return;
    }

    // 2. Heartbeat ping (`ping`): always send real periodic HUMAN_HEARTBEAT_PING
    //    to Hub, coalescing only concurrent in-flight pings or a very recent pong.
    if (parsed.type === "ping") {
      const reqId = typeof parsed.requestId === "string" ? parsed.requestId : undefined;
      if (entry.socket.readyState !== 1) return;
      if (!entry.pingInFlight && entry.lastPongAt > 0 && now() - entry.lastPongAt < PONG_COALESCE_MS) {
        deliverPacket(client, [{
          kind: "json",
          value: { type: "pong", ...(reqId !== undefined ? { requestId: reqId } : {}) },
        }]);
        return;
      }
      entry.pingWaiters.set(client, reqId);
      if (!entry.pingInFlight) {
        entry.pingInFlight = true;
        entry.socket.send(HUMAN_HEARTBEAT_PING);
      }
      return;
    }

    // 3. Channel focus (`user_focus_channel`): pool/re-key by focused channelId.
    let targetEntry = entry;
    if (parsed.type === "user_focus_channel") {
      const nextFocusKey = normalizeFocusKey(typeof parsed.channelId === "string" ? parsed.channelId : null);
      const switched = switchClientFocus(client, nextFocusKey);
      if (!switched) return;
      targetEntry = switched;
      if (targetEntry.authState !== "authenticated") {
        client.pendingBeforeAuth.push({ parsed, raw });
        return;
      }
    }

    // 4. Request-scoped frames: prefix requestId so all reply frames return only to this client.
    if (targetEntry.socket.readyState !== 1) return;
    if (typeof parsed.requestId === "string" && parsed.requestId.length > 0) {
      const originalRequestId = parsed.requestId;
      const prefixed = `${client.id}:${originalRequestId}`;
      targetEntry.pendingRequests.set(prefixed, {
        client,
        originalRequestId,
        createdAt: now(),
      });
      targetEntry.socket.send(JSON.stringify({ ...parsed, requestId: prefixed }));
      return;
    }
    targetEntry.socket.send(raw);
  }

  // Periodic sweep: evict unresponsive ports (with a close notification so
  // frozen tabs reconnect on resume) and prune expired requestId/browser-read caches.
  const livenessTimer = setIntervalFn(() => {
    const currentNow = now();
    for (const client of Array.from(clientsById.values())) {
      if (client.closed) continue;
      if (client.missedPings >= 2) {
        detachClient(client, true, LIVENESS_CLOSE_CODE, "port-liveness-timeout");
        continue;
      }
      client.missedPings += 1;
      if (!safePost(client.port, { type: "port-ping" })) {
        detachClient(client, false);
      }
    }
    for (const entry of pool.values()) {
      for (const [reqId, pending] of Array.from(entry.pendingRequests.entries())) {
        if (currentNow - pending.createdAt >= requestTtlMs) {
          entry.pendingRequests.delete(reqId);
        }
      }
    }
    for (const [readId, seenAt] of Array.from(seenBrowserReadIds.entries())) {
      if (currentNow - seenAt >= BROWSER_READ_DEDUP_TTL_MS) {
        seenBrowserReadIds.delete(readId);
      }
    }
  }, portLivenessIntervalMs);

  scope.addEventListener("connect", (event) => {
    const port = event.ports?.[0];
    if (!port) return;
    port.start?.();

    let client: ClientSession | null = null;

    port.addEventListener("message", ({ data }) => {
      if (!data || typeof data !== "object") return;
      try {
        switch (data.type) {
          case "port-pong":
            if (client) client.missedPings = 0;
            return;
          case "clear-user":
            if (typeof data.userId === "string" && data.userId) clearUserConnections(data.userId);
            return;
          case "connect": {
            if (client) return;
            const userId = typeof data.userId === "string" ? data.userId.trim() : "";
            if (!userId) {
              safePost(port, { type: "failed" });
              return;
            }
            client = {
              id: `c${nextClientSeq++}`,
              userId,
              port,
              role: data.clientRole ?? "app",
              entry: null,
              closed: false,
              missedPings: 0,
              hasReceivedHandshake: false,
              lastConnectMessage: null,
              pendingBeforeAuth: [],
            };
            clientsById.set(client.id, client);
            attachClient(client, data.url, normalizeFocusKey(data.focusKey), true);
            return;
          }
          case "send":
            if (client && !client.closed) handleClientSend(client, data.data);
            return;
          case "close":
            if (client) detachClient(client, true, data.code, data.reason);
            return;
          case "dispose":
            if (client) detachClient(client, false);
            return;
        }
      } catch {
        if (client) detachClient(client, false);
        safePost(port, { type: "failed" });
      }
    });

    safePost(port, { type: "ready" });
  });

  return {
    poolSize: () => pool.size,
    dispose() {
      clearIntervalFn(livenessTimer);
      for (const entry of Array.from(pool.values())) destroyPoolEntry(entry, 1000, "worker-dispose");
      clientsById.clear();
      seenBrowserReadIds.clear();
    },
  };
}
