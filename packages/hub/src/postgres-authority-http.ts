import { utf8ByteLength } from "@xmatrix/protocol";
import { ControlError, createAuthorityDatabase, type AuthorityDatabase } from "@xmatrix/db";

import { domainFailure, failureResponse, type DomainError } from "./error-contract";
import { POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS } from "./postgres-message-database-policy";
import { postgresDatabaseObservers } from "./postgres-observability";

/** Product facts are per-principal; no PostgreSQL authority answer may be cached. */
export const POSTGRES_AUTHORITY_HEADERS = { "cache-control": "private, no-store" } as const;

/**
 * Budgets shared by request-scoped authorities. Checkout uses the message-path
 * Hyperdrive wait: the 3s driver default destroys the socket under contention
 * (`Connection terminated due to connection timeout`) before the origin answers.
 */
export const POSTGRES_AUTHORITY_TIMEOUTS = {
  connectTimeoutMs: POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS,
  statementTimeoutMs: 5_000,
  transactionTimeoutMs: 10_000,
  lockTimeoutMs: 2_000,
} as const;

export interface PostgresAuthorityBindingEnv {
  RELAY_POSTGRES?: { connectionString: string };
  RELAY_POSTGRES_SHARD_ID?: string;
}

export function postgresAuthorityJson(value: unknown, status?: number): Response {
  return Response.json(value, {
    ...(status === undefined ? {} : { status }),
    headers: POSTGRES_AUTHORITY_HEADERS,
  });
}

/** A domain control error already carries its public status, retry policy and any details. */
export function postgresControlErrorResponse(error: DomainError, extra: Record<string, unknown> = {}): Response {
  return failureResponse(domainFailure(error, extra));
}

/** A domain rejection answered with its own status; anything else is rethrown as unexpected. */
export function controlErrorResponse(error: unknown): Response {
  if (error instanceof ControlError) return postgresControlErrorResponse(error);
  throw error;
}

/** Narrows a JSON body to an object, or throws the domain's own invalid-request error. */
export function postgresRequestObject(value: unknown, invalid: () => Error): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

/** Trimmed, non-empty text within an optional UTF-8 byte budget. */
export function postgresRequestText(value: unknown, invalid: () => Error, maximumBytes = Infinity): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || utf8ByteLength(result) > maximumBytes) throw invalid();
  return result;
}

/** Principal kind validation shared by fact adapters; each domain owns its error and id rules. */
export function postgresPrincipalKind(value: unknown, invalid: () => Error): "user" | "agent" {
  if (value !== "user" && value !== "agent") throw invalid();
  return value;
}

/** Legacy optional identifiers distinguish an absent/empty value from malformed text. */
export function postgresOptionalRequestText(value: unknown, invalid: () => Error, maximumBytes = Infinity): string {
  return value === undefined || value === "" ? "" : postgresRequestText(value, invalid, maximumBytes);
}

/**
 * Both bindings are required even when a database is injected, so a worker
 * missing them fails closed instead of silently routing elsewhere.
 */
export function postgresAuthorityShardId(env: PostgresAuthorityBindingEnv, authority: string): string {
  const connectionString = env.RELAY_POSTGRES?.connectionString;
  const shardId = env.RELAY_POSTGRES_SHARD_ID?.trim();
  if (!connectionString || !shardId) throw new Error(`PostgreSQL ${authority} bindings are unavailable`);
  return shardId;
}

/** Directory-shard database for authorities that never route by Space placement. */
export function postgresAuthorityDatabase(
  env: PostgresAuthorityBindingEnv,
  authority: string,
  applicationName: string,
  database?: AuthorityDatabase,
): AuthorityDatabase {
  const shardId = postgresAuthorityShardId(env, authority);
  return database ?? createAuthorityDatabase({
    ...postgresDatabaseObservers(env),
    connectionString: env.RELAY_POSTGRES!.connectionString,
    shardId,
    applicationName,
    ...POSTGRES_AUTHORITY_TIMEOUTS,
  });
}
