import { defaultStackParser } from "@sentry/browser";

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
  const stack = error instanceof Error ? browserDefectStack(error) : "";
  void xmatrixRawResponse(CLIENT_DEFECT_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, name, message, stack: stack.slice(0, 2_000) }),
    keepalive: true,
  }).catch(() => undefined);
}

/** Normalize browser frames for the Worker reporter's Node stack parser. */
function browserDefectStack(error: Error): string {
  const stack = error.stack ?? "";
  const frames = defaultStackParser(stack);
  if (frames.length) {
    return frames.slice(-15).reverse().map(frame =>
      `    at ${frame.function ?? "<anonymous>"} (${frame.filename ?? "<unknown>"}:${frame.lineno ?? 0}:${frame.colno ?? 0})`,
    ).join("\n");
  }
  // Some browsers omit the message header; do not delete their first frame.
  const header = error.message ? `${error.name}: ${error.message}` : error.name;
  const body = stack === header ? "" : stack.startsWith(header + "\n") ? stack.slice(header.length + 1) : stack;
  return body.split("\n").slice(0, 15).join("\n");
}
