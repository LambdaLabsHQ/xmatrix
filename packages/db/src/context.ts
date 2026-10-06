import { utf8ByteLength } from "@xmatrix/protocol";
const MAX_REQUEST_ID_BYTES = 200;
const MAX_OPERATION_BYTES = 160;
const MAX_SCOPE_ID_BYTES = 300;

export interface DatabasePlacementContext {
  spaceId: string;
  shardId: string;
  placementEpoch: number;
}

export interface DatabaseRequestContext {
  requestId: string;
  operation: string;
  placement?: DatabasePlacementContext;
  isolation?: "serializable";
  /**
   * The callback issues exactly one bounded, lock-free read. It then runs as
   * one statement in its own implicit transaction: a single round trip with no
   * BEGIN or COMMIT. Never valid with isolation. With placement, the same
   * statement takes and checks the Space placement fence before its rows are
   * admitted, exactly as a placed transaction's first round trip does.
   */
  statement?: "single_read";
}

export class InvalidDatabaseContextError extends Error {
  readonly code = "invalid_database_context";

  constructor(message: string) {
    super(message);
    this.name = "InvalidDatabaseContextError";
  }
}

function boundedText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new InvalidDatabaseContextError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || utf8ByteLength(normalized) > maxBytes) {
    throw new InvalidDatabaseContextError(`${field} is invalid`);
  }
  return normalized;
}

export function databaseRequestContext(input: DatabaseRequestContext): DatabaseRequestContext {
  const requestId = boundedText(input.requestId, "requestId", MAX_REQUEST_ID_BYTES);
  const operation = boundedText(input.operation, "operation", MAX_OPERATION_BYTES);
  if (input.isolation !== undefined && input.isolation !== "serializable") {
    throw new InvalidDatabaseContextError("isolation is invalid");
  }
  const isolation = input.isolation ? { isolation: input.isolation } : {};
  if (input.statement !== undefined) {
    if (input.statement !== "single_read") {
      throw new InvalidDatabaseContextError("statement is invalid");
    }
    if (input.isolation) {
      throw new InvalidDatabaseContextError("a single read cannot carry isolation");
    }
    if (!input.placement) return Object.freeze({ requestId, operation, statement: input.statement });
  } else if (!input.placement) return Object.freeze({ requestId, operation, ...isolation });

  const placement = Object.freeze({
    spaceId: boundedText(input.placement.spaceId, "spaceId", MAX_SCOPE_ID_BYTES),
    shardId: boundedText(input.placement.shardId, "shardId", MAX_SCOPE_ID_BYTES),
    placementEpoch: input.placement.placementEpoch,
  });
  if (!Number.isSafeInteger(placement.placementEpoch) || placement.placementEpoch < 1) {
    throw new InvalidDatabaseContextError("placementEpoch must be a positive safe integer");
  }
  const statement = input.statement ? { statement: input.statement } : {};
  return Object.freeze({ requestId, operation, placement, ...isolation, ...statement });
}
