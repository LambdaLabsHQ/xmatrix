/**
 * Which Run a machine's repository-token request speaks for.
 *
 * Without this binding the mint only proved that the machine's owner could see
 * the Channel. With it, a token is minted only for one live Run on that
 * machine, in that Channel. Which repository is the Run's to decide: a Run
 * checks out the repositories its work needs as it goes (`xmatrix repo
 * checkout`), and the Space's GitHub connection, checked on every mint, is
 * what decides which repositories exist for it.
 */
import { isActiveRunStatus } from "@xmatrix/protocol";
import type { MachineDaemonPrincipal } from "./connections/machine-daemon/auth";

export interface GitHubRepositoryTokenRunClaim {
  channelId: string;
  runId: string;
  executionKey: string;
  repository: { owner: string; repo: string };
}

/** Why a Run cannot have a token, or `undefined` when it can. */
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
  return isActiveRunStatus(run.status) ? undefined : "github_repository_token_run_not_live";
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
