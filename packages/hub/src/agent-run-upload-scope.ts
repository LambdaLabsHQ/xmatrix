import { channelVisibilityScope } from "@xmatrix/protocol";

/**
 * Scope an Agent Run may register uploads under: its birth Channel, expressed
 * the way the domain expresses that Channel's ACL (see `channelScope` in
 * relay-authority-domain-commands). An open Channel's messages live in the Space
 * scope, so pinning uploads to `channel:<id>` made attachment binding
 * impossible there — `message_attachments_put` only binds a ref that already
 * sits in the message's own scope. Confinement is unchanged: still exactly one
 * Channel, just named the way the rest of the domain names it.
 *
 * An unreadable Channel falls back to the channel scope, which stays correct
 * for closed Channels and no worse than before anywhere else.
 */
export function agentRunUploadScopeId(
  channelId: string,
  channel: Record<string, unknown> | undefined,
): string {
  const mode = typeof channel?.mode === "string" ? channel.mode : undefined;
  const spaceId = typeof channel?.spaceId === "string" ? channel.spaceId : undefined;
  return mode && spaceId ? channelVisibilityScope({ mode, channelId, spaceId }) : `channel:${channelId}`;
}
