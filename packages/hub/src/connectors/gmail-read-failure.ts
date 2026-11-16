import { reportError } from "@xmatrix/protocol/error-reporting";
import { serverCodeFailure } from "../server-code-failure";
import { ProviderRequestError } from "./http";

const PHASES = ["configuration", "message", "external_body", "format"] as const;
const KINDS = ["http_status", "response_too_large", "proxy_contract", "provider_status", "message_contract",
  "timeout", "aborted", "unclassified"] as const;
type Phase = typeof PHASES[number];
// Attach phase without replacing the error manual reads already return or retaining failed mail.
const phases = new WeakMap<object, Phase>();

export async function gmailReadPhase<T>(phase: Phase, read: () => T | Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error && typeof error === "object") phases.set(error, phase);
    throw error;
  }
}

/** Mail/provider text may contain secrets. Report one fixed diagnosis and only deployed code frames. */
export function reportGmailAutoReadFailure(error: unknown): void {
  const phase = error && typeof error === "object" ? phases.get(error) ?? "configuration" : "configuration";
  const kind = error instanceof ProviderRequestError ? error.failureKind
    : error instanceof Error && error.name === "TimeoutError" ? "timeout"
    : error instanceof Error && error.name === "AbortError" ? "aborted" : "unclassified";
  const status = error instanceof ProviderRequestError && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
    ? String(error.status) : "unavailable";
  reportError(serverCodeFailure(error, "GmailAutoReadFailure", `Gmail automatic read failed (${phase}; ${kind}; ${status})`), {
    operation: "gmail.auto_read", fingerprint: ["gmail-auto-read", phase, kind, status],
    ids: { gmail_read_phase: phase, gmail_read_kind: kind, gmail_read_status: status },
  });
  console.warn("Gmail automatic read failed", { phase, kind, status });
}

/** A Sentry event is untrusted; expose only the finite diagnosis this boundary emits. */
export function gmailReadFailureMetadata(extra: Record<string, unknown>): string[] {
  const { gmail_read_phase: phase, gmail_read_kind: kind, gmail_read_status: status } = extra;
  if (!PHASES.some(value => value === phase) || !KINDS.some(value => value === kind) ||
      typeof status !== "string" || status !== "unavailable" && !/^[1-5]\d\d$/u.test(status)) return [];
  return [`Gmail automatic read failure: ${phase} · ${kind} · status=${status}`];
}

/**
 * A notification pass that failed and will be retried. The pass used to fail
 * silently on every retry, so a mailbox stopped notifying for days unseen.
 * Only the error's class, authority code and status are reported, never its text.
 */
export function reportGmailNotificationFailure(error: unknown): void {
  const kind = error instanceof Error && /^[A-Za-z]{1,60}$/u.test(error.name) ? error.name : "unclassified";
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
    /^[a-z_]{1,60}$/u.test(error.code) ? error.code : "none";
  const raw = error && typeof error === "object" && "status" in error ? Number(error.status) : NaN;
  const status = Number.isInteger(raw) && raw >= 100 && raw <= 599 ? String(raw) : "unavailable";
  reportError(serverCodeFailure(error, "GmailNotificationFailure", `Gmail notification pass failed (${kind}; ${code}; ${status})`), {
    operation: "gmail.notification", fingerprint: ["gmail-notification", kind, code, status],
    ids: { gmail_notification_kind: kind, gmail_notification_code: code, gmail_notification_status: status },
  });
  console.warn("Gmail notification pass failed", { kind, code, status });
}
