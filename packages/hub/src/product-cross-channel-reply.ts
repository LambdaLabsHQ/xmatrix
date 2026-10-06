import { crossChannelReplyMetadata } from "@xmatrix/protocol";
import { productAgentSystemNoticeSenderSnapshot } from "./product-agent-mention-authority-adapter";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { Env } from "./types";

/** Where a reply to a cross-Channel link goes back to, as the append read it. */
export interface CrossChannelReplyOrigin {
  channelId: string;
  /** The link message in the reply's Channel. */
  messageId: string;
  /** Owner of the Run that wrote the link; the relay is appended under this
   *  owner's authority because the replier may have no access to the origin. */
  ownerUserId: string;
  /** Who wrote the reply, as its committed sender snapshot showed them. */
  replier?: CrossChannelReplier;
  /** The Instance that wrote the link: the only one that takes the answer as work. */
  requesterInstanceId?: string;
}

export interface CrossChannelReplier {
  kind: "user" | "agent";
  label: string;
  avatarUrl?: string;
  /** The exact Agent Instance that replied; live delivery of the relay skips it. */
  agentId?: string;
  instanceId?: string;
}

function replier(value: unknown): CrossChannelReplier | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if ((input.kind !== "user" && input.kind !== "agent") || typeof input.label !== "string" ||
      !input.label.trim()) return undefined;
  const id = (field: unknown) => typeof field === "string" && field.trim() ? field.trim() : undefined;
  const agentId = input.kind === "agent" ? id(input.agentId) : undefined;
  const instanceId = input.kind === "agent" ? id(input.instanceId) : undefined;
  return {
    kind: input.kind, label: input.label,
    ...(typeof input.avatarUrl === "string" && input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
    ...(agentId && instanceId ? { agentId, instanceId } : {}),
  };
}

export function crossChannelReplyOrigin(value: unknown): CrossChannelReplyOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const origin = value as Record<string, unknown>;
  return typeof origin.channelId === "string" && typeof origin.messageId === "string" &&
      typeof origin.ownerUserId === "string"
    ? {
        channelId: origin.channelId, messageId: origin.messageId, ownerUserId: origin.ownerUserId,
        ...(replier(origin.replier) ? { replier: replier(origin.replier) } : {}),
        ...(typeof origin.requesterInstanceId === "string" && origin.requesterInstanceId.trim()
          ? { requesterInstanceId: origin.requesterInstanceId.trim() } : {}),
      }
    : undefined;
}

/**
 * The relay shows the replier's name and face. It is written under the link
 * owner's authority, so its identity stays the owner's: the name is what a
 * reader recognizes, never an address `@` could reach. Where it was written
 * lives in metadata, which readers resolve against their own access.
 */
export function crossChannelReplySenderSnapshot(
  ownerUserId: string,
  from: CrossChannelReplier | undefined,
): Record<string, string> {
  const system = productAgentSystemNoticeSenderSnapshot(ownerUserId);
  if (!from) return system;
  const { avatarUrl: _management, ...owner } = system;
  return {
    ...owner,
    label: from.label,
    name: from.label,
    ...(from.avatarUrl ? { avatarUrl: from.avatarUrl } : {}),
  };
}

/**
 * Relay a reply to a cross-Channel link into the Channel the link came from
 * (docs/design/evolving-system-zh.md §5.4). It lands on the Channel, not on a
 * Run: a live Run there receives it as an ordinary message, and a finished Run
 * leaves it on the timeline for whoever works there next. The message id is
 * derived from the reply, so a retried post-commit appends it once.
 */
export async function relayCrossChannelReply(input: {
  env: Env;
  origin: CrossChannelReplyOrigin;
  channelId: string;
  messageId: string;
  body: string;
}, dependencies: {
  append?: typeof dispatchProductMessageAppend;
} = {}): Promise<void> {
  // The append also delivers it live, like every message the Hub writes.
  const append = dependencies.append ?? dispatchProductMessageAppend;
  const messageId = `link-reply:${input.messageId}`.slice(0, 200);
  const senderSnapshot = crossChannelReplySenderSnapshot(input.origin.ownerUserId, input.origin.replier);
  // Deliberately not a system fact: the reply is work for the Channel that asked.
  const metadata = crossChannelReplyMetadata({
    sourceChannelId: input.channelId,
    sourceMessageId: input.messageId,
    linkMessageId: input.origin.messageId,
    ...(input.origin.replier ? { replierKind: input.origin.replier.kind } : {}),
    // Lets delivery skip the Instance that wrote the reply when it is bound to
    // the link's Channel, as it skips any author of its own message.
    ...(input.origin.replier?.agentId && input.origin.replier.instanceId
      ? { replierAgentId: input.origin.replier.agentId, replierInstanceId: input.origin.replier.instanceId }
      : {}),
    // Only the Instance that asked takes the answer as work; others in its
    // Channel see it as context (live fan-out and catch-up replay).
    ...(input.origin.requesterInstanceId ? { requesterInstanceId: input.origin.requesterInstanceId } : {}),
  });
  const response = await append(input.env, input.origin.channelId, {
    commandId: messageId,
    messageId,
    channelId: input.origin.channelId,
    body: input.body,
    principal: { kind: "user", id: input.origin.ownerUserId },
    senderSnapshot,
    residual: { appMetadata: metadata },
  });
  const committed = await response.json<Record<string, unknown>>().catch(
    (): Record<string, unknown> => ({}),
  );
  if (!response.ok) {
    throw new Error(`Cross-Channel reply relay rejected (${response.status}): ${
      typeof committed.error === "string" ? committed.error : "unknown error"}`);
  }
}
