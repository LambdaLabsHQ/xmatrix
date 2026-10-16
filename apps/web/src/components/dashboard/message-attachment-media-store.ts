import type { ChannelAttachment } from "@xmatrix/protocol";

/**
 * Resolved attachment media, owned above the virtualized row.
 *
 * The timeline is virtualized, so a row unmounts as soon as it scrolls out of
 * the rendered window. Holding resolved media on the row therefore revoked
 * every object URL and re-ran the entire load — capability recheck included —
 * the next time that row scrolled back in.
 *
 * One store per channel and viewer. Leaving a channel keeps its store among
 * the few most recent ones, so opening it again shows its media at once
 * instead of reading every attachment back and showing a skeleton for each.
 * The bytes are already in this browser's media Cache Storage for the same
 * viewer, so a recent store holds nothing that cache does not; it is released
 * when it falls out of the recent set, when the viewer changes, or on sign
 * out. Entries are keyed by `relayV2AttachmentMediaIdentity` (attachment id,
 * version, content hash and size), so a re-versioned attachment can never
 * read a stale entry.
 */
export interface MessageAttachmentMediaScope {
  channelId: string | null;
  viewerId: string;
  authenticated: boolean;
}

export interface MessageAttachmentMediaStore {
  /**
   * What this store's media was authorized for. Held so the boundary is a
   * property of the store rather than a convention its callers must remember.
   */
  scope: Readonly<MessageAttachmentMediaScope>;
  /**
   * A scope transition deactivates a store before React paints the next view.
   * In-flight reads may finish, but must not commit their bytes or object URL.
   */
  active: boolean;
  /** Final release has revoked every object URL and cleared all references. */
  released: boolean;
  resolved: Map<string, ChannelAttachment>;
  loads: Map<string, Promise<ChannelAttachment>>;
  objectUrls: Set<string>;
  /** Why media could not be loaded, by attachment identity. */
  failures: Map<string, string>;
  /** Loaded images, held so a remounted row paints them without reloading. */
  images: HTMLImageElement[];
  /** Bytes of the media this store holds, for the recent-store budget. */
  bytes: number;
  /** Mounted views using this store; only an unused store can be evicted. */
  users: number;
}

/* Recent stores, least recently used first. A few channels' worth of media
   covers switching back and forth; the byte budget bounds a channel full of
   large screenshots. */
const RECENT_STORES = 8;
const RECENT_STORE_BYTES = 192 * 1024 * 1024;
const recentStores = new Map<string, MessageAttachmentMediaStore>();
let currentViewer: string | undefined;

function viewerKey(scope: MessageAttachmentMediaScope): string {
  return `${scope.authenticated ? "user" : "anonymous"}:${scope.viewerId}`;
}

/**
 * The store for a channel view: the recent one when this viewer had the
 * channel open lately, else a new one. A different viewer releases every
 * store the previous one left behind.
 */
export function messageAttachmentMediaStoreFor(
  scope: MessageAttachmentMediaScope,
): MessageAttachmentMediaStore {
  const viewer = viewerKey(scope);
  if (viewer !== currentViewer) {
    currentViewer = viewer;
    trimMessageAttachmentMediaStores();
  }
  const key = `${viewer}\n${scope.channelId ?? ""}`;
  const recent = recentStores.get(key);
  if (recent && !recent.released) return recent;
  const store = createMessageAttachmentMediaStore(scope);
  recentStores.set(key, store);
  return store;
}

/** A mounted view starts using its store and marks it most recent. */
export function holdMessageAttachmentMediaStore(store: MessageAttachmentMediaStore): void {
  store.users += 1;
  activateMessageAttachmentMediaStore(store);
  const key = [...recentStores].find(([, recent]) => recent === store)?.[0];
  if (key === undefined) return;
  recentStores.delete(key);
  recentStores.set(key, store);
}

/** A view stops using its store; it stays recent until trimmed. */
export function letGoMessageAttachmentMediaStore(store: MessageAttachmentMediaStore): void {
  store.users = Math.max(0, store.users - 1);
  trimMessageAttachmentMediaStores();
}

/** Sign out: nothing this browser held for the old session survives it. */
export function releaseMessageAttachmentMediaStores(): void {
  currentViewer = undefined;
  for (const store of recentStores.values()) releaseMessageAttachmentMediaStore(store);
  recentStores.clear();
}

function trimMessageAttachmentMediaStores(): void {
  let count = 0;
  let bytes = 0;
  for (const store of recentStores.values()) {
    count += 1;
    bytes += store.bytes;
  }
  for (const [key, store] of recentStores) {
    const otherViewer = viewerKey(store.scope) !== currentViewer;
    if (store.users > 0 || (!otherViewer && count <= RECENT_STORES && bytes <= RECENT_STORE_BYTES)) continue;
    recentStores.delete(key);
    count -= 1;
    bytes -= store.bytes;
    releaseMessageAttachmentMediaStore(store);
  }
}

export function createMessageAttachmentMediaStore(
  scope: MessageAttachmentMediaScope,
): MessageAttachmentMediaStore {
  return {
    scope: { ...scope },
    active: true,
    released: false,
    resolved: new Map(),
    loads: new Map(),
    objectUrls: new Set(),
    failures: new Map(),
    images: [],
    bytes: 0,
    users: 0,
  };
}

/** Re-enable a store after React's development-only effect probe. */
export function activateMessageAttachmentMediaStore(
  store: MessageAttachmentMediaStore,
): void {
  if (!store.released) store.active = true;
}

/** Stop in-flight reads from committing to a view that has changed authority. */
export function deactivateMessageAttachmentMediaStore(
  store: MessageAttachmentMediaStore,
): void {
  store.active = false;
}

/**
 * Revoke every object URL the store handed out and drop its entries. Callers
 * release the store when the view it belongs to goes away — releasing it any
 * later would keep media alive past the authorization that produced it.
 */
export function releaseMessageAttachmentMediaStore(
  store: MessageAttachmentMediaStore,
): void {
  if (store.released) return;
  deactivateMessageAttachmentMediaStore(store);
  store.released = true;
  for (const objectUrl of store.objectUrls) URL.revokeObjectURL(objectUrl);
  store.objectUrls.clear();
  store.resolved.clear();
  store.loads.clear();
  store.failures.clear();
  store.images = [];
  store.bytes = 0;
}

/** Commit a late read only while its authorization-scoped owner is active. */
export function commitMessageAttachmentMedia(
  store: MessageAttachmentMediaStore,
  identity: string,
  attachment: ChannelAttachment,
  objectUrl: string,
  bytes = 0,
): boolean {
  if (!store.active || store.released) {
    URL.revokeObjectURL(objectUrl);
    return false;
  }
  store.objectUrls.add(objectUrl);
  store.resolved.set(identity, attachment);
  store.bytes += bytes;
  if (attachment.kind === "image" && typeof Image === "function") {
    const image = new Image();
    image.src = objectUrl;
    store.images.push(image);
  }
  return true;
}
