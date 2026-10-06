// Shared GitHub Release upload policy for scripts/publish-github-release.mjs.
//
// Arithmetic for one ~130MB Desktop asset:
// - 0.55 MB/s (Air happy path) ≈ 227s
// - 0.20 MB/s (slow but above the 100KB/s stall floor) ≈ 650s
// Cap each attempt at 600s so a crawl cannot eat the whole Actions step.
// A true stall dies in 60s via --speed-time, then withRetry starts a new PUT.
// Six attempts are therefore ~6*60s when stalled, not 6*600s.
// Desktop publishes four large assets in one step: 4*227s ≈ 15 min happy path.
// timeout-minutes: 45 covers one 600s slow retry plus stall retries.

export const DEFAULT_UPLOAD_TIMEOUT_MS = 600_000;
export const DEFAULT_STALL_SPEED_LIMIT_BYTES = 102_400;
export const DEFAULT_STALL_SPEED_TIME_SECONDS = 60;

export function buildCurlUploadArgs({
  uploadUrl,
  assetPath,
  token,
  size,
  timeoutSeconds,
  speedLimitBytes,
  speedTimeSeconds,
}) {
  return [
    "--silent",
    "--show-error",
    "--location",
    "--http1.1",
    "--connect-timeout",
    "20",
    "--max-time",
    String(timeoutSeconds),
    "--speed-limit",
    String(speedLimitBytes),
    "--speed-time",
    String(speedTimeSeconds),
    "--request",
    "POST",
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    `Authorization: Bearer ${token}`,
    "--header",
    `Content-Length: ${size}`,
    "--header",
    "Content-Type: application/octet-stream",
    "--header",
    "X-GitHub-Api-Version: 2022-11-28",
    "--data-binary",
    `@${assetPath}`,
    "--write-out",
    "\n%{http_code}",
    uploadUrl,
  ];
}
