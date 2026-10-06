import { machineDaemonRouteKey } from "./runtime-transport/machine-daemon-port";

const DEFAULT_WAKE_TTL_MS = 30_000;
const DEFAULT_PENDING_LIMIT = 1_000;

/**
 * Ephemeral edge-triggered wake coordination for HTTP Machine Daemon long polls.
 * PostgreSQL remains the command authority; this class only shortens claim latency.
 */
export class MachineDaemonWakeSignals {
  private readonly waiters = new Map<string, Set<(woken: boolean) => void>>();
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly wakeTtlMs = DEFAULT_WAKE_TTL_MS,
    private readonly pendingLimit = DEFAULT_PENDING_LIMIT,
  ) {}

  wake(ownerUserId: string, machineId: string, hostId: string): void {
    const key = machineDaemonRouteKey({ ownerUserId, machineId, hostId });
    const waiters = this.waiters.get(key);
    if (waiters?.size) {
      this.waiters.delete(key);
      for (const resolve of waiters) resolve(true);
      return;
    }
    const now = this.now();
    for (const [pendingKey, createdAt] of this.pending) {
      if (createdAt <= now - this.wakeTtlMs) this.pending.delete(pendingKey);
    }
    if (this.pending.size >= this.pendingLimit) {
      const oldest = this.pending.keys().next().value;
      if (oldest) this.pending.delete(oldest);
    }
    this.pending.delete(key);
    this.pending.set(key, now);
  }

  async wait(ownerUserId: string, machineId: string, hostId: string,
    waitMs: number): Promise<boolean> {
    const key = machineDaemonRouteKey({ ownerUserId, machineId, hostId });
    const pendingAt = this.pending.get(key);
    this.pending.delete(key);
    if (pendingAt !== undefined && pendingAt > this.now() - this.wakeTtlMs) return true;
    return new Promise<boolean>((resolve) => {
      const waiters = this.waiters.get(key) ?? new Set<(woken: boolean) => void>();
      let timer: ReturnType<typeof setTimeout>;
      const complete = (woken: boolean) => {
        clearTimeout(timer);
        waiters.delete(complete);
        if (waiters.size === 0) this.waiters.delete(key);
        resolve(woken);
      };
      waiters.add(complete);
      this.waiters.set(key, waiters);
      timer = setTimeout(() => complete(false), waitMs);
    });
  }

  snapshot(): { pending: number; waitingScopes: number } {
    return { pending: this.pending.size, waitingScopes: this.waiters.size };
  }
}
