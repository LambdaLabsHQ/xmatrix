import { reportClientDefect } from "./client-defect-report";
import { XMatrixApiError, isTransientFailure } from "./query/api-client";

/**
 * The one translation from a failure to what a person reads
 * (docs/architecture/client-resilience.md, "Showing a failure"). Raw exception
 * text never reaches the screen: a browser or JavaScript error is a defect and
 * shows a generic sentence, a generic Hub rejection shows its category in plain
 * words, and only a specific Hub rejection shows the Hub's own reason, because
 * only the Hub knows what that domain rule means.
 */
export interface UserFacingError {
  /** The action that failed, then why and what to do: whole sentences. */
  message: string;
  /** Whether trying the same thing again can succeed. */
  retryable: boolean;
  /** The Hub's error code, for a person reporting the problem. */
  reference?: string;
  /** The Hub's report of this failure, which finds its log. */
  report?: string;
}

/**
 * A sentence written for a person by client code: a precondition the person can
 * fix ("Sign in before inviting members") or an outcome the client checked.
 * Any other Error is a defect, and its text stays in the console.
 */
export class UserFacingProblem extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "UserFacingProblem";
  }
}

/**
 * Codes the Hub uses for many unrelated rules; their messages are written for
 * developers, so the status category speaks instead. A body without a code
 * (a permission refusal, a route's own answer) keeps its sentence.
 */
const GENERIC_CODES = new Set([
  "forbidden", "not_authenticated", "conflict", "version_conflict",
  "idempotency_conflict", "idempotency_mismatch", "not_found", "internal_error",
]);

/** How Electron's `ipcRenderer.invoke` reports an error the desktop main process threw. */
const DESKTOP_IPC_ERROR = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?(.+)$/su;

const OFFLINE = "Check your connection and try again.";
const BUSY = "xMatrix is busy right now. Try again in a moment.";
const STILL_OFFLINE = "xMatrix still can't be reached after several tries. Check your connection.";
const STILL_UNAVAILABLE = "xMatrix is still unavailable after several tries. Try again later, and report it if it keeps happening.";
const DEFECT = "Something went wrong on our side. Try again, and report it if it keeps happening.";
const CLIENT_DEFECT = "Something went wrong. Try again, and report it if it keeps happening.";

/** Whether the failure is the caller ending its own request: not a failure to show. */
export function isAbort(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) &&
    (error.name === "AbortError" || error.name === "CancelledError");
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const capital = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?。！？]$/u.test(capital) ? capital : `${capital}.`;
}

function apiReason(error: XMatrixApiError): { reason: string; retryable: boolean } {
  if (error.persistent && isTransientFailure(error)) {
    return { reason: error.status === 0 ? STILL_OFFLINE : STILL_UNAVAILABLE, retryable: true };
  }
  if (error.status === 0) return { reason: OFFLINE, retryable: true };
  if (error.status === 504) return { reason: "xMatrix took too long to answer. Try again.", retryable: true };
  if (isTransientFailure(error)) return { reason: BUSY, retryable: true };
  if (error.status >= 500) return { reason: DEFECT, retryable: true };
  if (error.status === 401) return { reason: "Your session has ended. Sign in again.", retryable: false };
  if (!GENERIC_CODES.has(error.code) && readable(error)) return { reason: sentence(error.message), retryable: error.status === 409 };
  if (error.status === 403) return { reason: "You don't have permission to do this.", retryable: false };
  if (error.status === 404) return { reason: "It may have been deleted, or you no longer have access.", retryable: false };
  if (error.status === 409) return { reason: "It changed in the meantime. Refresh and try again.", retryable: true };
  if (error.status === 413) return { reason: "It is too large.", retryable: false };
  return { reason: readable(error) ? sentence(error.message) : DEFECT, retryable: false };
}

/** A Hub message that is a sentence, not a bare code or the transport's own placeholder. */
function readable(error: XMatrixApiError): boolean {
  const message = error.message.trim();
  return Boolean(message) && message !== error.code && !/^[a-z0-9_.-]+$/u.test(message) &&
    !/^Request failed \(\d+\)$/u.test(message);
}

/**
 * `action` names what failed as a sentence, such as "Couldn't load transfer
 * proposals". Returns null for a request its own caller cancelled.
 */
export function describeError(error: unknown, action: string): UserFacingError | null {
  if (error === null || error === undefined || isAbort(error)) return null;
  const headline = sentence(action);
  if (error instanceof XMatrixApiError) {
    const { reason, retryable } = apiReason(error);
    const reference = error.code !== "request_failed" ? error.code : error.status ? `HTTP ${error.status}` : undefined;
    return { message: `${headline} ${reason}`, retryable, ...(reference ? { reference } : {}),
      ...(error.reference ? { report: error.reference } : {}) };
  }
  if (error instanceof UserFacingProblem) {
    return { message: `${headline} ${sentence(error.message)}`, retryable: error.retryable };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { message: `${headline} xMatrix took too long to answer. Try again.`, retryable: true };
  }
  // The desktop app's main process words its refusals for people; Electron wraps them.
  const desktop = error instanceof Error ? DESKTOP_IPC_ERROR.exec(error.message) : null;
  if (desktop?.[1]) return { message: `${headline} ${sentence(desktop[1])}`, retryable: true };
  console.error(`[xmatrix] ${action}`, error);
  reportClientDefect(action, error);
  return { message: `${headline} ${CLIENT_DEFECT}`, retryable: true };
}

/** `describeError` as the one string a component keeps in state; null when nothing should show. */
export function userErrorMessage(error: unknown, action: string): string | null {
  return describeError(error, action)?.message ?? null;
}
