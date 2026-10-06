/** How many of a Space's first Channels (about one phone screen) get their latest page read ahead. */
export const HISTORY_WARMUP_CHANNELS = 8;
/** Parallel warm-up reads; the rest queue behind them. */
export const HISTORY_WARMUP_CONCURRENCY = 2;
/** Let the opened Channel and startup reads go first. */
export const HISTORY_WARMUP_DELAY_MS = 600;
/** A Channel whose warm-up was attempted is not read again for this long. */
export const HISTORY_WARMUP_RETRY_MS = 60_000;

type WarmupChannel = {
  id: string;
  spaceId: string;
  historyHeadSequence?: number;
  messageCount?: number;
};

/**
 * The Channels whose latest page is worth reading ahead, in catalog order:
 * among the Space's first `limit` Channels, those that have messages, are not
 * open, and have no cached window yet. Only the top of the list is considered,
 * so the reads stay bounded however long the reader stays. A cached window is
 * left alone even if it is behind — the open path already refreshes it, and
 * replacing it would drop older rows the reader paged in.
 */
export function channelsToWarmHistory(input: {
  channels: readonly WarmupChannel[];
  spaceId: string;
  selectedChannelId: string | null;
  hasCachedHistory: (channelId: string) => boolean;
  lastAttemptAt: (channelId: string) => number | undefined;
  now: number;
  limit?: number;
}): string[] {
  const targets: string[] = [];
  const limit = input.limit ?? HISTORY_WARMUP_CHANNELS;
  let considered = 0;
  for (const channel of input.channels) {
    if (channel.spaceId !== input.spaceId) continue;
    if (considered >= limit) break;
    considered += 1;
    if (channel.id === input.selectedChannelId) continue;
    if ((channel.historyHeadSequence ?? channel.messageCount ?? 0) <= 0) continue;
    if (input.hasCachedHistory(channel.id)) continue;
    const attemptedAt = input.lastAttemptAt(channel.id);
    if (attemptedAt !== undefined && input.now - attemptedAt < HISTORY_WARMUP_RETRY_MS) continue;
    targets.push(channel.id);
  }
  return targets;
}
