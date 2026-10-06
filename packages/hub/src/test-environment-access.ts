import type { AuthUser } from "./auth";
import { resolveDeploymentSpaceMembership } from "./deployment-space-access";
import type { Env } from "./types";

/**
 * Resolve the advisory Test-app capability for one authenticated human.
 * Agent-run principals never inherit this account UI capability. Membership
 * failures are handled by the caller's resolver and must fail closed.
 */
export async function resolveTestEnvironmentAccess(
  user: Pick<AuthUser, "id"> & { agentRun?: unknown },
  env: Pick<Env, "TEST_ENVIRONMENT_ACCESS_SPACE_ID">,
  isAccessSpaceMember: (spaceId: string, userId: string) => Promise<boolean>,
): Promise<boolean> {
  return resolveDeploymentSpaceMembership(
    user,
    env.TEST_ENVIRONMENT_ACCESS_SPACE_ID,
    isAccessSpaceMember,
  );
}
