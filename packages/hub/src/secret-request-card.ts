import { sha256Hex, SECRET_REQUEST_MESSAGE_KIND, type SecretRequestCard } from "@xmatrix/protocol";
import { XMATRIX_SYSTEM_AVATAR_URL } from "./xmatrix-system-identity";

/** Same card retries the same append; changed request state gets a new card.
 * Only public request metadata enters this identity, never a credential value. */
export async function secretRequestAppend(card: SecretRequestCard, saved: boolean,
  owner: { id: string; email: string }) {
  const metadata: SecretRequestCard = {
    secretRef: card.secretRef, envName: card.envName, description: card.description,
    reason: card.reason, agentName: card.agentName, runId: card.runId, channelId: card.channelId,
  };
  const agent = `**${metadata.agentName || "An Agent"}**`;
  const reason = metadata.reason ? `: ${metadata.reason}` : ".";
  const body = saved
    ? `${agent} asks to use this Space's secret \`${metadata.secretRef}\`${reason}\n\nA Space admin approves it on this card.`
    : `${agent} asks a Space admin to save the secret \`${metadata.secretRef}\` as \`${metadata.envName}\`${reason}\n\n` +
      "Only a Space admin can enter the value, on this card. The Agent never sees it in chat.";
  const append = {
    channelId: metadata.channelId, body,
    principal: { kind: "user", id: owner.id },
    messageKind: SECRET_REQUEST_MESSAGE_KIND,
    senderSnapshot: { identityId: `user:${owner.id}`, kind: "user", userId: owner.id,
      email: owner.email, label: "xMatrix secret request", name: "xMatrix secret request",
      avatarUrl: XMATRIX_SYSTEM_AVATAR_URL },
    residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true, secretRequest: metadata } },
  };
  const identity = await sha256Hex(JSON.stringify(append));
  return { ...append, messageId: `secret-request:${identity}`, commandId: `secret-request-append:${identity}` };
}
