import { xmatrixRawResponse } from "./query/api-client";

/** The web Worker route that forwards a browser defect to error reporting. */
export const CLIENT_DEFECT_ROUTE = "/api/client-defects";

/** One page reports at most this many distinct defects; the rest are the same bug again. */
const PAGE_BUDGET = 10;
const reported = new Set<string>();

/** A message keeps its shape and loses what it quoted: a response snippet, a name, a value. */
export function redactDefectMessage(message: string): string {
  return message.replace(/(["'`])(?:(?!\1)[^\n]){0,500}\1/gu, "$1…$1").slice(0, 300);
}

/**
 * Sends a browser defect — a failure `describeError` could only call
 * "something went wrong" — with what the person was doing, so it is found
 * without a screenshot. Never content: quoted text is redacted, no URL, no body.
 */
export function reportClientDefect(action: string, error: unknown): void {
  if (typeof window === "undefined" || reported.size >= PAGE_BUDGET) return;
  const name = error instanceof Error ? error.name : typeof error;
  const message = redactDefectMessage(error instanceof Error ? error.message : "");
  const key = `${action}\n${name}\n${message}`;
  if (reported.has(key)) return;
  reported.add(key);
  const stack = error instanceof Error ? (error.stack ?? "").split("\n").slice(1, 16).join("\n") : "";
  void xmatrixRawResponse(CLIENT_DEFECT_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, name, message, stack: stack.slice(0, 2_000) }),
    keepalive: true,
  }).catch(() => undefined);
}
