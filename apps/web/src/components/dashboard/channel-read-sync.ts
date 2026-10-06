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
  inFlight: boolean;
  failureCount: number;
  timer?: TimerHandle;
};

export interface ChannelReadSyncCoordinatorOptions<T extends ChannelReadSyncResult> {
  send: (channelId: string, sequence: number) => Promise<T | undefined>;
  onSuccess?: (channelId: string, result: T) => void;
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
    const generation = this.generation;
    const targetSequence = entry.desiredSequence;
    entry.inFlight = true;
    let succeeded = false;
    try {
      const result = await this.options.send(channelId, targetSequence);
      if (generation !== this.generation || !result || !validSequence(result.readSequence)) return;
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
      if (generation === this.generation) {
        entry.inFlight = false;
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
