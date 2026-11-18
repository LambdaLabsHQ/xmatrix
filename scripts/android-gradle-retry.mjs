const RESOLUTION_FAILURE = new RegExp([
  "could not resolve plugin artifact",
  "Could not resolve all (?:artifacts|files|dependencies|task dependencies)",
  "Could not parse POM https?://",
].join("|"), "u");

export const GRADLE_ATTEMPTS = 3;
export const GRADLE_RETRY_DELAY_MS = 20_000;

/** A repository answering badly fails the build before any task runs; a failed test or lint does not match. */
export function isDependencyResolutionFailure(output) {
  return RESOLUTION_FAILURE.test(output);
}

/**
 * Runs Gradle until it passes, repeating only a failure to resolve dependencies.
 * `run({ refresh })` returns `{ status, output }`; a repeat asks for `refresh`,
 * so Gradle does not reuse what the failed attempt recorded about a repository.
 */
export async function runGradleWithRetry(run, {
  attempts = GRADLE_ATTEMPTS,
  delayMs = GRADLE_RETRY_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.warn,
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const { status, output } = await run({ refresh: attempt > 1 });
    if (status === 0 || attempt >= attempts || !isDependencyResolutionFailure(output)) return status;
    log(`Gradle could not resolve its dependencies (attempt ${attempt} of ${attempts}); trying again.`);
    await sleep(delayMs * attempt);
  }
}
