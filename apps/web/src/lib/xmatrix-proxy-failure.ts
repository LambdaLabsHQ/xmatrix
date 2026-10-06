/**
 * A proxy hop can fail for reasons that have nothing to do with each other: the
 * Hub can be slow, the Hub connection can drop, or this Worker's own session
 * refresh can throw before any Hub request is made. Collapsing all three into
 * "xMatrix hub is unavailable right now." made every such report a misdiagnosis
 * — the phrase accuses a Hub that is usually answering other requests fine.
 *
 * Every Hub route handler returns its own error status, so reaching this
 * classifier always means the hop itself failed, never the Hub's business
 * logic. Name which hop, and say so in the response.
 */

export type ProxyFailureReason = "hub_timeout" | "hub_unreachable" | "session_refresh_failed";

export type ProxyFailure = {
  status: number;
  reason: ProxyFailureReason;
  error: string;
};

/** Thrown when authorization could not be resolved, before the Hub is called. */
export class ProxySessionRefreshError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ProxySessionRefreshError";
  }
}

function aborted(cause: unknown, timedOut: boolean): boolean {
  if (timedOut) return true;
  const name = cause instanceof Error ? cause.name : "";
  return name === "AbortError" || name === "TimeoutError";
}

export function classifyProxyFailure(input: {
  cause: unknown;
  /** The request's own AbortController fired, so this is our timeout budget. */
  timedOut: boolean;
}): ProxyFailure {
  if (input.cause instanceof ProxySessionRefreshError) {
    return {
      status: 503,
      reason: "session_refresh_failed",
      error: "Your xMatrix session could not be refreshed. Sign in again.",
    };
  }
  if (aborted(input.cause, input.timedOut)) {
    return {
      status: 504,
      reason: "hub_timeout",
      error: "xMatrix hub did not respond in time.",
    };
  }
  return {
    status: 503,
    reason: "hub_unreachable",
    error: "xMatrix hub is unavailable right now.",
  };
}

/**
 * The cause used to be discarded entirely, so a production report carried no
 * evidence at all. Log the hop and the cause — never the authorization header,
 * the cookies, or the body.
 */
export function logProxyFailure(input: {
  route: string;
  method: string;
  elapsedMs: number;
  failure: ProxyFailure;
  cause: unknown;
}): void {
  console.error("[xmatrix-proxy] upstream hop failed", {
    route: input.route,
    method: input.method,
    elapsedMs: input.elapsedMs,
    reason: input.failure.reason,
    status: input.failure.status,
    cause: input.cause instanceof Error
      ? `${input.cause.name}: ${input.cause.message}`
      : String(input.cause),
  });
}
