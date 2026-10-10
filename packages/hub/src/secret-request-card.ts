import {
  sha256Hex, SECRET_ACCESS_REQUEST_MESSAGE_KIND, SECRET_REQUEST_MESSAGE_KIND,
  type SecretAccessRequestCard, type SecretRequestCard,
} from "@xmatrix/protocol";
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
  return cardAppend("secret-request", metadata.channelId, body, SECRET_REQUEST_MESSAGE_KIND, owner,
    { secretRequest: metadata });
}

/** The card on which a Space admin chooses which of the named secrets Agents read without asking. */
export async function secretAccessRequestAppend(card: SecretAccessRequestCard, owner: { id: string; email: string }) {
  const metadata: SecretAccessRequestCard = { secretRefs: card.secretRefs, reason: card.reason,
    agentName: card.agentName, runId: card.runId, channelId: card.channelId };
  const count = metadata.secretRefs.length === 1 ? `the secret \`${metadata.secretRefs[0]}\``
    : `${metadata.secretRefs.length} secrets`;
  const body = `**${metadata.agentName || "An Agent"}** asks that Agents in this Space read ${count} without asking` +
    `${metadata.reason ? `: ${metadata.reason}` : "."}\n\nA Space admin chooses which on this card.`;
  return cardAppend("secret-access-request", metadata.channelId, body, SECRET_ACCESS_REQUEST_MESSAGE_KIND, owner,
    { secretAccessRequest: metadata });
}

async function cardAppend(prefix: string, channelId: string, body: string, messageKind: string,
  owner: { id: string; email: string }, appMetadata: Record<string, unknown>) {
  const append = {
    channelId, body,
    principal: { kind: "user", id: owner.id },
    messageKind,
    // The Run cannot go on until it is answered: it waits on its owner.
    waitsOnUserIds: [owner.id],
    senderSnapshot: { identityId: `user:${owner.id}`, kind: "user", userId: owner.id,
      email: owner.email, label: "xMatrix secret request", name: "xMatrix secret request",
      avatarUrl: XMATRIX_SYSTEM_AVATAR_URL },
    residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true, ...appMetadata } },
  };
  const identity = await sha256Hex(JSON.stringify(append));
  return { ...append, messageId: `${prefix}:${identity}`, commandId: `${prefix}-append:${identity}` };
}
