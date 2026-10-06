import type { QueryResultRow } from "pg";

import type { DatabaseRequestContext } from "./context.js";
import type { SpacePlacementHints } from "./placement.js";

export interface DatabaseQuery {
  /** Stable low-cardinality name used for telemetry; never include user input. */
  name: string;
  text: string;
  values?: readonly unknown[];
  /** Required fail-closed result bound. SQL should also apply its own LIMIT. */
  maxRows: number;
}

export interface DatabaseTransaction {
  query<Row extends QueryResultRow>(query: DatabaseQuery): Promise<readonly Row[]>;
}

export interface AuthorityDatabase {
  readonly cacheMode: "disabled";
  /**
   * The fleet's Space placement routing hints, when the caller enabled them.
   * A placed transaction still checks the shard's own fence before any work.
   */
  readonly placementHints?: SpacePlacementHints;
  /** Creates one bounded database lifetime for a single Worker request. */
  openSession(): AuthorityDatabaseSession;
  transaction<T>(
    context: DatabaseRequestContext,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T>;
  health(context: DatabaseRequestContext): Promise<DatabaseHealth>;
}

export interface AuthorityDatabaseSession extends AuthorityDatabase {
  /** Idempotently rolls back unfinished work, releases connections, and closes request-local pools. */
  close(): Promise<void>;
}

export interface DatabaseHealth {
  ok: true;
  latencyMs: number;
  shardId: string | null;
}

export interface DatabaseObservation {
  requestId: string;
  operation: string;
  queryName: string;
  shardId: string | null;
  durationMs: number;
  rowCount: number;
  outcome: "ok" | "error" | "row_limit";
  slow: boolean;
  errorCode?: string;
}

export type DatabaseObserver = (observation: DatabaseObservation) => void;

/**
 * One summary per connection checkout, emitted when the session closes. It
 * splits a request's database wall time into waiting, connecting, and SQL so
 * tail latency can be attributed without joining per-query points.
 */
export interface DatabaseSessionObservation {
  /** Operation of the session's first transaction. */
  operation: string;
  shardId: string | null;
  /**
   * `rollback`: a callback abandoned its transaction (a business outcome such
   * as not-found or a conflict) with no database failure. `error`: the
   * database or transport failed; `errorCode` names the first failure.
   */
  outcome: "ok" | "rollback" | "error";
  /** Code of the first database failure in the session. */
  errorCode?: string;
  /** First transaction start to close. */
  wallMs: number;
  /** Time transactions spent queued behind earlier ones in this session. */
  queueMs: number;
  /** Worker to Hyperdrive checkout. */
  checkoutMs: number;
  /**
   * The checkout's first statement (a transaction opening or a single read).
   * Hyperdrive takes an origin connection for it, so its excess over one round
   * trip is origin pool wait. It overlaps the phase or SQL time that also counts it.
   */
  firstStatementMs: number;
  /** Opening round trips: BEGIN, the transaction-local settings, and the placement fence together. */
  beginMs: number;
  sqlMs: number;
  sqlMaxMs: number;
  commitMs: number;
  rollbackMs: number;
  roundTrips: number;
  transactions: number;
  queries: number;
  rows: number;
}

export type DatabaseSessionObserver = (observation: DatabaseSessionObservation) => void;
