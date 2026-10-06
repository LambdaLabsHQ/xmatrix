/**
 * A cancelled Agent turn is already reported as a system notice in its Channel.
 * It is not a failure to load the Channel catalog, so do not repeat the raw
 * runtime wording in the catalog sidebar.
 */
export function channelSidebarError(error: string | null): string | null {
  if (!error) return null;
  return isTurnCancellationMessage(error) ? null : error;
}

function isTurnCancellationMessage(error: string): boolean {
  return /^(?:the\s+)?user\s+(?:aborted|canceled|cancelled)\s+(?:a\s+|the\s+)?(?:request|turn)\.?$/iu.test(
    error.trim(),
  );
}
