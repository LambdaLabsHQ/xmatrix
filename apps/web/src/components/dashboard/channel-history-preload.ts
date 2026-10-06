/** One bounded, presentation-only read. It never grants permission to render. */
export class ChannelHistoryPreload<T extends { historyHeadSequence?: number }> {
  private pending?: {
    key: string;
    controller: AbortController;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout>;
    promise: Promise<T | undefined>;
  };

  start(key: string, read: (signal: AbortSignal) => Promise<T>, now = Date.now()): void {
    if (this.pending?.key === key && this.pending.expiresAt > now) return;
    this.clear();
    const controller = new AbortController();
    this.pending = {
      key, controller, expiresAt: now + 15_000,
      timer: setTimeout(() => {
        if (this.pending?.controller === controller) this.clear();
      }, 15_000),
      // A speculative failure must not become an unhandled rejection or poison
      // the normal authorized read's retry path.
      promise: read(controller.signal).catch(() => undefined),
    };
  }

  has(key: string, now = Date.now()): boolean {
    return this.pending?.key === key && this.pending.expiresAt > now;
  }

  async take(key: string, knownHead: number, now = Date.now()): Promise<T | undefined> {
    const entry = this.pending;
    if (!entry || entry.key !== key) return undefined;
    if (entry.expiresAt <= now) {
      this.clear();
      return undefined;
    }
    const page = await entry.promise;
    if (this.pending !== entry) return undefined;
    clearTimeout(entry.timer);
    this.pending = undefined;
    return page && (page.historyHeadSequence ?? 0) >= knownHead ? page : undefined;
  }

  clear(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending?.controller.abort();
    this.pending = undefined;
  }
}
