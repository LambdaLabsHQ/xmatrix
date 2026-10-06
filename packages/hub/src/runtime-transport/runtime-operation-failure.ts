import { ControlError } from "@xmatrix/db";

import { retryablePostgresFailure } from "../postgres-error-classification";
import { safeServerDiagnosticId } from "../server-error-diagnostic";

import type { RuntimeOperationFailure } from "@xmatrix/protocol";
export type { RuntimeOperationFailure } from "@xmatrix/protocol";
// `run_not_found` is as safe to publish as the `not_found` beside it — "that
// run is gone, or was never yours" carries no authority detail — and the
// Machine Daemon needs it by name: with the code rewritten to the generic
// `runtime.authority_rejected`, the daemon cannot tell a dead run from a
// transient failure and re-sends its exit report forever.
const PUBLIC_CODES = new Set([
  "conflict", "forbidden", "not_found", "channel_not_found", "run_not_found", "agent_run_forbidden",
  "invalid_runtime_request", "postgres_runtime_unavailable", "postgres_runtime_internal_error",
  "runtime_transaction_retry_exhausted", "runtime_sql_contract_error",
  "request_expired", "request_not_found", "request_already_decided", "request_machine_mismatch", "secret_not_found",
  "secret_not_admitted",
  "invalid_remember_policy", "persistent_secret_approval_forbidden", "unsafe_request_prefix",
  "request_context_unavailable", "request_context_mismatch", "machine_offline",
  "machine_command_stale_lease", "machine_command_lease_required", "machine_command_not_leased",
]);
// The authority already holds a fact under this command or message id. The
// caller learns its id is taken; the Hub has not failed.
const COMMITTED_IDENTITY_CONFLICT_CODES = new Set(["idempotency_conflict", "message_exists"]);

/** Keeps safe classification across an authority rejection without copying its body. */
export class RuntimeAuthorityOperationError extends Error {
  readonly failure: RuntimeOperationFailure;
  /** A 409 saying the command or message id is already committed. */
  readonly committedIdentityConflict: boolean;
  constructor(operation: string, status: number, body: unknown) {
    super(`PostgreSQL rejected ${operation} (${status})`);
    const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const code = typeof value.code === "string" && PUBLIC_CODES.has(value.code)
      ? value.code : "runtime.authority_rejected";
    this.failure = { code, diagnosticId: safeServerDiagnosticId(value.diagnosticId) ?? `diag_${crypto.randomUUID()}`,
      retryable: value.retryable === true && (status === 503 || status === 429),
      stage: "authority.request" };
    this.committedIdentityConflict = status === 409 && typeof value.code === "string" &&
      COMMITTED_IDENTITY_CONFLICT_CODES.has(value.code);
    // The originating authority owns its private details. Correlation here is
    // intentionally free of response bodies, SQL, credentials and payloads.
    (this.committedIdentityConflict ? console.warn : console.error)(
      "xMatrix runtime authority rejection", { ...this.failure, operation, status });
  }
}

/**
 * A repository rejection or database outage met on a socket, classified as the
 * authority rejection it is: its own code when that is public, retryable only
 * for an outage.
 */
function authorityOperationError(error: unknown): RuntimeAuthorityOperationError | undefined {
  if (error instanceof RuntimeAuthorityOperationError) return error;
  if (error instanceof ControlError) {
    const body = { code: error.code, retryable: error.retryable };
    return Object.hasOwn(APPROVAL_MESSAGES, error.code)
      ? new RuntimeApprovalOperationError(error.name, error.status, body)
      : new RuntimeAuthorityOperationError(error.name, error.status, body);
  }
  if (retryablePostgresFailure(error)) {
    return new RuntimeAuthorityOperationError("postgres", 503, { code: "postgres_runtime_unavailable", retryable: true });
  }
  return undefined;
}

export function runtimeOperationFailure(error: unknown): RuntimeOperationFailure {
  if (error instanceof RuntimeClientOperationError) return error.failure;
  const rejected = authorityOperationError(error);
  if (rejected) return rejected.failure;
  const failure = { code: "runtime.session_failed", diagnosticId: `diag_${crypto.randomUUID()}`,
    retryable: false, stage: "runtime.session" };
  // Where it was thrown, never what it said: an unclassified error's message
  // may carry request data, so the log keeps only its class and call sites.
  console.error("xMatrix runtime session failure", { ...failure, ...runtimeFailureOrigin(error) });
  return failure;
}

/** The error's class and its innermost function names: code locations only. */
export function runtimeFailureOrigin(error: unknown): { errorClass: string; origin: string[] } {
  const errorClass = error instanceof Error && /^[A-Za-z_$][\w$]{0,79}$/u.test(error.constructor.name)
    ? error.constructor.name : typeof error;
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  const origin = stack.split("\n").slice(1)
    .map((line) => /^\s*at (?:async )?([A-Za-z_$][\w$.<>]{0,119}) \(/u.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
    .slice(0, 4);
  return { errorClass, origin };
}

const CLIENT_FAILURES = {
  machine_activation_fenced: ["This Workstation is still recovering and is fenced from new work until activation is confirmed.", "daemon.activation"],
  machine_activation_context_required: ["Machine Daemon activation requires a recovering connection", "daemon.activation"],
  machine_delivery_binding_stale: ["Machine Daemon delivery binding is stale; reconnect required", "daemon.delivery"],
  machine_credential_mismatch: ["Machine Daemon credential does not match its enrolled identity", "daemon.authenticate"],
  channel_access_changed: ["You no longer have access to this Channel", "authority.access"],
  human_auth_invalid: ["Your sign-in expired or is not valid here. Sign in again.", "relay.authenticate"],
  human_rate_limited: ["Too many connections from this account. Reconnecting shortly.", "relay.authenticate"],
  agent_run_credential_required: ["An Agent Instance run credential is required", "relay.authenticate"],
  agent_run_binding_mismatch: ["Agent credential does not match the live Authority run", "relay.validate_binding"],
  agent_run_not_live: ["The Agent Run is no longer active. Refresh its status before retrying.", "relay.validate_binding"],
  agent_instance_not_live: ["The Agent Instance is no longer active. Refresh its status before retrying.", "relay.validate_binding"],
  agent_connection_superseded: ["Agent Instance connection was superseded; reconnect required", "relay.replace_connection"],
  agent_delivery_binding_stale: ["Agent Instance live delivery binding is stale; reconnect required", "relay.bind_delivery"],
  agent_channel_scope_mismatch: ["Agent Instance operation is outside its run-bound channel", "authority.access"],
  agent_read_only_session: ["Channel About sessions cannot write Channel messages", "authority.access"],
  management_activation_changed: ["Management activation no longer matches the current configuration. Start a new authorized activation.", "relay.validate_binding"],
  invalid_agent_message_fields: ["Agent message contains unsupported fields", "request.validate"],
  invalid_channel_activity: ["Channel activity report is malformed", "request.validate"],
} as const;

/** Only an owning boundary may choose this finite code; no exception text is public copy. */
export class RuntimeClientOperationError extends Error {
  readonly failure: RuntimeOperationFailure;
  readonly publicMessage: string;
  constructor(code: keyof typeof CLIENT_FAILURES) {
    const [message, stage] = CLIENT_FAILURES[code];
    super(message);
    this.publicMessage = message;
    this.failure = { code, stage, diagnosticId: `diag_${crypto.randomUUID()}`, retryable: false };
    // An expired sign-in or a redial over the limit is the client's ordinary state, not a Hub fault.
    (code === "human_auth_invalid" || code === "human_rate_limited" ? console.warn : console.error)(
      "xMatrix runtime product rejection", this.failure);
  }
}

const APPROVAL_MESSAGES: Record<string, string> = {
  secret_not_found: "A required secret has not been saved. Refresh the approval card, enter and save its secret value, then approve again.",
  secret_not_admitted: "This Agent's registration no longer allows a requested secret. Ask the agent to submit the request again; approving it admits the secret.",
  request_expired: "This approval request expired after 10 minutes. Ask the agent to submit a new request.",
  request_not_found: "This approval request is no longer available. Ask the agent to submit a new request.",
  request_already_decided: "This request has already been approved or denied. Check its latest status in the channel.",
  request_machine_mismatch: "This request belongs to a different Workstation. Open the original request card.",
  invalid_remember_policy: "This approval option is invalid. Refresh the request card and try again.",
  persistent_secret_approval_forbidden: "Requests with secrets can only be approved once or for this instance.",
  unsafe_request_prefix: "This command cannot use a remembered prefix. Choose Once or Remember exact.",
  request_context_unavailable: "The matching live instance or complete request context is unavailable. Ask the agent to submit a new request.",
  request_context_mismatch: "The request no longer matches its live instance. Ask the agent to submit a new request.",
  machine_command_stale_lease: "The command lease is stale or no longer held by this Workstation. Refresh its command status before retrying.",
  machine_command_lease_required: "This command requires its current lease. Refresh the Workstation connection before retrying.",
  machine_command_not_leased: "This command is no longer leased. It may already be complete; check its recorded status.",
  machine_offline: "The Workstation is offline. Reconnect it and check the original request's status.",
};

/** The copy a socket client sees for a failure: its approval or client message, else the fallback. */
export function runtimeOperationMessage(error: unknown, fallback: string): string {
  if (error instanceof RuntimeClientOperationError) return error.publicMessage;
  const rejected = authorityOperationError(error);
  return rejected instanceof RuntimeApprovalOperationError ? rejected.publicMessage : fallback;
}

/** Retains the existing approval copy through the same typed socket boundary. */
export class RuntimeApprovalOperationError extends RuntimeAuthorityOperationError {
  readonly publicMessage: string;
  constructor(operation: string, status: number, body: Record<string, unknown>) {
    const known = typeof body.code === "string" && Object.hasOwn(APPROVAL_MESSAGES, body.code);
    super(operation, status, known ? body : {});
    const code = known ? body.code as string : "runtime.authority_rejected";
    const retryable = typeof body.retryable === "boolean" ? String(this.failure.retryable) : "unknown";
    this.publicMessage = `${known ? APPROVAL_MESSAGES[code] : "The Workstation request could not be processed."} (code=${code}, retryable=${retryable}, status=${status})`;
  }
}

export type RuntimeFailureStage = "relay.authenticate" | "relay.validate_binding" |
  "relay.replace_connection" | "relay.send_confirmation" | "relay.bind_delivery" | "relay.publish_presence";
