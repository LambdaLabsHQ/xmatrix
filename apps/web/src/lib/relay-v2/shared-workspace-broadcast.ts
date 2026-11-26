import type { ChannelMessage, ChannelSnapshot } from "@xmatrix/protocol";
import type { ProductTailCacheStoreNamespace } from "./product-tail-cache-store";

/**
 * In-memory-only wire shape for an in-flight outgoing message shared across
 * live same-origin views (never written to disk).
 */
export interface SharedOutgoingMessage {
  clientMessageId: string;
  userId: string;
  channelId: string;
  body: string;
  metadata?: Record<string, unknown>;
  sentAt: string;
  status: "pending" | "failed" | "unconfirmed";
  error?: string;
}

export type SharedWorkspaceBroadcastEvent =
  | { type: "snapshot-request"; senderId: string; requestId: string; channelId: string }
  | {
      type: "snapshot-reply";
      senderId: string;
      targetSenderId: string;
      requestId: string;
      channel: ChannelSnapshot;
      messages: ChannelMessage[];
      hasOlderMessages: boolean;
      contentRevision?: number;
      outgoing: SharedOutgoingMessage[];
    }
  | { type: "channel-upsert"; senderId: string; channel: ChannelSnapshot }
  | { type: "channel-delete"; senderId: string; channelId: string }
  | {
      type: "history-messages";
      senderId: string;
      channelId: string;
      messages: ChannelMessage[];
      hasOlderMessages?: boolean;
      contentRevision?: number;
      clientMessageId?: string;
    }
  | { type: "outgoing-upsert"; senderId: string; message: SharedOutgoingMessage }
  | { type: "outgoing-remove"; senderId: string; channelId: string; clientMessageId: string };

export type SharedWorkspaceBroadcastPayload =
  | Omit<Extract<SharedWorkspaceBroadcastEvent, { type: "snapshot-request" }>, "senderId">
  | Omit<Extract<SharedWorkspaceBroadcastEvent, { type: "snapshot-reply" }>, "senderId">
  | Omit<Extract<SharedWorkspaceBroadcastEvent, { type: "channel-upsert" }>, "senderId">
  | Omit<Extract<SharedWorkspaceBroadcastEvent, { type: "channel-delete" }>, "senderId">
  | Omit<Extract<SharedWorkspaceBroadcastEvent, { type: "history-messages" }>, "senderId">
  | Omit<Extract<SharedWorkspaceBroadcastEvent, { type: "outgoing-upsert" }>, "senderId">
  | Omit<Extract<SharedWorkspaceBroadcastEvent, { type: "outgoing-remove" }>, "senderId">;

export interface SharedWorkspaceBroadcastHandle {
  readonly senderId: string;
  post(payload: SharedWorkspaceBroadcastPayload): void;
  close(): void;
}

function broadcastChannelName(namespace: ProductTailCacheStoreNamespace): string {
  return `xmatrix-workspace-sync:${namespace.hubOrigin}|${namespace.userId}|${namespace.clientProfileId}`;
}

function makeSenderId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `view-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Lightweight same-origin BroadcastChannel bridge between live views of the
 * same authenticated account (extension inline card, side panel, and Web tabs).
 * Supports instant live snapshot request/reply so a newly opened view paints
 * from a running peer's authenticated in-memory state without weakening any
 * disk-cache admission rules. Gracefully degrades to a no-op when
 * BroadcastChannel is unavailable.
 */
export function openSharedWorkspaceBroadcast(
  namespace: ProductTailCacheStoreNamespace,
  onEvent: (event: SharedWorkspaceBroadcastEvent) => void,
  ChannelCtor: typeof BroadcastChannel | undefined = typeof BroadcastChannel !== "undefined" ? BroadcastChannel : undefined,
): SharedWorkspaceBroadcastHandle {
  const senderId = makeSenderId();
  if (!ChannelCtor) {
    return {
      senderId,
      post() {},
      close() {},
    };
  }
  let channel: BroadcastChannel | null = null;
  try {
    channel = new ChannelCtor(broadcastChannelName(namespace));
    channel.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as SharedWorkspaceBroadcastEvent | null;
      if (!data || typeof data !== "object" || typeof data.type !== "string") return;
      if (data.senderId === senderId) return;
      if (data.type === "snapshot-reply" && data.targetSenderId !== senderId) return;
      onEvent(data);
    });
  } catch {
    channel = null;
  }
  return {
    senderId,
    post(payload) {
      if (!channel) return;
      try {
        channel.postMessage({ ...payload, senderId } satisfies SharedWorkspaceBroadcastEvent);
      } catch {
        // Ignore serialization or closed-channel errors; Hub remains authoritative.
      }
    },
    close() {
      if (!channel) return;
      try {
        channel.close();
      } catch {
        // Already closed.
      }
      channel = null;
    },
  };
}
