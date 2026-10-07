import { sanitizeMachineFailureDetail } from "./machine-failure-detail.js";

export interface PublicMachineStartupFailure {
  code: string;
  summary: string;
  action: string;
}

/** The code a `repo:` Run fails with when the Space's GitHub connection cannot
 * reach its repository: the token mint is refused (no or disconnected
 * connection, repository outside the installation, no such repository) or
 * GitHub refuses the clone or fetch. No launch pre-check stands in for it. */
export const REPOSITORY_ACCESS_UNAVAILABLE = "repository_access_unavailable";

const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;

/** The refusal text the Hub's repository-token mint answers with; the daemon
 * carries it verbatim into its startup failure. `reason` is a bounded code. */
export function repositoryAccessUnavailableDetail(repository: string, reason: string): string {
  const named = REPOSITORY_NAME.test(repository) ? repository : "the selected repository";
  return `${REPOSITORY_ACCESS_UNAVAILABLE}: the Space's GitHub connection cannot access ${named} (${reason.slice(0, 120)})`;
}

/** Preserve the originating diagnostic. Codes remain stable for consumers;
 * summaries are no longer substituted with a guessed cause or recovery step. */
export function publicMachineStartupFailure(detail: unknown): PublicMachineStartupFailure | undefined {
  if (typeof detail !== "string" || !detail.trim()) return undefined;
  const text = detail.toLowerCase();
  let code = "startup_failed";
  if (/\brepository_access_unavailable\b/u.test(text)) code = REPOSITORY_ACCESS_UNAVAILABLE;
  else if (/\bbase_ref_unresolved\b/u.test(text) || text.includes("could not resolve origin default branch")) code = "repository_base_unresolved";
  else if (/\bdisk_exhausted\b/u.test(text) || text.includes("no space left on device")) code = "machine_disk_full";
  else if (/\bfetch_required_failed\b/u.test(text)) code = "repository_fetch_failed";
  else if (text.includes("remote repo worktree unavailable") || text.includes("exceeded max fetch time") ||
    (text.includes("git fetch") && /stalled|timed out|timeout/u.test(text))) code = "remote_repo_fetch";
  else if (text.includes("is not accessible") || (text.includes("remote repository") && text.includes("not accessible"))) code = "remote_repo_access";
  return { code, summary: sanitizeMachineFailureDetail(detail), action: "" };
}
