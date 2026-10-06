import { utf8ByteLength } from "./hex.js";
/** What every member of a Space may see. */
export function spaceVisibilityScope(spaceId: string): string {
  return `space:${spaceId}`;
}

/** Who may see a Channel's content: a closed Channel's own members, else its whole Space. */
export function channelVisibilityScope(channel: {
  mode: string | null | undefined; channelId: string; spaceId: string;
}): string {
  return channel.mode === "closed" ? `channel:${channel.channelId}` : spaceVisibilityScope(channel.spaceId);
}

/** Private decision payloads are readable only by this user while Channel access remains. */
export function restrictedChannelContentScope(channelId: string, userId: string): string {
  if (!channelId || !userId) throw new Error("Invalid restricted content scope");
  const scope = `channel-user:${encodeURIComponent(channelId)}:${encodeURIComponent(userId)}`;
  if (utf8ByteLength(scope) > 200) throw new Error("Restricted content scope exceeds limit");
  return scope;
}

export function parseRestrictedChannelContentScope(scope: string): { channelId: string; readerUserId: string } | null {
  if (!scope.startsWith("channel-user:")) return null;
  const parts = scope.split(":");
  if (parts.length !== 3) throw new Error("Invalid restricted content scope");
  const channelId = decodeURIComponent(parts[1]!);
  const readerUserId = decodeURIComponent(parts[2]!);
  if (restrictedChannelContentScope(channelId, readerUserId) !== scope) throw new Error("Invalid restricted content scope");
  return { channelId, readerUserId };
}

/** A known checksum is never a capability to re-reference a restricted object in another scope. */
export function immutableContentObjectKey(scope: string, checksum: string): string {
  if (!/^[a-f0-9]{64}$/u.test(checksum)) throw new Error("Invalid content checksum");
  return parseRestrictedChannelContentScope(scope)
    ? `restricted/${encodeURIComponent(scope)}/objects/${checksum}` : `objects/${checksum}`;
}

/**
 * An upload makes an object exist; a reference decides who can see it. An
 * upload in a Space's scope can therefore be referenced into any Channel of
 * that Space, and any other upload only into its own scope. The Space of a
 * `channel:` reference is the caller's to resolve.
 */
export function uploadScopeCoversRefScope(uploadScope: string, refScope: string, refSpaceId: string): boolean {
  if (uploadScope === refScope) return true;
  return uploadScope === spaceVisibilityScope(refSpaceId) && refScope.startsWith("channel:");
}
