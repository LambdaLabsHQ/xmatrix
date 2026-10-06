import type { ChannelAttachment } from "@xmatrix/protocol";

/**
 * Resolved attachment media, owned above the virtualized row.
 *
 * The timeline is virtualized, so a row unmounts as soon as it scrolls out of
 * the rendered window. Holding resolved media on the row therefore revoked
 * every object URL and re-ran the entire load — capability recheck included —
 * the next time that row scrolled back in.
 *
 * The store's lifetime is the authorization boundary: one store per channel
 * view, released when the channel, viewer, or session
 * changes. Entries are keyed by `relayV2AttachmentMediaIdentity` (attachment
 * id, version, content hash and size), so a re-versioned attachment can never
 * read a stale entry. It caches bytes already authorized for this view; it
 * does not extend how long any authorization is valid.
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
}

/** Commit a late read only while its authorization-scoped owner is active. */
export function commitMessageAttachmentMedia(
  store: MessageAttachmentMediaStore,
  identity: string,
  attachment: ChannelAttachment,
  objectUrl: string,
): boolean {
  if (!store.active || store.released) {
    URL.revokeObjectURL(objectUrl);
    return false;
  }
  store.objectUrls.add(objectUrl);
  store.resolved.set(identity, attachment);
  return true;
}
