const MAX_BROWSER_WORKERS = 8;

/**
 * Leave capacity for the production Next server and trace/report finalization.
 * Browser contexts create renderer processes even when workers connect to one
 * BrowserServer, so exposing every logical CPU as a worker causes contention
 * and makes one shared-browser failure fan out across the matrix.
 */
export function browserWorkerCount(parallelism) {
  if (!Number.isSafeInteger(parallelism) || parallelism < 1) {
    throw new TypeError("parallelism must be a positive integer");
  }
  return Math.max(1, Math.min(MAX_BROWSER_WORKERS, Math.floor(parallelism * 0.75)));
}

/**
 * CI retries deterministic failures and can collect the useful trace then.
 * Recording every passing case makes the normal path continuously write and
 * discard 150+ traces and concentrates ZIP work at worker teardown.
 */
export function browserTraceMode(ci) {
  return ci ? "on-first-retry" : "retain-on-failure";
}
