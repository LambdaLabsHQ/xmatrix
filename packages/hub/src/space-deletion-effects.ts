import { ServiceUnavailable } from "./error-contract";
import { daemonStopTargets, issueDaemonStopsForArchivedChannelTree } from "./product-agent-intervention-authority-adapter";
import { armSpaceDeletionClock } from "./space-deletion-clock";
import type { Env } from "./types";

/** Spaces the deployment configuration names cannot be closed from the product. */
export function deploymentPinnedSpace(env: Env, spaceId: string): boolean {
  return [env.PLATFORM_ADMIN_SPACE_ID, env.TEST_ENVIRONMENT_ACCESS_SPACE_ID]
    .some(pinned => typeof pinned === "string" && pinned.trim() === spaceId);
}

/** Apply the same after-commit effects for ordinary and account-related closure. */
export async function finishScheduledSpaceDeletion(input: {
  env: Env; spaceId: string; actorUserId: string; result: Record<string, unknown>;
  waitUntil: (work: Promise<unknown>) => void;
}) {
  const { env, spaceId, actorUserId, result } = input;
  const deletion = result.deletion as { purgeAfter?: unknown } | undefined;
  if (typeof deletion?.purgeAfter !== "string") throw new ServiceUnavailable(
    "space_deletion_result_invalid", "Space deletion result is invalid");
  const targets = daemonStopTargets(result.stopTargets);
  if (targets.length) input.waitUntil(issueDaemonStopsForArchivedChannelTree({
    env, actorUserId, rootChannelId: `space-delete:${spaceId}`,
    reason: "The Space was deleted", targets,
  }));
  try { await armSpaceDeletionClock(env, spaceId, deletion.purgeAfter); }
  catch {
    throw new ServiceUnavailable("space_deletion_clock_unavailable",
      "Space deletion was recorded but its purge is not scheduled yet; retry");
  }
  return deletion;
}
