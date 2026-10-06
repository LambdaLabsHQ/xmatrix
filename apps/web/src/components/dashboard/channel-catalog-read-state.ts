"use client";

import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { ChannelCatalogPage, SerializedChannel } from "@xmatrix/protocol";

import { withChannelReadState, type ChannelReadStateUpdate } from "./channel-read-state";

/**
 * The sidebar renders catalog rows, not the shell's `channels` state, so read
 * state that only lands in `channels` leaves the badge lit: the unread count
 * reads the row's own `readSequence` and the mention dot short-circuits on the
 * row's own `attention`. Every path that advances read state writes the Hub's
 * authoritative answer back through here so the badge clears where it is read.
 */
export function applyChannelReadStateToCatalog(input: {
  client: QueryClient;
  /** Catalog key prefix; one Space's `channels(...)` key, or a whole user's. */
  prefix: readonly unknown[];
  readStates: ReadonlyMap<string, ChannelReadStateUpdate>;
}): void {
  if (input.readStates.size === 0) return;
  for (const query of input.client.getQueryCache().findAll({ queryKey: input.prefix })) {
    const queryKey = query.queryKey;
    if (queryKey[3] !== "channels" || queryKey[5] !== "catalog") continue;
    input.client.setQueryData<InfiniteData<ChannelCatalogPage, unknown>>(queryKey, (current) => (
      current
        ? { ...current, pages: current.pages.map((page) => (
            applyToPage(page, input.readStates)
          )) }
        : current
    ));
  }
}

function applyToPage(
  page: ChannelCatalogPage,
  readStates: ReadonlyMap<string, ChannelReadStateUpdate>,
): ChannelCatalogPage {
  if (!page.rows.some((row) => readStates.has(row.channel.id))) return page;
  let unreadCleared = 0;
  let mentionsCleared = 0;
  const rows = page.rows.map((row) => {
    const update = readStates.get(row.channel.id);
    if (!update) return row;
    const channel = readChannel(row.channel, update);
    if (rowIsUnread(row.channel) && !rowIsUnread(channel)) unreadCleared += 1;
    if (rowIsMentioned(row.channel) && !rowIsMentioned(channel)) mentionsCleared += 1;
    return { ...row, channel };
  });
  return {
    ...page,
    rows,
    counts: page.counts ? {
      ...page.counts,
      unread: Math.max(0, page.counts.unread - unreadCleared),
      mentions: Math.max(0, page.counts.mentions - mentionsCleared),
    } : null,
  };
}

function readChannel(
  channel: SerializedChannel,
  update: ChannelReadStateUpdate,
): SerializedChannel {
  // A cached row can be newer than the answer in hand, so the cursor takes the
  // later of the two rather than whichever write landed last.
  return withChannelReadState(channel, {
    attention: update.attention,
    readSequence: update.readSequence === undefined
      ? undefined
      : Math.max(channel.readSequence || 0, update.readSequence),
  });
}

function rowIsUnread(channel: SerializedChannel): boolean {
  const unread = channel.messageCount === undefined
    ? 0
    : Math.max(0, channel.messageCount - (channel.readSequence ?? 0));
  return Math.max(unread, channel.attention?.unreadAttentionCount || 0) > 0;
}

function rowIsMentioned(channel: SerializedChannel): boolean {
  return (channel.attention?.unreadAttentionCount || 0) > 0;
}
