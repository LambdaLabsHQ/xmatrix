"use client";

/**
 * The channels this reader can see, for `#` completion in the composer and for
 * drawing `channel:<id>` chips in messages. It is the reader's own channel
 * list: a channel missing from it renders as one they cannot open.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { SerializedChannel } from "@xmatrix/protocol";
import { shareByKey } from "../../lib/same-value";

/** What a reference to a channel shows of it: what `#` completion and chips read. */
export type ChannelReference = Pick<SerializedChannel, "id" | "spaceId" | "name" | "topic" | "summary">;

export type MessageReferenceCatalog = {
  channels: readonly ChannelReference[];
  onOpenChannel: (channelId: string) => void;
};

/**
 * The channels as references, keeping the ones that read the same: a message
 * changes its channel many times a minute and none of what a reference shows.
 * The same list comes back while every reference does.
 */
export function channelReferences(
  previous: readonly ChannelReference[],
  channels: readonly SerializedChannel[],
): readonly ChannelReference[] {
  return shareByKey(previous, channels.map(({ id, spaceId, name, topic, summary }) => ({ id, spaceId, name, topic, summary })),
    (reference) => reference.id);
}

const MessageReferenceCatalogContext = createContext<MessageReferenceCatalog | null>(null);

export function MessageReferenceCatalogProvider({ catalog, children }: {
  catalog: MessageReferenceCatalog | null;
  children: ReactNode;
}) {
  return <MessageReferenceCatalogContext.Provider value={catalog}>{children}</MessageReferenceCatalogContext.Provider>;
}

export function useMessageReferenceCatalog(): MessageReferenceCatalog | null {
  return useContext(MessageReferenceCatalogContext);
}
