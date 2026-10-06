import type {
  ObservabilityEvent,
  SerializedChannel,
  SerializedWorkspace,
} from "@xmatrix/protocol";

export function spaceChannelIdSet(
  channels: readonly SerializedChannel[],
  spaceId: string | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!spaceId) return ids;
  for (const channel of channels) {
    if (channel.spaceId === spaceId) ids.add(channel.id);
  }
  return ids;
}

export function channelsInSpace<T extends { spaceId: string }>(
  channels: readonly T[],
  spaceId: string | null | undefined,
): T[] {
  if (!spaceId) return [];
  return channels.filter((channel) => channel.spaceId === spaceId);
}

/**
 * Keep the Automations this Space owns, plus the ones no Space can claim.
 *
 * An Automation whose Channel is gone — deleted, or not readable from here — belongs
 * to no Space, and hiding it removes the only surface that can repair it: the
 * editor renders that Channel as `(unavailable)` and refuses to save precisely
 * so a stranded schedule stays visible while it keeps running.
 */
export function automationsInSpace<T extends { channelId: string }>(
  automations: readonly T[],
  spaceChannelIds: ReadonlySet<string>,
  knownChannelIds: ReadonlySet<string>,
): T[] {
  return automations.filter((automation) =>
    spaceChannelIds.has(automation.channelId) || !knownChannelIds.has(automation.channelId));
}

/**
 * Keep this Space's events, and the ones that name no Space at all.
 *
 * An Agent connecting or a Machine coming online happens to the account, not
 * inside a Channel, so it carries neither a Channel nor a Space. Reading that
 * absence as "some other Space" deletes those events from every Space at once
 * — the same absence this module already keeps for an unbound directory and a
 * local-only Agent. It also survives the moment before the current Space has
 * resolved, when filtering everything out would blank the page.
 */
export function eventsInSpace(
  events: readonly ObservabilityEvent[],
  spaceId: string | null | undefined,
  spaceChannelIds: ReadonlySet<string>,
): ObservabilityEvent[] {
  return events.filter((event) => {
    if (event.channelId) return spaceChannelIds.has(event.channelId);
    const metadataSpaceId =
      typeof event.metadata?.spaceId === "string" ? event.metadata.spaceId : null;
    if (!metadataSpaceId) return true;
    return metadataSpaceId === spaceId;
  });
}

export function workspaceBelongsToSpace(
  workspace: Pick<SerializedWorkspace, "boundChannelIds">,
  spaceChannelIds: ReadonlySet<string>,
): boolean {
  return workspace.boundChannelIds.some((channelId) => spaceChannelIds.has(channelId));
}

export function workspacesInSpace<T extends Pick<SerializedWorkspace, "boundChannelIds">>(
  workspaces: readonly T[],
  spaceChannelIds: ReadonlySet<string>,
  options: { includeUnbound?: boolean } = {},
): T[] {
  return workspaces.filter((workspace) => {
    if (workspace.boundChannelIds.length === 0) return options.includeUnbound === true;
    return workspaceBelongsToSpace(workspace, spaceChannelIds);
  });
}

export function machinesInSpace<T extends { workspaces: SerializedWorkspace[]; daemon?: { userId: string } }>(
  machines: readonly T[],
  spaceChannelIds: ReadonlySet<string>,
  options: { ownerUserId?: string } = {},
): T[] {
  const scoped: T[] = [];
  for (const machine of machines) {
    const workspaces = workspacesInSpace(machine.workspaces, spaceChannelIds, {
      includeUnbound: true,
    });
    // Owned Machines remain manageable before a directory is registered.
    // Their directory list still excludes other Spaces' bindings.
    if (workspaces.length === 0 && (!options.ownerUserId || machine.daemon?.userId !== options.ownerUserId)) continue;
    scoped.push({ ...machine, workspaces });
  }
  return scoped;
}

export function localManagedAgentsInSpace<T extends { registration: { key: { spaceId: string } } }>(
  agents: readonly T[],
  spaceId: string | null | undefined,
): T[] {
  if (!spaceId) return [];
  return agents.filter((agent) => agent.registration.key.spaceId === spaceId);
}
