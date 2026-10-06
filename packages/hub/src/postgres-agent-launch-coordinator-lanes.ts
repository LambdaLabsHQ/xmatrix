import type { AgentLaunchWakeTarget } from "./postgres-agent-launch-coordinator";

/** A pass past this frees the lane; below the 30 s Launch lease, so a slow
 *  pass never holds rows the next pass could otherwise take over. Spawn
 *  commands are idempotent by id, so an overlapping late pass is harmless. */
export const CLAIM_PASS_DEADLINE_MS = 25_000;

type PendingTarget = { channelId: string; shardId?: string; launchIds: Set<string> };

/**
 * One coordinator's serial pass lane. A wake that arrives while a pass runs
 * merges into one more pass, so a burst costs one pass; a pass past its
 * deadline frees the lane.
 */
export class AgentLaunchCoordinatorLanes {
  private readonly pending = new Map<string, PendingTarget>();
  private sweepRequested = false;
  private sweeping = false;
  private active = 0;
  private idle: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(private readonly work: {
    claim: (target?: AgentLaunchWakeTarget) => Promise<number>;
    /** After each claim pass: the next periodic sweep, sooner while work is flowing. */
    schedule: (claimed: number) => Promise<void>;
    keepAlive: (task: Promise<unknown>) => void;
    onClaimError?: (error: unknown, target?: AgentLaunchWakeTarget) => void;
    onClaimOverrun?: (target?: AgentLaunchWakeTarget) => void;
    passDeadlineMs?: number;
  }) {}

  private enqueue(target: AgentLaunchWakeTarget): void {
    const key = `${target.shardId ?? ""}\0${target.channelId}`;
    const current = this.pending.get(key) ?? { channelId: target.channelId,
      ...(target.shardId ? { shardId: target.shardId } : {}), launchIds: new Set<string>() };
    for (const launchId of target.launchIds) current.launchIds.add(launchId);
    this.pending.set(key, current);
  }

  private take(): { target?: AgentLaunchWakeTarget } | undefined {
    const entry = this.pending.entries().next().value as [string, PendingTarget] | undefined;
    if (entry) {
      this.pending.delete(entry[0]);
      return { target: { channelId: entry[1].channelId, launchIds: [...entry[1].launchIds],
        ...(entry[1].shardId ? { shardId: entry[1].shardId } : {}) } };
    }
    // One sweep at a time: a second one would only contend for the same rows.
    if (this.sweepRequested && !this.sweeping) {
      this.sweepRequested = false;
      this.sweeping = true;
      return {};
    }
    return undefined;
  }

  private async pass(target?: AgentLaunchWakeTarget): Promise<void> {
    let claimed = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = this.work.claim(target).then(count => { claimed = count; },
      error => { this.work.onClaimError?.(error, target); });
    const late = await Promise.race([running.then(() => false), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), this.work.passDeadlineMs ?? CLAIM_PASS_DEADLINE_MS);
    })]);
    clearTimeout(timer);
    if (late) {
      this.work.onClaimOverrun?.(target);
      this.work.keepAlive(running);
    }
    await this.work.schedule(claimed).catch(() => undefined);
  }

  private pump(): void {
    while (this.active === 0) {
      const next = this.take();
      if (!next) break;
      this.active++;
      const task = this.pass(next.target).finally(() => {
        this.active--;
        if (!next.target) this.sweeping = false;
        this.pump();
      });
      this.work.keepAlive(task);
    }
    if (this.active === 0 && this.pending.size === 0 && !this.sweepRequested && this.idle) {
      this.idle.resolve();
      this.idle = null;
    }
  }

  /** A targeted wake, or with no target the periodic sweep of every due Launch.
   *  Resolves when the claim lane has drained. */
  claim(target?: AgentLaunchWakeTarget): Promise<void> {
    if (target) this.enqueue(target); else this.sweepRequested = true;
    if (!this.idle) {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      this.idle = { promise, resolve };
    }
    const idle = this.idle.promise;
    this.pump();
    return idle;
  }
}
