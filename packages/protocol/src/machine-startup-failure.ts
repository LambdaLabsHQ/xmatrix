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

/** The code a Run fails with when its machine's daemon cannot find the
 * harness's launcher on the PATH the Run would get; the detail names the
 * program and its install. */
const HARNESS_MISSING = "harness_missing";

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
  // The daemon found the harness's launcher missing before starting anything.
  else if (/\bharness_missing\b/u.test(text)) code = HARNESS_MISSING;
  else if (/\bbase_ref_unresolved\b/u.test(text) || text.includes("could not resolve origin default branch")) code = "repository_base_unresolved";
  else if (/\bdisk_exhausted\b/u.test(text) || text.includes("no space left on device")) code = "machine_disk_full";
  else if (/\bfetch_required_failed\b/u.test(text)) code = "repository_fetch_failed";
  else if (text.includes("remote repo worktree unavailable") || text.includes("exceeded max fetch time") ||
    (text.includes("git fetch") && /stalled|timed out|timeout/u.test(text))) code = "remote_repo_fetch";
  else if (text.includes("is not accessible") || (text.includes("remote repository") && text.includes("not accessible"))) code = "remote_repo_access";
  return { code, summary: sanitizeMachineFailureDetail(detail), action: "" };
}

/** The phases a Run reports before its agent is ready, in their stored
 * (normalized) form: a process that ends in any of them never started, so its
 * end is a failed start, owed a notice and kept out of routing for a while.
 * A process found gone in `relay_registered` or `channel_joined` started no
 * more than one that died in `relay_registering`. */
export const RUN_PHASES_BEFORE_READY = [
  "wrapper_starting", "cwd_preparing", "cwd_ready", "auth_resolving", "workspace_registering",
  "relay_registering", "relay_register_retrying", "relay_auth_refresh_retrying", "relay_registered",
  "channel_joined", "channel_join_retrying", "runtime_starting", "wrapper_startup_failed",
] as const;

const PHASES_BEFORE_READY: ReadonlySet<string> = new Set(RUN_PHASES_BEFORE_READY);

/** Whether a reported phase, raw (`codex_app_starting`, `daemon_auth_refresh_failed`)
 * or stored, comes before the agent is ready. */
export function runPhaseBeforeReady(phase: string): boolean {
  return PHASES_BEFORE_READY.has(phase) || phase === "daemon_auth_refresh_failed" ||
    /^(codex|zcode|grok|acp)_app_starting$/u.test(phase);
}
