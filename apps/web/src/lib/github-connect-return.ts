/**
 * A GitHub connect returns through `/connect/github`, which keeps its outcome
 * and grant for this tab before opening the Space's Apps view; the app's
 * address canonicalization rewrites query strings, so they never travel there.
 */
const OUTCOME_KEY = "xmatrix:github-outcome";
const GRANT_KEY = "xmatrix:github-grant";

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
