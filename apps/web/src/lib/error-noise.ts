/**
 * A deploy replaced the scripts this page was built against; only a reload fetches the new ones.
 * Besides a failed chunk fetch, webpack's own runtime can find a module id the loaded chunks no
 * longer define, and then fails calling it.
 */
export function isStaleBuild(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" ||
    /Loading (?:CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module/u.test(error.message) ||
    (error instanceof TypeError && /reading 'call'/u.test(error.message) && /\/chunks\/webpack-/u.test(error.stack ?? ""));
}

/** Browser notices that are not page failures: ResizeObserver dropped a layout pass and will run it next frame. */
export function isBrowserNotice(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/u.test(message);
}

/**
 * Whether a report is a browser notice. The browser raises ResizeObserver's
 * notice as an error event without an Error, so Sentry's global handler
 * passes `null` as the original exception and builds the report from the
 * message alone (XMATRIX-WEB-7). Read the report's own exception too.
 */
export function isBrowserNoticeReport(originalException: unknown,
  event: { exception?: { values?: readonly { value?: string }[] } }): boolean {
  return isBrowserNotice(originalException) || isBrowserNotice(event.exception?.values?.[0]?.value);
}

/**
 * Where an error fired before reporting had loaded. The browser puts the
 * script on the event, not on a SyntaxError's stack (XMATRIX-WEB-10, XMATRIX-WEB-11).
 * A query or fragment can carry a one-time code, so neither is kept.
 */
export function earlyScriptLocation(source: { filename?: string; lineno?: number; colno?: number }): {
  script?: string;
  line?: number;
  column?: number;
} {
  const raw = typeof source.filename === "string" ? source.filename.replace(/[?#].*$/u, "").slice(0, 300) : "";
  const line = Number.isInteger(source.lineno) && (source.lineno ?? 0) > 0 ? source.lineno : undefined;
  const column = Number.isInteger(source.colno) && (source.colno ?? 0) > 0 ? source.colno : undefined;
  return {
    ...(raw ? { script: raw } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

/** The visitor went away while the Web was still streaming the page: nothing on our side failed. */
export function isClientDisconnect(error: unknown): boolean {
  return error instanceof Error && error.message === "failed to pipe response" &&
    error.cause instanceof Error && error.cause.message === "Network connection lost.";
}
