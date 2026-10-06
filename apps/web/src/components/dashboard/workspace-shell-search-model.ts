/**
 * Pure search / channel-tree model (no workspace UI view module imports).
 */
import type { SerializedChannel, SerializedSpace } from "@xmatrix/protocol";
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

export function channelQuickOpenScore(
  channel: SerializedChannel,
  space: SerializedSpace | undefined,
  normalizedQuery: string
): number {
  const title = normalizeChannelSearchText(channelTitle(channel));
  const id = normalizeChannelSearchText(channel.id);
  const spaceName = normalizeChannelSearchText(space?.name || "");
  if (title === normalizedQuery) return 0;
  if (title.startsWith(normalizedQuery)) return 1;
  if (title.includes(normalizedQuery)) return 2;
  if (spaceName.includes(normalizedQuery)) return 3;
  if (channelMatchesSearch(channel, normalizedQuery) || id.includes(normalizedQuery)) return 4;
  return -1;
}

/**
 * One list for the dialog. Earlier groups win when the same id appears twice
 * (a page-body hit over its title, a Hub message hit over a cached copy).
 * The list is then ordered so a matching page is not pushed out by messages.
 */
export function mergeWorkspaceSearchResults(
  groups: readonly (readonly WorkspaceSearchResult[])[],
  limit: number
): WorkspaceSearchResult[] {
  const merged: WorkspaceSearchResult[] = [];
  const seen = new Set<string>();
  for (const result of groups.flat()) {
    if (seen.has(result.id)) continue;
    seen.add(result.id);
    merged.push(result);
  }
  merged.sort((left, right) =>
    searchResultRank(left.kind) - searchResultRank(right.kind) || left.id.localeCompare(right.id));
  return merged.slice(0, limit);
}

/** Hard cap for renderer-thread history-cache scans while the search dialog is open. */
export const WORKSPACE_SEARCH_HISTORY_FALLBACK_LIMIT = 2_000;

/**
 * Builds the in-memory message corpus used while the Hub search is missing or
 * has not proven its results. Includes the active authorized timeline when present, plus
 * a capped scan of cached channel tails still in the catalog so mobile
 * channel-list search (no selected channel) is not empty.
 */
export function assembleWorkspaceSearchMessages<T extends { messageId: string }>(input: {
  open: boolean;
  channelIds: readonly string[];
  authorizedHistory: readonly T[];
  historyAuthorized: boolean;
  historyCache: Iterable<readonly [string, { messages: readonly T[] }]>;
  maxMessages?: number;
}): T[] {
  if (!input.open) return [];

  const knownChannelIds = new Set(input.channelIds);
  const byMessageId = new Map<string, T>();
  if (input.historyAuthorized) {
    for (const message of input.authorizedHistory) {
      byMessageId.set(message.messageId, message);
    }
  }

  const maxMessages = input.maxMessages ?? WORKSPACE_SEARCH_HISTORY_FALLBACK_LIMIT;
  for (const [channelId, entry] of input.historyCache) {
    if (byMessageId.size >= maxMessages) break;
    if (knownChannelIds.size > 0 && !knownChannelIds.has(channelId)) continue;
    for (const message of entry.messages) {
      if (byMessageId.size >= maxMessages) break;
      if (!byMessageId.has(message.messageId)) {
        byMessageId.set(message.messageId, message);
      }
    }
  }

  return byMessageId.size === 0 ? [] : Array.from(byMessageId.values());
}
