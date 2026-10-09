/**
 * Pure search / channel-tree model (no workspace UI view module imports).
 */
import type { SerializedChannel } from "@xmatrix/protocol";
import { channelTitle } from "@/components/dashboard/channel-links";
import { CHANNEL_READ_COUNTS_STORAGE_PREFIX } from "./workspace-shell-constants";
import { metadataString } from "./workspace-shell-formatters";

export type WorkspaceSearchResult = {
  id: string;
  kind: "channel" | "page" | "member" | "message" | "agent" | "space" | "machine" | "event";
  title: string;
  subtitle: string;
  channelId?: string;
  messageId?: string;
  pageId?: string;
  /** Heading slug to open, when the hit is inside a page section. */
  blockId?: string;
  /** Space member to open. */
  userId?: string;
  spaceId?: string;
};

/** Directory hits stay above messages, so a person is not pushed out by chat. */
export function searchResultRank(kind: WorkspaceSearchResult["kind"]): number {
  if (kind === "channel") return 0;
  if (kind === "page") return 1;
  if (kind === "member") return 2;
  if (kind === "message") return 3;
  if (kind === "agent") return 4;
  if (kind === "space") return 5;
  if (kind === "machine") return 6;
  return 7;
}

export type ChannelTreeNode = {
  subtreeActivityAt?: string;
  channel: SerializedChannel;
  children: ChannelTreeNode[];
};

export function normalizeChannelSearchText(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

export function channelReadCountsStorageKey(userId: string): string {
  return `${CHANNEL_READ_COUNTS_STORAGE_PREFIX}${userId}`;
}

export function channelMatchesSearch(
  channel: SerializedChannel,
  normalizedQuery: string
): boolean {
  // Include last-message preview text: on mobile that is the second line of
  // each channel row, and users naturally search for what they can see there.
  const searchable = [
    channelTitle(channel),
    channel.id,
    channel.topic,
    channel.summary,
    channel.lastMessage?.bodyPreview,
    channel.lastMessage?.from?.label,
    metadataString(channel.metadata, "threadRootAuthor"),
    metadataString(channel.metadata, "threadRootPreview"),
  ]
    .filter(Boolean)
    .join(" ");

  return normalizeChannelSearchText(searchable).includes(normalizedQuery);
}
