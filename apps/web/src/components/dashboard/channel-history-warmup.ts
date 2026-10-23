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
 * open, and hold no current window. Only the top of the list is considered,
 * so the reads stay bounded however long the reader stays.
 *
 * A window is current while it reaches the list's head and the live socket
 * has delivered every message since it was read. One read before the socket
 * last dropped (a phone back from the background), or one the list shows
 * newer messages than, may lack messages and folds; opening it painted those
 * stale rows until the open's own read replaced them, so it is read again
 * here.
 */
export function channelsToWarmHistory(input: {
  channels: readonly WarmupChannel[];
  spaceId: string;
  selectedChannelId: string | null;
  /** A cached window holds the Channel up to `headSequence`, with nothing missed since it was read. */
  hasCurrentHistory: (channelId: string, headSequence: number) => boolean;
  /** When this Channel was last read ahead for this head (a newer head is a new read). */
  lastAttemptAt: (channelId: string, headSequence: number) => number | undefined;
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
    const head = channel.historyHeadSequence ?? channel.messageCount ?? 0;
    if (head <= 0) continue;
    if (input.hasCurrentHistory(channel.id, head)) continue;
    const attemptedAt = input.lastAttemptAt(channel.id, head);
    if (attemptedAt !== undefined && input.now - attemptedAt < HISTORY_WARMUP_RETRY_MS) continue;
    targets.push(channel.id);
  }
  return targets;
}

type WarmupMessage = { messageId: string; sequence?: number };

/** The newest sequence a window holds; 0 for none. */
export function newestSequence(messages: readonly { sequence?: number }[]): number {
  return messages.reduce((max, message) => Math.max(max, message.sequence ?? 0), 0);
}

/**
 * The window a warm-up read leaves: the latest page, plus any held row newer
 * than it — a live message that landed while the read was on its way. Older
 * held rows may sit behind a gap the page does not bridge, so they go.
 */
export function warmedHistoryWindow<T extends WarmupMessage>(page: readonly T[], held: readonly T[]): T[] {
  const newest = newestSequence(page);
  const inPage = new Set(page.map((message) => message.messageId));
  return [...page, ...held.filter((message) => (message.sequence ?? 0) > newest && !inPage.has(message.messageId))];
}
