import { utf8ByteLength } from "@xmatrix/protocol";
import { Client, Pool, type ClientConfig, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

import type {
  AuthorityDatabase,
  AuthorityDatabaseSession,
  DatabaseHealth,
  DatabaseObservation,
  DatabaseObserver,
  DatabaseQuery,
  DatabaseSessionObservation,
  DatabaseSessionObserver,
  DatabaseTransaction,
} from "./contracts.js";
import { databaseRequestContext, type DatabaseRequestContext } from "./context.js";
import { SessionConnectivity, shardConnectivityBreaker, type ConnectivityBreaker } from "./connectivity-breaker.js";
import {
  DatabaseCommitUnknownError,
  DatabaseContractError,
  DatabasePlacementStaleError,
  DatabasePreparedUnknownError,
  DatabaseRowLimitError,
} from "./errors.js";
import type { SpacePlacementHints } from "./placement.js";
import { dingtalkPreparation, dingtalkDecision, dingtalkPreparedPlan, registerDingTalkPreparedPort, registerDingTalkPreparedTransaction,
  type DingTalkPreparedPlan, type DingTalkPreparedDecision } from "./dingtalk-prepared-port.js";

const MAX_QUERY_NAME_BYTES = 160;
const MAX_QUERY_BYTES = 64 * 1024;
const MAX_QUERY_VALUES = 256;
const MAX_RESULT_ROWS = 10_000;

interface PgClientPort {
  connect(): Promise<unknown>;
  query<Row extends QueryResultRow = QueryResultRow>(
    input: string | { name?: string; text: string; values?: unknown[] },
  ): Promise<QueryResult<Row>>;
  end(): Promise<void>;
  release?(destroy?: boolean): void;
}

interface PgPoolPort {
  connect(): Promise<PgClientPort>;
  end(): Promise<void>;
}

export interface AuthorityDatabaseOptions {
  connectionString: string;
  /** Stable identity of the physical shard reached by this connection. */
  shardId: string;
  applicationName?: string;
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
  transactionTimeoutMs?: number;
  lockTimeoutMs?: number;
  slowQueryMs?: number;
  observer?: DatabaseObserver;
  sessionObserver?: DatabaseSessionObserver;
  /** Driver seam for bounded pooled checkouts and isolated verification. */
  clientFactory?: (config: ClientConfig) => PgClientPort;
  /** Preferred test seam. Pools are created per request and always use max=1. */
  poolFactory?: (config: PoolConfig) => PgPoolPort;
  /** Test seam; defaults to this isolate's breaker for `shardId`. */
  connectivityBreaker?: ConnectivityBreaker;
  /** The fleet's placement hints: a refused fence forgets the Space's hint. */
  placementHints?: SpacePlacementHints;
}

interface ResolvedOptions {
  connectionString: string;
  shardId: string;
  applicationName: string;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  transactionTimeoutMs: number;
  lockTimeoutMs: number;
  slowQueryMs: number;
  observer?: DatabaseObserver;
  sessionObserver?: DatabaseSessionObserver;
  clientFactory: (config: ClientConfig) => PgClientPort;
  poolFactory: (config: PoolConfig) => PgPoolPort;
  connectivityBreaker: ConnectivityBreaker;
  placementHints?: SpacePlacementHints;
}

class SingleClientPool implements PgPoolPort {
  private client: PgClientPort | null = null;

  constructor(
    private readonly config: PoolConfig,
    private readonly factory: (config: ClientConfig) => PgClientPort,
  ) {}

  async connect(): Promise<PgClientPort> {
    if (this.client) return this.client;
    const client = this.factory(this.config);
    await client.connect();
    // Like a pg Pool checkout, `release(true)` destroys the client so the
    // next checkout connects afresh; a plain release keeps it for `end`.
    const checkout: PgClientPort = {
      connect: () => client.connect(),
      query: client.query.bind(client),
      end: () => client.end(),
      release: (destroy) => {
        if (!destroy || this.client !== checkout) return;
        this.client = null;
        void client.end().catch(() => undefined);
      },
    };
    this.client = checkout;
    return checkout;
  }

  async end(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.end();
  }
}

function boundedInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 120_000) {
    throw new DatabaseContractError(`${field} must be between 1 and 120000 milliseconds`);
  }
  return resolved;
}

function boundedLabel(value: string | undefined, fallback: string, field: string): string {
  const resolved = (value ?? fallback).trim();
  if (!resolved || utf8ByteLength(resolved) > MAX_QUERY_NAME_BYTES) {
    throw new DatabaseContractError(`${field} is invalid`);
  }
  return resolved;
}

function resolveOptions(input: AuthorityDatabaseOptions): ResolvedOptions {
  if (typeof input.connectionString !== "string" || !input.connectionString.trim()) {
    throw new DatabaseContractError("connectionString is required");
  }
  const statementTimeoutMs = boundedInteger(
    input.statementTimeoutMs,
    5_000,
    "statementTimeoutMs",
  );
  const transactionTimeoutMs = boundedInteger(
    input.transactionTimeoutMs,
    10_000,
    "transactionTimeoutMs",
  );
  if (transactionTimeoutMs < statementTimeoutMs) {
    throw new DatabaseContractError("transactionTimeoutMs cannot be shorter than statementTimeoutMs");
  }
  const shardId = boundedLabel(input.shardId, "", "shardId");
  return {
    connectionString: input.connectionString,
    shardId,
    applicationName: boundedLabel(input.applicationName, "xmatrix-hub", "applicationName"),
    connectTimeoutMs: boundedInteger(input.connectTimeoutMs, 3_000, "connectTimeoutMs"),
    statementTimeoutMs,
    transactionTimeoutMs,
    lockTimeoutMs: boundedInteger(input.lockTimeoutMs, 2_000, "lockTimeoutMs"),
    slowQueryMs: boundedInteger(input.slowQueryMs, 250, "slowQueryMs"),
    ...(input.observer ? { observer: input.observer } : {}),
    ...(input.sessionObserver ? { sessionObserver: input.sessionObserver } : {}),
    ...(input.placementHints ? { placementHints: input.placementHints } : {}),
    clientFactory: input.clientFactory ?? ((config) => new Client(config)),
    poolFactory: input.poolFactory ?? (input.clientFactory
      ? ((config) => new SingleClientPool(config, input.clientFactory!))
      : ((config) => new Pool(config) as unknown as PgPoolPort)),
    connectivityBreaker: input.connectivityBreaker ?? shardConnectivityBreaker(shardId),
  };
}

function validatedQuery(query: DatabaseQuery): DatabaseQuery {
  const name = boundedLabel(query.name, "", "query.name");
  if (typeof query.text !== "string" || !query.text.trim() ||
      utf8ByteLength(query.text) > MAX_QUERY_BYTES) {
    throw new DatabaseContractError("query.text is invalid");
  }
  if (!Number.isSafeInteger(query.maxRows) || query.maxRows < 0 || query.maxRows > MAX_RESULT_ROWS) {
    throw new DatabaseContractError(`query.maxRows must be between 0 and ${MAX_RESULT_ROWS}`);
  }
  if (query.values && query.values.length > MAX_QUERY_VALUES) {
    throw new DatabaseContractError(`query.values cannot exceed ${MAX_QUERY_VALUES} entries`);
  }
  return { ...query, name };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" && error.code.length <= 80) {
    return error.code;
  }
  if (error instanceof DatabaseContractError) return "DATABASE_CONTRACT_ERROR";
  // node-postgres's client-side deadline has no SQLSTATE. Unlike a server
  // statement timeout, it does not establish that the wire query has finished.
  if (error instanceof Error) {
    const code = DRIVER_ERROR_CODES.get(error.message);
    if (code) return code;
  }
  return "database_error";
}

/** node-postgres transport failures that carry no code, keyed by exact message. */
const DRIVER_ERROR_CODES = new Map([
  ["Query read timeout", "QUERY_READ_TIMEOUT"],
  ["Connection terminated", "CONNECTION_TERMINATED"],
  ["Connection terminated unexpectedly", "CONNECTION_TERMINATED"],
  ["Client has encountered a connection error and is not queryable", "CONNECTION_UNUSABLE"],
  ["Client was closed and is not queryable", "CONNECTION_UNUSABLE"],
  ["Connection terminated due to connection timeout", "CONNECT_TIMEOUT"],
  ["timeout exceeded when trying to connect", "CONNECT_TIMEOUT"],
]);

function commitResultMayBeUnknown(error: unknown): boolean {
  const code = errorCode(error).toUpperCase();
  return /^08[0-9A-Z]{3}$/u.test(code) || new Set([
    "ECONNRESET", "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH", "EPIPE", "ETIMEDOUT",
    "QUERY_READ_TIMEOUT", "CONNECTION_TERMINATED", "CONNECTION_UNUSABLE",
  ]).has(code);
}

function observe(observer: DatabaseObserver | undefined, value: DatabaseObservation): void {
  if (!observer) return;
  try {
    observer(Object.freeze(value));
  } catch {
    // Observation is deliberately non-authoritative and cannot fail a query.
  }
}

type SessionPhase = "pool_checkout" | "begin" | "commit" | "rollback";

/**
 * Request-local accumulator behind DatabaseSessionObservation. It also reports
 * the session's first statement outcome to the shard's connectivity breaker.
 */
class SessionStats {
  operation: string | null = null;
  startedAt = 0;
  errorCode: string | undefined;
  rolledBack = false;
  firstStatementPending = true;
  readonly totals = {
    queueMs: 0, checkoutMs: 0, firstStatementMs: 0, beginMs: 0,
    sqlMs: 0, sqlMaxMs: 0, commitMs: 0, rollbackMs: 0,
    roundTrips: 0, transactions: 0, queries: 0, rows: 0,
  };

  constructor(readonly connectivity: SessionConnectivity) {}

  startTransaction(operation: string, queueMs: number, startedAt: number): void {
    if (this.operation === null) {
      this.operation = operation;
      this.startedAt = startedAt;
    }
    this.totals.transactions += 1;
    this.totals.queueMs += queueMs;
  }

  statement(durationMs: number): void {
    this.totals.roundTrips += 1;
    if (this.firstStatementPending) {
      this.firstStatementPending = false;
      this.totals.firstStatementMs = durationMs;
    }
  }

  phase(phase: SessionPhase, durationMs: number): void {
    if (phase === "pool_checkout") {
      this.totals.checkoutMs += durationMs;
      return;
    }
    this.statement(durationMs);
    this.totals[`${phase}Ms`] += durationMs;
  }

  query(durationMs: number, rows: number): void {
    this.statement(durationMs);
    this.totals.queries += 1;
    this.totals.rows += rows;
    this.totals.sqlMs += durationMs;
    this.totals.sqlMaxMs = Math.max(this.totals.sqlMaxMs, durationMs);
  }

  fail(code: string): void {
    this.errorCode ??= code;
    this.connectivity.failed(code);
  }

  observation(shardId: string, endedAt: number): DatabaseSessionObservation {
    return {
      operation: this.operation ?? "unknown",
      shardId,
      outcome: this.errorCode ? "error" : this.rolledBack ? "rollback" : "ok",
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      wallMs: endedAt - this.startedAt,
      ...this.totals,
    };
  }
}

class PgDatabaseTransaction implements DatabaseTransaction {
  constructor(
    protected client: PgClientPort,
    private readonly context: DatabaseRequestContext,
    private readonly options: ResolvedOptions,
    private readonly stats: SessionStats,
  ) {}

  async query<Row extends QueryResultRow>(input: DatabaseQuery): Promise<readonly Row[]> {
    const query = validatedQuery(input);
    const startedAt = performance.now();
    try {
      const result = await this.client.query<Row>({
        text: query.text,
        ...(query.values ? { values: [...query.values] } : {}),
      });
      const durationMs = performance.now() - startedAt;
      this.stats.query(durationMs, result.rows.length);
      this.stats.connectivity.reached();
      if (result.rows.length > query.maxRows) {
        this.stats.fail("database_row_limit_exceeded");
        observe(this.options.observer, this.observation(
          query.name,
          durationMs,
          result.rows.length,
          "row_limit",
          "database_row_limit_exceeded",
        ));
        throw new DatabaseRowLimitError(query.name, query.maxRows);
      }
      observe(this.options.observer, this.observation(
        query.name,
        durationMs,
        result.rows.length,
        "ok",
      ));
      return result.rows;
    } catch (error) {
      if (!(error instanceof DatabaseRowLimitError)) {
        const durationMs = performance.now() - startedAt;
        this.stats.query(durationMs, 0);
        this.stats.fail(errorCode(error));
        observe(this.options.observer, this.observation(
          query.name,
          durationMs,
          0,
          "error",
          errorCode(error),
        ));
      }
      throw error;
    }
  }

  private observation(
    queryName: string,
    durationMs: number,
    rowCount: number,
    outcome: DatabaseObservation["outcome"],
    code?: string,
  ): DatabaseObservation {
    return {
      requestId: this.context.requestId,
      operation: this.context.operation,
      queryName,
      shardId: this.options.shardId,
      durationMs,
      rowCount,
      outcome,
      slow: durationMs >= this.options.slowQueryMs,
      ...(code ? { errorCode: code } : {}),
    };
  }
}

/**
 * Reissues a single read once on a fresh checkout after `stalled` timed out,
 * running `attempt` on it. Supplied by the session that owns the checkout.
 */
type SingleReadRetry = <T>(
  stalled: PgClientPort,
  failure: unknown,
  attempt: (client: PgClientPort) => Promise<T>,
) => Promise<T>;

const SINGLE_READ_START = /^\s*(?:SELECT|WITH)\b/iu;
const LOCKING_CLAUSE = /\bFOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/iu;

/**
 * Runs the callback's only query as one statement in an implicit
 * transaction, with the transaction-local settings joined in. A read that
 * takes row locks or modifies data is refused: it needs an explicit
 * transaction. The settings apply from inside the statement, so the server
 * `statement_timeout` does not bound it; the client query timeout does, and
 * callers keep it to bounded index lookups. A client read timeout is retried
 * once on a fresh checkout: the statement is a lock-free read, so a lost
 * response cannot have changed anything, and Hyperdrive occasionally stalls
 * one round trip.
 */
class PgSingleReadTransaction extends PgDatabaseTransaction {
  private used = false;

  constructor(
    client: PgClientPort,
    private readonly readContext: DatabaseRequestContext,
    private readonly readOptions: ResolvedOptions,
    stats: SessionStats,
    private readonly retry: SingleReadRetry,
  ) {
    super(client, readContext, readOptions, stats);
  }

  override async query<Row extends QueryResultRow>(input: DatabaseQuery): Promise<readonly Row[]> {
    if (this.used) throw new DatabaseContractError("a single read transaction allows one query");
    this.used = true;
    const query = validatedQuery(input);
    if (!SINGLE_READ_START.test(query.text) || LOCKING_CLAUSE.test(query.text)) {
      throw new DatabaseContractError("a single read must be a lock-free SELECT");
    }
    const values = query.values ?? [];
    const settingValues = transactionSettingValues(this.readContext, this.readOptions);
    const placement = this.readContext.placement;
    const attempt = () => placement
      ? this.placedQuery<Row>(query, values, settingValues, placement)
      : super.query<Row>({
        ...query,
        text: `SELECT single_read.* FROM (${transactionSettingsSql(placeholderFrom(values.length + 1))}) settings
          CROSS JOIN LATERAL (${query.text}) single_read`,
        values: [...values, ...settingValues],
      });
    try {
      return await attempt();
    } catch (error) {
      // Only a lost response is retried; any answered failure, including a
      // refused placement fence, is final.
      if (errorCode(error) !== "QUERY_READ_TIMEOUT") throw error;
      return this.retry(this.client, error, (client) => {
        this.client = client;
        return attempt();
      });
    }
  }

  /**
   * A placed single read takes the Space placement fence in its own statement:
   * the settings row, then the `FOR SHARE` fence row (under the configured
   * `lock_timeout`), then the caller's read, all from one snapshot. The row
   * lock is held until the statement ends, which is the read's whole lifetime,
   * so a concurrent move waits for it exactly as it waits for a placed
   * transaction. The fence row is always returned, even when the read yields
   * none, and is checked before any caller row is admitted. `maxRows` bounds
   * the caller's rows; the fence-only row for an empty read is not one.
   */
  private async placedQuery<Row extends QueryResultRow>(
    query: DatabaseQuery,
    values: readonly unknown[],
    settingValues: readonly unknown[],
    placement: NonNullable<DatabaseRequestContext["placement"]>,
  ): Promise<readonly Row[]> {
    const first = values.length + 1;
    const rows = await super.query<QueryResultRow>({
      ...query,
      // One extra row: the fence-only row an empty read still returns.
      maxRows: query.maxRows + 1,
      text: `SELECT fence.shard_id AS "${FENCE_SHARD}",fence.placement_epoch AS "${FENCE_EPOCH}",
          fence.state AS "${FENCE_STATE}",fence.target_shard_id AS "${FENCE_TARGET}",single_read.*
        FROM (${transactionSettingsSql(placeholderFrom(first))}) settings
        LEFT JOIN LATERAL (
          SELECT shard_id,placement_epoch,state,target_shard_id
          FROM control.space_placement
          WHERE space_id=$${first + 6} AND settings.configured IS NOT NULL
          FOR SHARE
        ) fence ON true
        LEFT JOIN LATERAL (
          SELECT TRUE AS "${READ_ROW}",placed_read.* FROM (${query.text}) placed_read
          WHERE fence.state IS NOT NULL
        ) single_read ON true`,
      values: [...values, ...settingValues],
    });
    const fence = rows[0];
    if (!fenceAdmits(fence && {
      shard_id: fence[FENCE_SHARD], placement_epoch: fence[FENCE_EPOCH],
      state: fence[FENCE_STATE], target_shard_id: fence[FENCE_TARGET],
    }, placement)) refuseStalePlacement(this.readOptions, placement);
    const admitted = rows.filter((row) => row[READ_ROW] === true).map((row) => {
      const {
        [FENCE_SHARD]: _shard, [FENCE_EPOCH]: _epoch, [FENCE_STATE]: _state,
        [FENCE_TARGET]: _target, [READ_ROW]: _read, ...rest
      } = row;
      return rest as Row;
    });
    if (admitted.length > query.maxRows) throw new DatabaseRowLimitError(query.name, query.maxRows);
    return admitted;
  }
}

const FENCE_SHARD = "__xmatrix_fence_shard_id";
const FENCE_EPOCH = "__xmatrix_fence_placement_epoch";
const FENCE_STATE = "__xmatrix_fence_state";
const FENCE_TARGET = "__xmatrix_fence_target_shard_id";
const READ_ROW = "__xmatrix_read_row";

/** `$n` placeholders numbered from `first`, for settings bound as parameters. */
function placeholderFrom(first: number): (offset: number) => string {
  return (offset) => `$${first + offset}`;
}

/** Transaction-local settings, each value supplied by `p(offset)` in `transactionSettingValues` order. */
function transactionSettingsSql(p: (offset: number) => string): string {
  return `SELECT
      set_config('application_name', ${p(0)}, true),
      set_config('statement_timeout', ${p(1)}, true),
      set_config('transaction_timeout', ${p(2)}, true),
      set_config('lock_timeout', ${p(3)}, true),
      set_config('idle_in_transaction_session_timeout', ${p(2)}, true),
      set_config('xmatrix.request_id', ${p(4)}, true),
      set_config('xmatrix.operation', ${p(5)}, true),
      set_config('xmatrix.space_id', ${p(6)}, true),
      set_config('xmatrix.shard_id', ${p(7)}, true),
      set_config('xmatrix.placement_epoch', ${p(8)}, true) AS configured`;
}

function transactionSettingValues(
  context: DatabaseRequestContext,
  options: ResolvedOptions,
): string[] {
  return [
    options.applicationName,
    String(options.statementTimeoutMs),
    String(options.transactionTimeoutMs),
    String(options.lockTimeoutMs),
    context.requestId,
    context.operation,
    context.placement?.spaceId ?? "",
    context.placement?.shardId ?? options.shardId,
    String(context.placement?.placementEpoch ?? ""),
  ];
}

/** A quoted PostgreSQL string literal, as node-postgres's `escapeLiteral` writes it. */
function sqlLiteral(value: string): string {
  if (value.includes("\u0000")) throw new DatabaseContractError("transaction setting is invalid");
  const quoted = `'${value.replaceAll("'", "''").replaceAll("\\", "\\\\")}'`;
  return value.includes("\\") ? ` E${quoted}` : quoted;
}

interface PlacementFenceRow extends QueryResultRow {
  shard_id: unknown;
  placement_epoch: unknown;
  state: unknown;
  target_shard_id: unknown;
}

/** Whether the shard's own fence row is exactly the writable placement the request was routed by. */
function fenceAdmits(
  row: PlacementFenceRow | undefined,
  placement: NonNullable<DatabaseRequestContext["placement"]>,
): boolean {
  return Boolean(row) && row!.shard_id === placement.shardId &&
    Number(row!.placement_epoch) === placement.placementEpoch &&
    row!.state === "active" && row!.target_shard_id === null;
}

/** The fence refused the placement: no hint may keep routing the Space there. */
function refuseStalePlacement(
  options: ResolvedOptions,
  placement: NonNullable<DatabaseRequestContext["placement"]>,
): never {
  options.placementHints?.forget(placement.spaceId);
  throw new DatabasePlacementStaleError(placement.spaceId);
}

/**
 * Opens a transaction in one round trip: BEGIN, the transaction-local
 * settings, and for a placed request the Space placement fence travel as one
 * simple-protocol message. That protocol takes no parameters, so the settings
 * are literals; every value is an internal string, quoted by `sqlLiteral`. The
 * lateral reference to `settings` makes the fence scan run after the settings
 * row, so its row lock waits under the configured `lock_timeout`. Answers
 * whether the shard's fence admits the request's placement (an unplaced
 * request has none to admit).
 */
async function openTransaction(
  client: PgClientPort,
  context: DatabaseRequestContext,
  options: ResolvedOptions,
): Promise<boolean> {
  const values = transactionSettingValues(context, options);
  const literal = (offset: number) => sqlLiteral(values[offset]!);
  const settings = transactionSettingsSql(literal);
  const begin = context.isolation === "serializable" ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN";
  if (!context.placement) {
    await client.query(`${begin};${settings}`);
    return true;
  }
  // node-postgres answers a multi-statement message with one result per statement.
  const result: unknown = await client.query(`${begin};SELECT fence.shard_id,fence.placement_epoch,
      fence.state,fence.target_shard_id
    FROM (${settings}) settings
    LEFT JOIN LATERAL (
      SELECT shard_id,placement_epoch,state,target_shard_id
      FROM control.space_placement
      WHERE space_id=${literal(6)} AND settings.configured IS NOT NULL
      FOR SHARE
    ) fence ON true`);
  const fence = (Array.isArray(result) ? result.at(-1) : result) as QueryResult<PlacementFenceRow> | undefined;
  return fenceAdmits(fence?.rows[0], context.placement);
}

function observePhase(
  options: ResolvedOptions,
  context: DatabaseRequestContext,
  stats: SessionStats,
  phase: SessionPhase,
  startedAt: number,
  error?: unknown,
): void {
  const durationMs = performance.now() - startedAt;
  stats.phase(phase, durationMs);
  if (error) stats.fail(errorCode(error));
  // A checkout through a reachable Hyperdrive can still stall on the origin,
  // so only a completed statement, never the checkout, closes the breaker.
  else if (phase !== "pool_checkout") stats.connectivity.reached();
  observe(options.observer, {
    requestId: context.requestId,
    operation: context.operation,
    queryName: `database_phase_${phase}_v1`,
    shardId: options.shardId,
    durationMs,
    rowCount: 0,
    outcome: error ? "error" : "ok",
    slow: durationMs >= options.slowQueryMs,
    ...(error ? { errorCode: errorCode(error) } : {}),
  });
}

class PgAuthorityDatabaseSession implements AuthorityDatabaseSession {
  readonly cacheMode = "disabled" as const;
  readonly placementHints: SpacePlacementHints | undefined;
  private readonly pool: PgPoolPort;
  private connectionPromise: Promise<PgClientPort> | null = null;
  private transactionTail: Promise<void> = Promise.resolve();
  private closed = false;
  private connectionUnusable = false;
  private readonly stats: SessionStats;

  constructor(private readonly options: ResolvedOptions) {
    this.stats = new SessionStats(new SessionConnectivity(options.connectivityBreaker));
    this.placementHints = options.placementHints;
    this.pool = options.poolFactory({
      connectionString: options.connectionString,
      connectionTimeoutMillis: options.connectTimeoutMs,
      query_timeout: options.statementTimeoutMs,
      application_name: options.applicationName,
      max: 1,
      idleTimeoutMillis: options.transactionTimeoutMs,
    });
    registerDingTalkPreparedPort(this,{
      inspect: (context,plan)=>this.serializedDingTalkPrepared(() => this.inspectDingTalkPreparation(context,plan)),
      resolve: (context,decision)=>this.serializedDingTalkPrepared(() => this.resolveDingTalkPreparation(context,decision)),
    });
  }

  openSession(): AuthorityDatabaseSession {
    return new PgAuthorityDatabaseSession(this.options);
  }

  private connection(context: DatabaseRequestContext): Promise<PgClientPort> {
    if (this.closed) throw new DatabaseContractError("database request session is closed");
    if (this.connectionUnusable) throw new DatabaseContractError("database request session is unusable");
    if (!this.connectionPromise) {
      const startedAt = performance.now();
      try {
        // An open shard breaker refuses before any checkout or SQL is attempted.
        this.stats.connectivity.admit();
      } catch (error) {
        observePhase(this.options, context, this.stats, "pool_checkout", startedAt, error);
        throw error;
      }
      this.connectionPromise = this.pool.connect().then((client) => {
        observePhase(this.options, context, this.stats, "pool_checkout", startedAt);
        return client;
      }).catch((error) => {
        observePhase(this.options, context, this.stats, "pool_checkout", startedAt, error);
        this.connectionPromise = null;
        throw error;
      });
    }
    return this.connectionPromise;
  }

  async transaction<T>(
    rawContext: DatabaseRequestContext,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    const preparation=dingtalkPreparation(rawContext);
    const context = databaseRequestContext(rawContext);
    if (preparation && (context.statement || preparation.shardId!==this.options.shardId))
      throw new DatabaseContractError("prepared participant context does not match the selected database");
    if (context.placement && context.placement.shardId !== this.options.shardId) {
      throw new DatabaseContractError("placement shard does not match the selected database");
    }
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    const queuedAt = performance.now();
    await previous;
    const startedAt = performance.now();
    this.stats.startTransaction(context.operation, startedAt - queuedAt, queuedAt);
    try {
      const client = await this.connection(context);
      let began = false;
      try {
        if (preparation) await this.dingtalkPreparedIdentity(client,preparation);
        if (context.statement === "single_read") {
          return await callback(new PgSingleReadTransaction(client, context, this.options, this.stats,
            (stalled, failure, attempt) => this.retrySingleRead(context, stalled, failure, attempt)));
        }
        // A failed opening can leave its transaction block open. ROLLBACK
        // closes it; without one, PostgreSQL only answers with a warning.
        began = true;
        await this.open(client, context);
        const transaction=new PgDatabaseTransaction(client, context, this.options, this.stats);
        if (preparation) registerDingTalkPreparedTransaction(transaction,preparation);
        const value = await callback(transaction);
        const phaseStartedAt = performance.now();
        try {
          await client.query(preparation ? `PREPARE TRANSACTION '${preparation.gid}'` : "COMMIT");
          observePhase(this.options, context, this.stats, "commit", phaseStartedAt);
        } catch (commitError) {
          observePhase(this.options, context, this.stats, "commit", phaseStartedAt, commitError);
          if (!commitResultMayBeUnknown(commitError)) throw commitError;
          began = false;
          if (preparation) throw new DatabasePreparedUnknownError("prepare",preparation.gid,{ cause: commitError });
          throw new DatabaseCommitUnknownError(
            errorCode(commitError) === "database_error" ? null : errorCode(commitError),
            { cause: commitError },
          );
        }
        began = false;
        return value;
      } catch (error) {
        // A lost response leaves the driver query in flight. Queuing ROLLBACK
        // behind it can consume another full deadline and cannot prove cleanup.
        // The request owner closes the session, destroying this checkout.
        if (commitResultMayBeUnknown(error) || error instanceof DatabaseCommitUnknownError || error instanceof DatabasePreparedUnknownError) {
          this.connectionUnusable = true;
        }
        // Database failures were recorded where they happened; anything else
        // is the callback abandoning its transaction.
        this.stats.rolledBack = true;
        if (began && !this.connectionUnusable) {
          const phaseStartedAt = performance.now();
          await client.query("ROLLBACK").then(
            () => observePhase(this.options, context, this.stats, "rollback", phaseStartedAt),
            (rollbackError) => {
              this.connectionUnusable = true;
              observePhase(this.options, context, this.stats, "rollback", phaseStartedAt, rollbackError);
            },
          );
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  /**
   * The single retry of a timed-out single read. The stalled checkout still
   * has the query in flight, so it is destroyed, never reused or queued
   * behind; the retry takes a new checkout through the shard breaker, and an
   * open breaker or failed checkout surfaces the original timeout. The
   * session stays usable only if the retry succeeds.
   */
  private async retrySingleRead<T>(
    context: DatabaseRequestContext,
    stalled: PgClientPort,
    failure: unknown,
    attempt: (client: PgClientPort) => Promise<T>,
  ): Promise<T> {
    this.connectionPromise = null;
    stalled.release?.(true);
    let client: PgClientPort;
    try {
      client = await this.connection(context);
    } catch {
      this.connectionUnusable = true;
      throw failure;
    }
    try {
      return await attempt(client);
    } catch (error) {
      this.connectionUnusable = true;
      throw error;
    }
  }

  /** Prepared commands share the request session lifecycle with ordinary transactions. */
  private async serializedDingTalkPrepared<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) throw new DatabaseContractError("database request session is closed");
    const previous=this.transactionTail;
    let release!: () => void;
    this.transactionTail=new Promise<void>(resolve => { release=resolve; });
    await previous;
    try { return await run(); }
    catch(error) {
      if (commitResultMayBeUnknown(error) || error instanceof DatabasePreparedUnknownError) this.connectionUnusable=true;
      throw error;
    } finally { release(); }
  }

  private async dingtalkPreparedIdentity(client: PgClientPort,rawPlan: DingTalkPreparedPlan) {
    const plan=dingtalkPreparedPlan(rawPlan);
    const result=await client.query<{ shard_id: string; database_name: string; role_name: string }>({
      text: `SELECT shard_id,current_database() AS database_name,current_user AS role_name FROM control.postgres_local_identity`,
    });
    const row=result.rows[0];
    if (result.rows.length!==1 || row?.shard_id!==plan.shardId || plan.shardId!==this.options.shardId ||
      row.database_name!==plan.databaseName || row.role_name!==plan.roleName)
      throw new DatabaseContractError("prepared participant physical identity does not match");
    return plan;
  }
  private async inspectDingTalkPreparation(rawContext: DatabaseRequestContext,rawPlan: DingTalkPreparedPlan) {
    const context=databaseRequestContext(rawContext),client=await this.connection(context);
    const plan=await this.dingtalkPreparedIdentity(client,rawPlan);
    const result=await client.query<{ owner: string; database: string }>({
      text: "SELECT owner,database FROM pg_prepared_xacts WHERE gid=$1",values: [plan.gid],
    });
    if (!result.rows.length) return false;
    if (result.rows.length!==1 || result.rows[0]?.owner!==plan.roleName || result.rows[0]?.database!==plan.databaseName)
      throw new DatabaseContractError("prepared GID has a foreign owner or database");
    return true;
  }
  private async resolveDingTalkPreparation(rawContext: DatabaseRequestContext,decision: DingTalkPreparedDecision): Promise<"resolved" | "missing"> {
    const grant=dingtalkDecision(decision),context=databaseRequestContext(rawContext);
    if (!await this.inspectDingTalkPreparation(context,grant.plan)) return "missing";
    const client=await this.connection(context);
    try {await client.query(`${grant.outcome==='commit' ? 'COMMIT' : 'ROLLBACK'} PREPARED '${grant.plan.gid}'`);return "resolved";}
    catch (error) {
      if(commitResultMayBeUnknown(error)) {this.connectionUnusable=true;throw new DatabasePreparedUnknownError(grant.outcome,grant.plan.gid,{ cause: error });}
      // A second resolver can finish the same durable decision between inventory
      // inspection and resolution. The coordinator still needs its exact receipt.
      if (errorCode(error)==="42704") return "missing";
      throw error;
    }
  }

  /**
   * The opening round trip, observed as the transaction's `begin` phase. A
   * refused placement fence answered that round trip: it is a routing miss the
   * caller rolls back, not a database failure.
   */
  private async open(client: PgClientPort, context: DatabaseRequestContext): Promise<void> {
    const startedAt = performance.now();
    let admitted: boolean;
    try {
      admitted = await openTransaction(client, context, this.options);
    } catch (error) {
      observePhase(this.options, context, this.stats, "begin", startedAt, error);
      throw error;
    }
    observePhase(this.options, context, this.stats, "begin", startedAt);
    if (!admitted) refuseStalePlacement(this.options, context.placement!);
  }

  async health(context: DatabaseRequestContext): Promise<DatabaseHealth> {
    const normalizedContext = databaseRequestContext(context);
    const startedAt = performance.now();
    await this.transaction(normalizedContext, async (transaction) => {
      await transaction.query({
        name: "postgres_health_v1",
        text: "SELECT 1 AS healthy",
        maxRows: 1,
      });
    });
    return {
      ok: true,
      latencyMs: performance.now() - startedAt,
      shardId: this.options.shardId,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.transactionTail;
    const connection = this.connectionPromise
      ? await this.connectionPromise.catch(() => null)
      : null;
    connection?.release?.(this.connectionUnusable);
    await this.pool.end().catch(() => undefined);
    this.stats.connectivity.close();
    this.observeSession();
  }

  private observeSession(): void {
    const observer = this.options.sessionObserver;
    if (!observer || this.stats.operation === null) return;
    try {
      observer(Object.freeze(this.stats.observation(this.options.shardId, performance.now())));
    } catch {
      // Observation is deliberately non-authoritative and cannot fail a close.
    }
  }
}

class PgAuthorityDatabase implements AuthorityDatabase {
  readonly cacheMode = "disabled" as const;
  readonly placementHints: SpacePlacementHints | undefined;

  constructor(private readonly options: ResolvedOptions) {
    this.placementHints = options.placementHints;
  }

  openSession(): AuthorityDatabaseSession {
    return new PgAuthorityDatabaseSession(this.options);
  }

  async transaction<T>(
    context: DatabaseRequestContext,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    const session = this.openSession();
    try {
      return await session.transaction(context, callback);
    } finally {
      await session.close();
    }
  }

  async health(context: DatabaseRequestContext): Promise<DatabaseHealth> {
    const session = this.openSession();
    try {
      return await session.health(context);
    } finally {
      await session.close();
    }
  }
}

/**
 * Creates the sole correctness client. Its connection string must come from
 * the cache-disabled Hyperdrive binding; cached projections get a separate API.
 */
export function createAuthorityDatabase(options: AuthorityDatabaseOptions): AuthorityDatabase {
  return new PgAuthorityDatabase(resolveOptions(options));
}
