import { defaultStackParser } from "@sentry/browser";
import { diagnosticStackFrame, isDiagnosticCode, type ClientDefectAction } from "@xmatrix/protocol";

import { diagnosticsMaySendNow } from "./diagnostics-preference";
import { xmatrixRawResponse } from "./query/api-client";

/** The web Worker route that forwards a browser defect to error reporting. */
export const CLIENT_DEFECT_ROUTE = "/api/client-defects";

/** One page reports at most this many distinct defects; the rest are the same bug again. */
const PAGE_BUDGET = 10;
const reported = new Set<string>();

/**
 * Sends a browser defect — a failure `describeError` could only call
 * "something went wrong" — with what the person was doing, so it is found
 * without a screenshot. Never content: the error is its class, its code when
 * it has one and its stack's code locations; what it said, a URL or a body
 * never leave (protocol diagnostic-events).
 */
export function reportClientDefect(action: ClientDefectAction, error: unknown): void {
  if (typeof window === "undefined" || reported.size >= PAGE_BUDGET) return;
  const name = error instanceof Error ? error.name : typeof error;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const stack = error instanceof Error ? browserDefectStack(error) : "";
  const key = `${action}\n${name}\n${String(code)}\n${stack}`;
  if (reported.has(key)) return;
  reported.add(key);
  const body = JSON.stringify({ action, name, ...(isDiagnosticCode(code) ? { code } : {}), stack });
  void diagnosticsMaySendNow().then((send) => send
    ? xmatrixRawResponse(CLIENT_DEFECT_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    })
    : undefined).catch(() => undefined);
}

/** Normalize browser frames for the Worker reporter's Node stack parser. */
function browserDefectStack(error: Error): string {
  const stack = error.stack ?? "";
  const frames = defaultStackParser(stack);
  if (frames.length) {
    return frames.slice(-15).reverse().map(diagnosticStackFrame).join("\n");
  }
  // An unparsed stack's lines may quote the message: none leave.
  return "";
}
