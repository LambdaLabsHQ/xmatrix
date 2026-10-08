import { ControlError, DetailedControlError } from "@xmatrix/db";

import { DURABLE_OBJECT_RETRY_AFTER_SECONDS, transientDurableObjectFailure } from "./durable-object-failure";
import { postgresRetryAfterSeconds, retryablePostgresFailure } from "./postgres-error-classification";

/**
 * The Hub's one contract for answering a failure (docs/architecture/client-resilience.md):
 * a transient failure is `503 { error, code, retryable: true }` with `Retry-After`;
 * anything else keeps its own status and says `retryable: false`.
 */
export interface RequestFailure {
  status: number;
  body: { error: string; code?: string; retryable?: boolean; [field: string]: unknown };
  headers: Record<string, string>;
}

/** A typed domain rejection: its public status and code, and whether a replay can succeed. */
export interface DomainError {
  message: string;
  code: string;
  status: number;
  retryable?: boolean;
}

const NO_STORE = { "cache-control": "private, no-store" } as const;

/**
 * A part of the Hub that is briefly unavailable (a coordinator, a session, a
 * clock or a deadline met in passing): a retryable 503 whose `Retry-After` is
 * `retryAfterMs`. Throw it; `domainFailure` answers it on every route and socket.
 */
export class ServiceUnavailable extends ControlError {
  constructor(code: string, message: string,
    readonly retryAfterMs = DURABLE_OBJECT_RETRY_AFTER_SECONDS * 1_000) {
    super(code, 503, message, true);
  }
}

/** A domain rejection under its own status and code; a retryable 503 also says when to replay. */
export function domainFailure(error: DomainError, extra: Record<string, unknown> = {}): RequestFailure {
  const retryable = error.retryable === true;
  const details = error instanceof DetailedControlError && error.details ? { details: error.details } : {};
  return {
    status: error.status,
    body: { error: error.message, code: error.code, retryable, ...details, ...extra },
    headers: retryable && error.status === 503
      ? { ...NO_STORE, "retry-after": String(postgresRetryAfterSeconds(error)) } : { ...NO_STORE },
  };
}

/** Whether a failure is a Durable Object or PostgreSQL outage a replay can survive. */
export function transientError(error: unknown): boolean {
  return transientDurableObjectFailure(error) || retryablePostgresFailure(error);
}

/** A Durable Object or PostgreSQL outage a replay can survive, or null when the failure is not one. */
export function transientFailure(error: unknown): RequestFailure | null {
  if (transientDurableObjectFailure(error)) {
    console.error("Durable Object is briefly unavailable", error);
    return { status: 503, body: { error: "xMatrix is restarting; try again", code: "service_restarting", retryable: true },
      headers: { "retry-after": String(DURABLE_OBJECT_RETRY_AFTER_SECONDS) } };
  }
  if (retryablePostgresFailure(error)) {
    console.error("PostgreSQL is unavailable", error);
    return { status: 503, body: { error: "PostgreSQL is unavailable", code: "postgres_unavailable", retryable: true },
      headers: { "retry-after": String(postgresRetryAfterSeconds(error)) } };
  }
  return null;
}

export function failureResponse(failure: RequestFailure, headers: Record<string, string> = {}): Response {
  return Response.json(failure.body, { status: failure.status, headers: { ...failure.headers, ...headers } });
}
