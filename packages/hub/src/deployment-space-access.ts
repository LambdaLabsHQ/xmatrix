/** A deployment-owned Space id, or empty when the configured value is invalid. */
export function boundedDeploymentSpaceId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 180 ? trimmed : "";
}

/** Shared fail-closed membership grant for deployment-pinned Spaces. */
export async function resolveDeploymentSpaceMembership(
  user: { id?: string; agentRun?: unknown },
  configuredSpaceId: unknown,
  isMember: (spaceId: string, userId: string) => Promise<boolean>,
): Promise<boolean> {
  if (user.agentRun || !user.id) return false;
  const spaceId = boundedDeploymentSpaceId(configuredSpaceId);
  if (!spaceId) return false;
  return isMember(spaceId, user.id);
}
