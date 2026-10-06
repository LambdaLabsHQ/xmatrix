import type { SerializedSpace, SpaceManagementAgentConfig } from "@xmatrix/protocol";

function managementConfigUpdatedAt(
  config: SpaceManagementAgentConfig | undefined
): number | null {
  if (!config?.updatedAt) return null;
  const value = Date.parse(config.updatedAt);
  return Number.isFinite(value) ? value : null;
}

/**
 * A Spaces request can start before a management-config mutation and finish
 * after it. Preserve the newer config while still accepting every other field
 * from the authoritative Space snapshot.
 */
export function mergeSpaceSnapshot(
  current: SerializedSpace,
  incoming: SerializedSpace
): SerializedSpace {
  const currentConfigUpdatedAt = managementConfigUpdatedAt(current.managementAgent);
  const incomingConfigUpdatedAt = managementConfigUpdatedAt(incoming.managementAgent);
  const currentConfigIsNewer =
    currentConfigUpdatedAt !== null &&
    (incomingConfigUpdatedAt === null || currentConfigUpdatedAt > incomingConfigUpdatedAt);

  return currentConfigIsNewer
    ? { ...incoming, managementAgent: current.managementAgent }
    : incoming;
}

/**
 * The incoming list remains authoritative for membership/removal. Only a
 * matching Space's independently versioned management config is reconciled.
 */
export function mergeSpaceListSnapshot(
  current: SerializedSpace[],
  incoming: SerializedSpace[]
): SerializedSpace[] {
  const currentById = new Map(current.map((space) => [space.id, space]));
  return incoming.map((space) => {
    const existing = currentById.get(space.id);
    return existing ? mergeSpaceSnapshot(existing, space) : space;
  });
}
