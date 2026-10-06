/**
 * Which Run a machine's repository-token request speaks for, and whether that
 * Run was launched into the repository it names.
 *
 * Without this binding the mint only proved that the machine's owner could see
 * the Channel: any member's machine could then mint a write token for any
 * repository of the Space's installations. With it, a token is minted only for
 * the repository the Hub itself admitted for one live Run on that machine.
 */
import { githubRepositoryReference, isActiveRunStatus } from "@xmatrix/protocol";
import type { MachineDaemonPrincipal } from "./connections/machine-daemon/auth";

export interface GitHubRepositoryTokenRunClaim {
  channelId: string;
  runId: string;
  executionKey: string;
  repository: { owner: string; repo: string };
}

/** Why a Run cannot have a token for this repository, or `undefined` when it can. */
export function githubRepositoryTokenRunRefusal(
  run: Record<string, unknown>,
  principal: Pick<MachineDaemonPrincipal, "machineId">,
  claim: GitHubRepositoryTokenRunClaim,
): string | undefined {
  const metadata = run.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata)
    ? run.metadata as Record<string, unknown> : {};
  if (run.channelId !== claim.channelId) return "github_repository_token_run_channel_mismatch";
  if (metadata.executionKey !== claim.executionKey) return "github_repository_token_run_execution_mismatch";
  if (typeof metadata.machineId !== "string" || metadata.machineId !== principal.machineId) {
    return "github_repository_token_run_machine_mismatch";
  }
  // A stopping Run still pushes its handoff branch before its stop is reported.
  if (!isActiveRunStatus(run.status)) return "github_repository_token_run_not_live";
  const launched = typeof metadata.remoteRepo === "string" ? githubRepositoryReference(metadata.remoteRepo) : undefined;
  if (!launched) return "github_repository_not_authorized_for_run";
  // GitHub names are case-insensitive, and Git reports the path as the remote
  // URL spells it.
  const same = launched.owner.toLowerCase() === claim.repository.owner.toLowerCase() &&
    launched.repo.toLowerCase() === claim.repository.repo.toLowerCase();
  return same ? undefined : "github_repository_not_authorized_for_run";
}

/**
 * Daemons released before the run binding send no Run. Until the minimum
 * supported CLI includes it, the committed config admits them with the earlier
 * channel-level check; unset (or anything but "true") refuses them.
 */
export function legacyUnboundRepositoryTokenEnabled(env: {
  GITHUB_REPOSITORY_TOKEN_LEGACY_UNBOUND_ENABLED?: string;
}): boolean {
  return env.GITHUB_REPOSITORY_TOKEN_LEGACY_UNBOUND_ENABLED === "true";
}
