import type { SerializedChannel, SerializedSpace, SpaceMember } from "@xmatrix/protocol";

type ChannelSpaceDirectory = Pick<SerializedSpace, "id" | "members"> | null | undefined;

/**
 * Human identities authorized to read a Channel.
 *
 * Open Channels inherit the Space directory. Closed Channels use Authority's
 * Channel-level visibility projection. Presence never defines membership.
 */
export function visibleHumanChannelMemberIds(
  channel: SerializedChannel,
  space: ChannelSpaceDirectory,
): string[] {
  if (channel.mode === "open") {
    if (!space || space.id !== channel.spaceId) return [];
    return sortedUnique(space.members.map((member) => `user:${member.userId}`));
  }
  return sortedUnique(channel.visibleHumanMemberIds || []);
}

/** Resolve a `user:<id>` Channel identity through the durable Space directory. */
export function spaceMemberForChannelIdentity(
  space: ChannelSpaceDirectory,
  memberId: string
): SpaceMember | undefined {
  if (!space || !memberId.startsWith("user:")) return undefined;
  return space.members.find((member) => member.userId === memberId.slice("user:".length));
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}
