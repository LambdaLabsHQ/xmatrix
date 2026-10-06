import type { SerializedAgent, SerializedChannel } from "@xmatrix/protocol";
import type { HumanServerMessage } from "@xmatrix/protocol/connections/human";
import { isPlainRecord, utf8ByteLength } from "@xmatrix/protocol";

export const RELAY_RUNTIME_CHANNEL_AGENT_PRESENCE_PATH = "/internal/product/channel-agent-presence";

const MAX_PRESENCE_RECIPIENTS = 1_000;
const MAX_PRESENCE_BODY_BYTES = 256_000;

export interface ChannelAgentPresenceRecipient {
  userId: string;
  /** A status report: the receiving cell may fold the card into a once-a-second digest. */
  digest: boolean;
  card: boolean;
  channel: boolean;
  immediate: Array<"lifecycle" | "observable">;
}

/**
 * One Agent presence change, shared with every Runtime cell that may hold a
 * Human watching the Channel. The card and the Channel travel once; each
 * recipient only says which of them it should see.
 */
export interface ChannelAgentPresenceDelivery {
  channelId: string;
  reason: "connect" | "update" | "disconnect";
  card?: SerializedAgent;
  channel?: SerializedChannel;
  lifecycle?: HumanServerMessage;
  observable?: HumanServerMessage;
  recipients: ChannelAgentPresenceRecipient[];
}

export function channelAgentPresenceDeliveryBody(delivery: ChannelAgentPresenceDelivery): string | undefined {
  const recipients = delivery.recipients.slice(0, MAX_PRESENCE_RECIPIENTS);
  if (recipients.length === 0) return undefined;
  const payload: ChannelAgentPresenceDelivery = {
    channelId: delivery.channelId,
    reason: delivery.reason,
    ...(delivery.card ? { card: delivery.card } : {}),
    ...(delivery.channel ? { channel: delivery.channel } : {}),
    ...(delivery.lifecycle ? { lifecycle: delivery.lifecycle } : {}),
    ...(delivery.observable ? { observable: delivery.observable } : {}),
    recipients,
  };
  let body = JSON.stringify(payload);
  if (utf8ByteLength(body) > MAX_PRESENCE_BODY_BYTES && payload.channel) {
    const { channel: _channel, ...withoutChannel } = payload;
    body = JSON.stringify({
      ...withoutChannel,
      recipients: withoutChannel.recipients.map((recipient) => ({ ...recipient, channel: false })),
    });
  }
  return utf8ByteLength(body) <= MAX_PRESENCE_BODY_BYTES ? body : undefined;
}

export function parseChannelAgentPresenceDelivery(value: unknown): ChannelAgentPresenceDelivery | undefined {
  if (!isPlainRecord(value)) return undefined;
  const channelId = boundedText(value.channelId, 180);
  const reason = value.reason === "connect" || value.reason === "update" || value.reason === "disconnect"
    ? value.reason : undefined;
  if (!channelId || !reason || !Array.isArray(value.recipients) ||
      value.recipients.length === 0 || value.recipients.length > MAX_PRESENCE_RECIPIENTS) return undefined;
  const card = value.card === undefined ? undefined : agentCard(value.card);
  const channel = value.channel === undefined ? undefined : channelSnapshot(value.channel, channelId);
  const lifecycle = value.lifecycle === undefined ? undefined : typedFrame(value.lifecycle, "agent_lifecycle");
  const observable = value.observable === undefined ? undefined : typedFrame(value.observable, "observable_event");
  if ((value.card !== undefined && !card) || (value.channel !== undefined && !channel) ||
      (value.lifecycle !== undefined && !lifecycle) || (value.observable !== undefined && !observable)) {
    return undefined;
  }
  const recipients: ChannelAgentPresenceRecipient[] = [];
  for (const item of value.recipients) {
    const recipient = parseRecipient(item);
    if (!recipient) return undefined;
    recipients.push(recipient);
  }
  return {
    channelId,
    reason,
    ...(card ? { card } : {}),
    ...(channel ? { channel } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(observable ? { observable } : {}),
    recipients,
  };
}

function parseRecipient(value: unknown): ChannelAgentPresenceRecipient | undefined {
  if (!isPlainRecord(value)) return undefined;
  const userId = boundedText(value.userId, 200);
  if (!userId || typeof value.digest !== "boolean" || typeof value.card !== "boolean" ||
      typeof value.channel !== "boolean" || !Array.isArray(value.immediate) || value.immediate.length > 2) {
    return undefined;
  }
  const immediate: Array<"lifecycle" | "observable"> = [];
  for (const flag of value.immediate) {
    if (flag !== "lifecycle" && flag !== "observable") return undefined;
    if (!immediate.includes(flag)) immediate.push(flag);
  }
  return { userId, digest: value.digest, card: value.card, channel: value.channel, immediate };
}

function agentCard(value: unknown): SerializedAgent | undefined {
  if (!isPlainRecord(value) || typeof value.id !== "string" || !value.id.trim()) return undefined;
  return value as unknown as SerializedAgent;
}

function channelSnapshot(value: unknown, channelId: string): SerializedChannel | undefined {
  if (!isPlainRecord(value) || value.id !== channelId) return undefined;
  return value as unknown as SerializedChannel;
}

function typedFrame(value: unknown, type: "agent_lifecycle" | "observable_event"): HumanServerMessage | undefined {
  if (!isPlainRecord(value) || value.type !== type) return undefined;
  return value as unknown as HumanServerMessage;
}

function boundedText(value: unknown, limit: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 && text.length <= limit ? text : undefined;
}
