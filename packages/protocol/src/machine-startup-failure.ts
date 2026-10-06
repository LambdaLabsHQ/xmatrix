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

function repositoryAccessFailure(detail: string): PublicMachineStartupFailure {
  const named = /\brepository_access_unavailable: the Space's GitHub connection cannot access ([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}) /u
    .exec(detail)?.[1];
  const repository = named ?? "the selected repository";
  return { code: REPOSITORY_ACCESS_UNAVAILABLE,
    summary: `The Space's GitHub connection can't access ${repository}.`,
    action: `Check that the Space's GitHub app installation includes ${repository} and that GitHub is connected in the Space's Apps, then summon again.` };
}

/** Classify known daemon preparation errors without copying paths, commands or
 * credentials into Channel messages or public invocation diagnostics. */
export function publicMachineStartupFailure(detail: unknown): PublicMachineStartupFailure | undefined {
  if (typeof detail !== "string") return undefined;
  const text = detail.slice(0, 2_000).toLowerCase();
  if (/\brepository_access_unavailable\b/u.test(text)) return repositoryAccessFailure(detail.slice(0, 2_000));
  if (/\bbase_ref_unresolved\b/u.test(text) || text.includes("could not resolve origin default branch")) {
    return {
      code: "repository_base_unresolved",
      summary: "The selected repository has no usable default branch for the working directory. It may be empty.",
      action: "Push an initial commit and set its default branch, or summon again with repo:owner/repository pointing to an existing repository.",
    };
  }
  if (/\bdisk_exhausted\b/u.test(text) || text.includes("no space left on device")) {
    return { code: "machine_disk_full", summary: "The machine has insufficient disk space to prepare the working directory.",
      action: "Free disk space on the selected machine, then summon again." };
  }
  if (/\bfetch_required_failed\b/u.test(text)) {
    return { code: "repository_fetch_failed", summary: "The machine could not fetch the selected repository.",
      action: "Check the machine's network and repository access, then summon again." };
  }
  return undefined;
}
