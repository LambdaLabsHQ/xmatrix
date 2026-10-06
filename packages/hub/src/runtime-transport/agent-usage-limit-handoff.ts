import { sha256Hex } from "@xmatrix/protocol";

/** The handoff a usage-limited Instance gets: `@<name>:<n>:handoff:@auto`.
 * Nothing else is said; the handoff picks the successor and the Channel shows
 * it as one. None for an Instance the Channel cannot address. */
export function usageLimitHandoffCommand(agentName: string, channelInstanceId: string | undefined): string | undefined {
  const name = agentName.trim();
  return name && channelInstanceId ? `@${name}:${channelInstanceId}:handoff:@auto` : undefined;
}

/** Stable ids for the handoff the turn-failure notice `noticeMessageId` set off.
 * That id carries the provider's text (spaces, `·`) and runs to ~170
 * characters, while authorities bound ids in UTF-8 bytes and live delivery
 * caps a message id at 160: ids built from it verbatim were refused. These are
 * short, ASCII and still one per notice, so a replay resolves to the same ones. */
export async function usageLimitHandoffIds(noticeMessageId: string): Promise<{
  commandId: string; noticeMessageId: string;
}> {
  const key = (await sha256Hex(noticeMessageId)).slice(0, 32);
  return {
    commandId: `usage-limit-handoff:${key}`,
    noticeMessageId: `system:usage-limit-handoff:${key}`,
  };
}
