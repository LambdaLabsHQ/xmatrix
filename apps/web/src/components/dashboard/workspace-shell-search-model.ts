/**
 * Pure search / channel-tree model (no workspace UI view module imports).
 */
import type { ChannelSnapshot } from "@xmatrix/protocol";
import { channelTitle } from "@/components/dashboard/channel-links";
import { CHANNEL_READ_COUNTS_STORAGE_PREFIX } from "./workspace-shell-constants";
import { metadataString } from "./workspace-shell-formatters";
import type { SearchRank } from "./workspace-search-rank";

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
  /** Where it sorts among everything found (`workspace-search-rank.ts`). */
  rank: SearchRank;
};

export type ChannelTreeNode = {
  subtreeActivityAt?: string;
  channel: ChannelSnapshot;
  children: ChannelTreeNode[];
};

export function normalizeChannelSearchText(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

export function channelReadCountsStorageKey(userId: string): string {
  return `${CHANNEL_READ_COUNTS_STORAGE_PREFIX}${userId}`;
}

export function channelMatchesSearch(
  channel: ChannelSnapshot,
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
