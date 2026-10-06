/**
 * How many Channel coordinator passes may use one PostgreSQL shard at once.
 *
 * Every Channel owns its own coordinator (docs/architecture/entity-coordinators.md),
 * so nothing else bounds how many of them reach PostgreSQL together: with enough
 * Channels holding due work, their passes took every Hyperdrive origin connection
 * and user requests (channel catalog, preferences, daemon registration) queued
 * behind them until they timed out. Permits bound that concurrency by the
 * shard's connection budget, whatever the number of users, Spaces or Channels.
 *
 * Two lanes share the budget. An interactive pass (a writer just woke the
 * Channel: a summon, a terminal report, an authority change) may use all of it;
 * a maintenance pass (the Channel's own alarm: retries, backoffs, retention)
 * only its share, so a backlog of retries never delays a summon.
 *
 * Permits are striped: a Channel always asks the same one of the shard's
 * stripes, and each stripe holds its slice of the budget, so the permit
 * objects scale out with load while the shard-wide bound stays exact.
 * They hold no work: a refused Channel keeps its rows and its alarm.
 */
export type BackgroundLane = "interactive" | "maintenance";

export type BackgroundAdmissionDecision =
  | { granted: true }
  | { granted: false; retryAfterMs: number };

export type BackgroundAdmissionBudget = {
  /** Stripes per shard. */
  stripes: number;
  /** Concurrent passes one stripe admits in either lane. */
  stripeLimit: number;
  /** Of those, how many may be maintenance passes. */
  stripeMaintenanceLimit: number;
};

/** A permit outlives a pass's 25 s deadline, and lapses if its holder is lost. */
export const BACKGROUND_PERMIT_LEASE_MS = 30_000;
const MIN_RETRY_MS = 500;
const DEFAULT_SHARD_PASS_LIMIT = 8;
const DEFAULT_STRIPES = 4;

/**
 * The shard budget: `POSTGRES_BACKGROUND_PASS_LIMIT` concurrent passes (each
 * serial, so about one origin connection apiece) split over
 * `POSTGRES_BACKGROUND_ADMISSION_STRIPES` stripes; maintenance gets half.
 * Size the limit as a fraction of the shard's origin pool, and add stripes,
 * not limit, when permit traffic grows.
 */
export function backgroundAdmissionBudget(env: {
  POSTGRES_BACKGROUND_PASS_LIMIT?: string; POSTGRES_BACKGROUND_ADMISSION_STRIPES?: string;
}): BackgroundAdmissionBudget {
  const limit = boundedInteger(env.POSTGRES_BACKGROUND_PASS_LIMIT, DEFAULT_SHARD_PASS_LIMIT, 1, 1_024);
  const stripes = Math.min(limit, boundedInteger(env.POSTGRES_BACKGROUND_ADMISSION_STRIPES, DEFAULT_STRIPES, 1, 256));
  const stripeLimit = Math.floor(limit / stripes);
  return { stripes, stripeLimit, stripeMaintenanceLimit: Math.max(1, Math.floor(stripeLimit / 2)) };
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** The stripe a Channel always asks: a stable hash of its id. */
export function admissionStripe(channelId: string, stripes: number): number {
  let hash = 2166136261;
  for (let index = 0; index < channelId.length; index++) {
    hash ^= channelId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % stripes;
}

export class BackgroundAdmission {
  private readonly holders = new Map<string, { lane: BackgroundLane; expiresAt: number }>();

  constructor(private readonly limit: number, private readonly maintenanceLimit: number,
    private readonly leaseMs = BACKGROUND_PERMIT_LEASE_MS) {}

  acquire(holder: string, lane: BackgroundLane, now = Date.now()): BackgroundAdmissionDecision {
    for (const [id, permit] of this.holders) if (permit.expiresAt <= now) this.holders.delete(id);
    const held = this.holders.get(holder);
    const maintenance = [...this.holders.values()].filter(permit => permit.lane === "maintenance").length;
    const fits = this.holders.size < this.limit &&
      (lane === "interactive" || maintenance < this.maintenanceLimit);
    if (held || fits) {
      this.holders.set(holder, { lane: held?.lane ?? lane, expiresAt: now + this.leaseMs });
      return { granted: true };
    }
    const soonest = Math.min(...[...this.holders.values()]
      .filter(permit => lane === "interactive" || this.holders.size < this.limit || permit.lane === "maintenance")
      .map(permit => permit.expiresAt));
    return { granted: false, retryAfterMs: Math.max(MIN_RETRY_MS, soonest - now) };
  }

  release(holder: string): void {
    this.holders.delete(holder);
  }
}
