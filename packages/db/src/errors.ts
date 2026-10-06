export class DatabaseContractError extends Error {
  readonly code = "database_contract_error";

  constructor(message: string) {
    super(message);
    this.name = "DatabaseContractError";
  }
}

/**
 * The shard's own placement fence refused a placed transaction before any of
 * its work ran: the placement the caller routed by is no longer current.
 */
export class DatabasePlacementStaleError extends DatabaseContractError {
  constructor(readonly spaceId: string) {
    super("local Space placement fence is stale");
    this.name = "DatabasePlacementStaleError";
  }
}

export class DatabaseRowLimitError extends Error {
  readonly code = "database_row_limit_exceeded";

  constructor(readonly queryName: string, readonly maxRows: number) {
    super(`Database query ${queryName} exceeded its ${maxRows}-row result bound`);
    this.name = "DatabaseRowLimitError";
  }
}

/** The connection failed while COMMIT was in flight, so the caller must reconcile by command id. */
export class DatabaseCommitUnknownError extends Error {
  readonly code = "database_commit_unknown";

  constructor(readonly driverCode: string | null, options?: { cause?: unknown }) {
    super("Database COMMIT result is unknown", options);
    this.name = "DatabaseCommitUnknownError";
  }
}

/** PREPARE or its later resolution can survive the connection that lost its response. */
export class DatabasePreparedUnknownError extends Error {
  readonly code = "database_prepared_unknown";
  constructor(readonly phase: "prepare" | "commit" | "abort",readonly gid: string,options?: { cause?: unknown }) {
    super(`Database prepared ${phase} result is unknown`,options);this.name="DatabasePreparedUnknownError";
  }
}
