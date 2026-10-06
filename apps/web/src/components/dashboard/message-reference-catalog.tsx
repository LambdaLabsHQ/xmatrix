"use client";

/**
 * The channels this reader can see, for `#` completion in the composer and for
 * drawing `channel:<id>` chips in messages. It is the reader's own channel
 * list: a channel missing from it renders as one they cannot open.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { SerializedChannel } from "@xmatrix/protocol";

export type MessageReferenceCatalog = {
  channels: readonly SerializedChannel[];
  onOpenChannel: (channelId: string) => void;
};

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
