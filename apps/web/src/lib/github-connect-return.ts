/**
 * A GitHub connect returns through `/connect/github`, which keeps its outcome
 * and grant for this tab before opening the Space's Apps view; the app's
 * address canonicalization rewrites query strings, so they never travel there.
 */
const OUTCOME_KEY = "xmatrix:github-outcome";
const GRANT_KEY = "xmatrix:github-grant";
const RETURN_KEY = "xmatrix:github-return";

export const GITHUB_CONNECT_OUTCOMES = ["connected", "updated", "authorized", "pending", "failed", "cancelled"] as const;
export type GitHubConnectOutcome = (typeof GITHUB_CONNECT_OUTCOMES)[number];

export function keepGitHubConnectReturn(outcome: GitHubConnectOutcome, grant: string | null): void {
  window.sessionStorage.setItem(OUTCOME_KEY, outcome);
  if (grant) window.sessionStorage.setItem(GRANT_KEY, grant);
}

/** The outcome of the connect that just returned, read once. */
export function takeGitHubConnectOutcome(): GitHubConnectOutcome | undefined {
  const outcome = window.sessionStorage.getItem(OUTCOME_KEY);
  window.sessionStorage.removeItem(OUTCOME_KEY);
  return GITHUB_CONNECT_OUTCOMES.find((known) => known === outcome);
}

/** The installations GitHub confirmed for this tab's latest connect; the Hub checks it is still valid. */
export function readGitHubGrant(): string | undefined {
  return window.sessionStorage.getItem(GRANT_KEY) ?? undefined;
}

/** Where in the app a connect started from outside Apps, to come back to once GitHub is connected. */
export function keepGitHubReturnPath(path: string): void {
  window.sessionStorage.setItem(RETURN_KEY, path);
}

/** That path, read once; only an app path, and only when nothing is left to do in Apps. */
export function takeGitHubReturnPath(outcome: GitHubConnectOutcome): string | undefined {
  const path = window.sessionStorage.getItem(RETURN_KEY);
  window.sessionStorage.removeItem(RETURN_KEY);
  if (outcome !== "connected" && outcome !== "updated") return undefined;
  return path && /^\/app\/[^/]/u.test(path) && !path.startsWith("//") ? path : undefined;
}
