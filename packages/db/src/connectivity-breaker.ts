/**
 * A per-isolate, per-shard circuit breaker for PostgreSQL connectivity.
 *
 * When the network path to a shard stalls, every request otherwise waits out
 * its full connect or first-statement deadline and piles more load onto the
 * Hyperdrive pool. After a burst of consecutive connectivity failures the
 * breaker fails new sessions fast, before any checkout, then lets one probe
 * session through per cooldown; any successful statement closes it again.
 *
 * The state is a hint held in one isolate's memory, never authority: it only
 * ever answers with a retryable `DatabaseCircuitOpenError`, never touches a
 * session that already holds a connection, and is lost on isolate eviction.
 */

/** Consecutive connectivity failures that open a closed breaker. */
export const CONNECTIVITY_FAILURE_THRESHOLD = 5;
/** A failure streak older than this starts again at one. */
export const CONNECTIVITY_FAILURE_WINDOW_MS = 10_000;
/** The first open period; each failed probe doubles it up to the maximum. */
export const CONNECTIVITY_BASE_COOLDOWN_MS = 5_000;
export const CONNECTIVITY_MAX_COOLDOWN_MS = 30_000;
/**
 * How long one half-open probe may stay unresolved before another session may
 * probe. It exceeds the longest connect (8 s) plus transaction (10 s) budget.
 */
const PROBE_LEASE_MS = 20_000;
/** Retry hint while a probe is already in flight. */
const PROBE_IN_FLIGHT_RETRY_MS = 1_000;
/** Shards tracked per isolate; the oldest entry is forgotten beyond this. */
const MAX_TRACKED_SHARDS = 64;

/** No PostgreSQL work was attempted: the shard's breaker is open. Always safe to replay. */
export class DatabaseCircuitOpenError extends Error {
  readonly code = "database_circuit_open";
  readonly retryable = true;

  constructor(readonly shardId: string, readonly retryAfterMs: number) {
    super("PostgreSQL shard is temporarily unavailable");
    this.name = "DatabaseCircuitOpenError";
  }
}

const CONNECTIVITY_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH", "ENOTFOUND",
  "EPIPE", "ETIMEDOUT", "53300", "57P03",
  // Code-less node-postgres transport failures, as named by the client's errorCode.
  "CONNECT_TIMEOUT", "QUERY_READ_TIMEOUT", "CONNECTION_TERMINATED", "CONNECTION_UNUSABLE",
]);

/**
 * Whether a database error code says the path to the shard failed, rather than
 * the transaction: serialization, deadlock, constraint, statement-timeout and
 * contract failures are per-request and never trip the breaker.
 */
export function connectivityFailureCode(code: string): boolean {
  const normalized = code.trim().toUpperCase();
  return CONNECTIVITY_CODES.has(normalized) || /^08[0-9A-Z]{3}$/u.test(normalized);
}

/** What `admit` granted: an ordinary session, or the single half-open probe. */
export interface ConnectivityAdmission {
  readonly probe: boolean;
}

type BreakerState =
  | { kind: "closed"; failures: number; streakStartedAt: number }
  | { kind: "open"; until: number }
  | { kind: "half_open"; probeDeadline: number };

export class ConnectivityBreaker {
  private state: BreakerState = { kind: "closed", failures: 0, streakStartedAt: 0 };
  private opens = 0;

  constructor(
    readonly shardId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Admits a new connection attempt or throws `DatabaseCircuitOpenError`. */
  admit(): ConnectivityAdmission {
    const now = this.now();
    const state = this.state;
    if (state.kind === "closed") return { probe: false };
    if (state.kind === "open" && now < state.until) throw this.rejection(state.until - now);
    if (state.kind === "half_open" && now < state.probeDeadline) {
      throw this.rejection(PROBE_IN_FLIGHT_RETRY_MS);
    }
    this.state = { kind: "half_open", probeDeadline: now + PROBE_LEASE_MS };
    return { probe: true };
  }

  /** A statement completed on this shard: the path works. */
  success(): void {
    this.opens = 0;
    this.state = { kind: "closed", failures: 0, streakStartedAt: 0 };
  }

  /** A session met a connectivity failure (see `connectivityFailureCode`). */
  failure(): void {
    const now = this.now();
    const state = this.state;
    if (state.kind === "open") return;
    if (state.kind === "half_open") {
      this.open(now);
      return;
    }
    const fresh = state.failures === 0 || now - state.streakStartedAt > CONNECTIVITY_FAILURE_WINDOW_MS;
    const failures = fresh ? 1 : state.failures + 1;
    const streakStartedAt = fresh ? now : state.streakStartedAt;
    if (failures >= CONNECTIVITY_FAILURE_THRESHOLD) this.open(now);
    else this.state = { kind: "closed", failures, streakStartedAt };
  }

  /** A probe session ended without evidence either way; let the next one probe. */
  releaseProbe(): void {
    if (this.state.kind === "half_open") this.state = { kind: "open", until: this.now() };
  }

  private open(now: number): void {
    const cooldown = Math.min(CONNECTIVITY_BASE_COOLDOWN_MS * 2 ** this.opens, CONNECTIVITY_MAX_COOLDOWN_MS);
    this.opens = Math.min(this.opens + 1, 8);
    this.state = { kind: "open", until: now + cooldown };
  }

  private rejection(retryAfterMs: number): DatabaseCircuitOpenError {
    return new DatabaseCircuitOpenError(this.shardId, Math.max(1, Math.ceil(retryAfterMs)));
  }
}

const breakers = new Map<string, ConnectivityBreaker>();

/** The isolate's breaker for one physical shard. */
export function shardConnectivityBreaker(shardId: string): ConnectivityBreaker {
  const existing = breakers.get(shardId);
  if (existing) return existing;
  if (breakers.size >= MAX_TRACKED_SHARDS) {
    const oldest = breakers.keys().next().value;
    if (oldest !== undefined) breakers.delete(oldest);
  }
  const breaker = new ConnectivityBreaker(shardId);
  breakers.set(shardId, breaker);
  return breaker;
}

/**
 * One request session's view of its shard breaker: admission before each new
 * checkout, and at most one reported outcome, so N failures are N sessions.
 */
export class SessionConnectivity {
  private admission: ConnectivityAdmission | null = null;
  private settled = false;

  constructor(private readonly breaker: ConnectivityBreaker) {}

  admit(): void {
    if (this.admission?.probe && !this.settled) return;
    this.admission = this.breaker.admit();
  }

  reached(): void {
    if (this.settled) return;
    this.settled = true;
    this.breaker.success();
  }

  failed(code: string): void {
    if (this.settled || !connectivityFailureCode(code)) return;
    this.settled = true;
    this.breaker.failure();
  }

  close(): void {
    if (this.admission?.probe && !this.settled) this.breaker.releaseProbe();
  }
}
