// Coalesces viewport read acknowledgements so one rendered range cannot turn
// into one mutation per row. Kept free of React/DOM imports for direct tests.

export const CHANNEL_READ_SYNC_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000] as const;

export type ChannelReadSyncResult = {
  readSequence?: number;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type ChannelReadSyncEntry = {
  acknowledgedSequence: number;
  desiredSequence: number;
  attentionSequence: number;
  attemptedAttentionSequence: number;
  /** How far this device has read the Channel since the last reset. */
  readHere: number;
  inFlight: boolean;
  failureCount: number;
  timer?: TimerHandle;
};

export interface ChannelReadSyncCoordinatorOptions<T extends ChannelReadSyncResult> {
  send: (channelId: string, sequence: number) => Promise<T | undefined>;
  onSuccess?: (channelId: string, result: T) => void;
  /** Whose reads these are now. A read asked for one reader and answered when
   * another is here is nobody's, even before the reset that follows. */
  reader?: () => string | undefined;
  retryDelaysMs?: readonly number[];
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
}

/**
 * Maintains at most one read mutation per Channel, always sending the latest
 * exposed sequence. A failed request stays on one bounded backoff timer even
 * if a virtualized timeline reports the same rendered range repeatedly.
 */
export class ChannelReadSyncCoordinator<T extends ChannelReadSyncResult> {
  private readonly entries = new Map<string, ChannelReadSyncEntry>();
  private readonly retryDelaysMs: readonly number[];
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancelTimer: (handle: TimerHandle) => void;
  private generation = 0;

  constructor(private readonly options: ChannelReadSyncCoordinatorOptions<T>) {
    this.retryDelaysMs = options.retryDelaysMs ?? CHANNEL_READ_SYNC_RETRY_DELAYS_MS;
    this.scheduleTimer = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimer = options.cancel ?? ((handle) => clearTimeout(handle));
  }

  observe(channelId: string, readSequence: number | undefined): void {
    if (!validSequence(readSequence)) return;
    const entry = this.entry(channelId);
    entry.acknowledgedSequence = Math.max(entry.acknowledgedSequence, readSequence);
    if (!entry.inFlight && !this.needsSync(entry)) this.clearTimer(entry);
  }

  enqueue(channelId: string, sequence: number, options: { attentionUnread: boolean }): void {
    if (!channelId || !validSequence(sequence) || sequence <= 0) return;
    const entry = this.entry(channelId);
    entry.desiredSequence = Math.max(entry.desiredSequence, sequence);
    if (options.attentionUnread) {
      entry.attentionSequence = Math.max(entry.attentionSequence, sequence);
    }
    this.schedule(channelId, entry, 0);
  }

  /** A read made on this device: no Hub answer takes its count below it (readCountsFromHub). */
  noteRead(channelId: string, sequence: number): void {
    if (!channelId || !validSequence(sequence)) return;
    const entry = this.entry(channelId);
    entry.readHere = Math.max(entry.readHere, sequence);
  }

  /** How far this device has read the Channel since the last reset. */
  readHere(channelId: string): number {
    return this.entries.get(channelId)?.readHere ?? 0;
  }

  /**
   * The reader is done with the Channel, read to `sequence`: `send` asks the
   * Hub, and `commit` writes its answer. The answer belongs to the session
   * and reader that asked: a reset or another reader while it is on its way
   * (signed out, another account, even the same one back) and it is written
   * nowhere. `commit` runs in the same step as that check, so nothing queued
   * behind the answer can come between them. Only an answer the Hub gave
   * counts as a read made here.
   */
  async respond<A>(channelId: string, sequence: number, send: () => Promise<A | undefined>,
    commit: (answer: A | undefined) => void): Promise<void> {
    const asked = this.asked();
    const answer = await send();
    if (!this.stillAsked(asked)) return;
    if (answer) this.noteRead(channelId, sequence);
    commit(answer);
  }

  /** The session and reader a read is asked for. */
  private asked() {
    return { generation: this.generation, reader: this.options.reader?.() };
  }

  /** Whether the session and reader a read was asked for are still the ones here. */
  private stillAsked(asked: { generation: number; reader: string | undefined }): boolean {
    return asked.generation === this.generation && asked.reader === this.options.reader?.();
  }

  reset(): void {
    this.generation += 1;
    for (const entry of this.entries.values()) this.clearTimer(entry);
    this.entries.clear();
  }

  private entry(channelId: string): ChannelReadSyncEntry {
    const existing = this.entries.get(channelId);
    if (existing) return existing;
    const created: ChannelReadSyncEntry = {
      acknowledgedSequence: 0,
      desiredSequence: 0,
      attentionSequence: 0,
      attemptedAttentionSequence: 0,
      readHere: 0,
      inFlight: false,
      failureCount: 0,
    };
    this.entries.set(channelId, created);
    return created;
  }

  private needsSync(entry: ChannelReadSyncEntry): boolean {
    return entry.desiredSequence > entry.acknowledgedSequence ||
      entry.attentionSequence > entry.attemptedAttentionSequence;
  }

  private schedule(channelId: string, entry: ChannelReadSyncEntry, delayMs: number): void {
    if (entry.inFlight || entry.timer !== undefined || !this.needsSync(entry)) return;
    entry.timer = this.scheduleTimer(() => {
      entry.timer = undefined;
      void this.pump(channelId, entry);
    }, delayMs);
  }

  private async pump(channelId: string, entry: ChannelReadSyncEntry): Promise<void> {
    if (entry.inFlight || !this.needsSync(entry)) return;
    const asked = this.asked();
    const targetSequence = entry.desiredSequence;
    entry.inFlight = true;
    let succeeded = false;
    try {
      const result = await this.options.send(channelId, targetSequence);
      if (!this.stillAsked(asked) || !result || !validSequence(result.readSequence)) return;
      entry.acknowledgedSequence = Math.max(entry.acknowledgedSequence, result.readSequence);
      // One successful acknowledgement is enough to reconcile attention for
      // this exposed high-water mark. If attention remains, it belongs to a
      // later message and must wait until that later sequence is exposed.
      entry.attemptedAttentionSequence = Math.max(
        entry.attemptedAttentionSequence,
        targetSequence,
      );
      entry.failureCount = 0;
      succeeded = true;
      this.options.onSuccess?.(channelId, result);
    } catch {
      // Product errors are surfaced by the caller. This class owns only the
      // bounded retry cadence for an idempotent read acknowledgement.
    } finally {
      if (asked.generation === this.generation) entry.inFlight = false;
      // Another reader's session goes on without this one's retries.
      if (this.stillAsked(asked)) {
        if (!succeeded) {
          const retryIndex = Math.min(entry.failureCount, Math.max(0, this.retryDelaysMs.length - 1));
          entry.failureCount += 1;
          this.schedule(channelId, entry, this.retryDelaysMs[retryIndex] ?? 30_000);
        } else {
          this.schedule(channelId, entry, 0);
        }
      }
    }
  }

  private clearTimer(entry: ChannelReadSyncEntry): void {
    if (entry.timer === undefined) return;
    this.cancelTimer(entry.timer);
    entry.timer = undefined;
  }
}

function validSequence(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The read counts the Channels' Hub read state gives. The Hub's answer
 * replaces what the device remembered, but not what it has read since: the
 * Hub's cursor only moves forward, so an answer short of that read was given
 * before the read reached it. A Channel without read state keeps its count, or
 * starts from its message count. The same object comes back when nothing
 * changed.
 */
export function readCountsFromHub(
  current: Record<string, number>,
  channels: readonly { id: string; readSequence?: number; messageCount?: number }[],
  readHere: (channelId: string) => number,
): Record<string, number> {
  let next: Record<string, number> | undefined;
  for (const channel of channels) {
    const known = (next ?? current)[channel.id];
    const count = channel.readSequence !== undefined
      ? Math.max(channel.readSequence, readHere(channel.id))
      : known === undefined ? channel.messageCount : known;
    if (count === undefined || count === known) continue;
    (next ??= { ...current })[channel.id] = count;
  }
  return next ?? current;
}
