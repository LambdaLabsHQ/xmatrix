import type { LaunchTargetRepo, LaunchTargetRepoStatus } from "@xmatrix/protocol";
import { spaceLaunchTargetRepositories } from "./app-connectors";
import type { Env } from "./types";
import { connectionUseRefused, getAppConnection } from "./apps";
import type { AppConnectorConnectionView } from "./app-connectors";

/**
 * A Space's repo launch targets, re-resolved on every read: a disconnected or
 * revoked connector stops offering repos immediately instead of at the end of
 * some cached list. A connector that cannot be reached is reported as such —
 * never as "this Space has no repos", which would read as an authorization
 * answer the Hub did not actually get.
 */

/** Both completion and launch inference read the same authorized repository list.
 * The caller derives Space from an authorized Channel; no provider token leaves here. */
export async function launchTargetRepos(
  env: Env,
  spaceId: string,
  userId: string,
): Promise<{
  repos: LaunchTargetRepo[];
  repoStatus: LaunchTargetRepoStatus;
  repoStatusDetail?: string;
}> {
  // The list names private repositories with the Space's installation, so it
  // is for members: a viewer or participant is told, not shown none.
  let connection: AppConnectorConnectionView | null;
  try {
    connection = (await getAppConnection(env, { connectionId: `${spaceId}:github`, actorUserId: userId, use: true,
      allowMissing: true })).connection as AppConnectorConnectionView | null;
  } catch (error) {
    if (!connectionUseRefused(error)) throw error;
    return { repos: [], repoStatus: "unavailable", repoStatusDetail: "github_repositories_require_member" };
  }
  if (connection?.status !== "configured") {
    return { repos: [], repoStatus: "not-connected" };
  }
  try {
    return {
      repos: await spaceLaunchTargetRepositories(env, connection as never),
      repoStatus: "authorized",
    };
  } catch (error) {
    return {
      repos: [],
      repoStatus: "unavailable",
      repoStatusDetail: error instanceof Error ? error.message : "github_repositories_unavailable",
    };
  }
}
