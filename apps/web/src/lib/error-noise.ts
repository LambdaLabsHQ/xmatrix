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

/** The visitor went away while the Web was still streaming the page: nothing on our side failed. */
export function isClientDisconnect(error: unknown): boolean {
  return error instanceof Error && error.message === "failed to pipe response" &&
    error.cause instanceof Error && error.cause.message === "Network connection lost.";
}
