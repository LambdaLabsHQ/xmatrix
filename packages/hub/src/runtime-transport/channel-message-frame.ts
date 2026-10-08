import { plainRecord as protocolRecord } from "@xmatrix/protocol";
/**
 * One committed channel message, framed once for every audience.
 *
 * Live agent frames, live human frames, and history reads had three separate
 * hand-maintained shapes. That is how rich metadata ended up with two names and
 * how attachments reached this layer and were dropped: each path validated and
 * copied fields on its own, and a field missing from one path failed silently.
 *
 * Everything about the message is normalized here and travels as one nested
 * object. Callers wrap it with transport facts only — delivery acks, interrupt
 * hints, optimistic-echo correlation — and never lift a message field up onto
 * the frame, so there is nothing left for a path to forget to copy.
 */
import {
  CHANNEL_ACTIVITY_PROVENANCE,
  supersededByOf,
  mentionAddressTokens,
  scanMentionAddresses,
  filterOperationalMentions,
  messagePublicationEvidence,
  parseAutoLaunchMentions,
  type ChannelMessage,
} from "@xmatrix/protocol";
import { parseProductAgentStopCommand } from "../product-agent-intervention";
import { parseProductHandoffInstanceMentions, parseProductRebornInstanceMentions } from "../product-agent-mention";
import { parseProductAgentControlCommands } from "../product-agent-model-effort";

/**
 * Whether a delivery is work for the receiving Instance or orientation.
 *
 * A system notice is the Hub narrating something about the channel — a machine
 * request, a run failure, a queued summon. It is addressed to the humans
 * watching, and it is committed with `xmatrixProvenance: "system_fact"` to say
 * so. Handing one to an Instance as work made it act on the Hub's own
 * commentary, so provenance decides intent here, once, for every audience:
 * a system fact is context and never work. An activity entry is the same:
 * a fact a runtime recorded about its own work (conversation-activity.md
 * §3.2), which must never queue a turn for a peer.
 *
 * The join window is the other context source, and that one is a property of
 * the read rather than the message; callers pass it in.
 */
export function channelMessageDeliveryIntent(
  message: ChannelMessage,
): "work" | "context" {
  // A thread's root copy is orientation for the thread, not new work: its
  // author already received their reply flow in the parent channel, and a
  // catch-up replay of it must never re-assign the root as work.
  if (typeof message.messageId === "string" && message.messageId.startsWith("thread-root:")) {
    return "context";
  }
  // The launch authority sends the selected Run its initial input separately.
  // This applies to catch-up as well as live delivery: reconnecting observers
  // must not turn a previously committed summon into another assignment.
  if (parseAutoLaunchMentions(message.body).length > 0) return "context";
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return "work";
  const values = metadata as Record<string, unknown>;
  const provenance = values.xmatrixProvenance;
  return provenance === "system_fact" || provenance === CHANNEL_ACTIVITY_PROVENANCE
    ? "context"
    : "work";
}

/**
 * Resolve a committed message for one exact live Agent Instance.
 *
 * Ordinary channel messages remain work for every live Instance. Automation is
 * different: its datum is first a canonical Channel fact. It becomes work only
 * for the exact live `@agent:N` address it contains. This keeps a fresh
 * `@auto repo:<owner/repo>` summon from interrupting unrelated existing Agents,
 * and makes an Automation that mentions its own live ordinal actionable.
 */
export function agentChannelMessageDeliveryIntent(
  message: ChannelMessage,
  recipient: { agentName: string; agentId?: string; channelInstanceId?: string; nameIsAmbiguous?: boolean },
): "work" | "context" {
  const baseIntent = channelMessageDeliveryIntent(message);
  if (baseIntent === "context") return baseIntent;
  // Stop is a control-plane fact committed into the Channel for auditability.
  // The Machine Daemon receives the actual command through its fenced control
  // path; delivering the same text as work makes every live peer improvise a
  // natural-language acknowledgement instead of treating it as control.
  if (parseProductAgentStopCommand(message.body)) return "context";
  // `@agent:N /model …` is the same shape: the Hub executes the switch itself
  // and posts the receipt. Delivering the text as work makes the addressed
  // Instance burn a turn answering a command already being carried out.
  if (parseProductAgentControlCommands(message.body).length > 0) return "context";
  // A reborn or handoff restarts or replaces its target, and carries the
  // message's request to the new Run itself. As work it would first spend a
  // turn on the Instance being stopped: one already out of usage reports its
  // limit again and hands itself off a second time.
  if (parseProductHandoffInstanceMentions(message.body).length > 0 ||
      parseProductRebornInstanceMentions(message.body).length > 0) return "context";
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" ||
      (metadata as Record<string, unknown>).xmatrixProvenance !== "scheduled_automation") {
    return "work";
  }
  const ordinal = recipient.channelInstanceId?.trim();
  const agentName = recipient.agentName.trim();
  if (!ordinal || !agentName) return "context";
  const tokens = mentionAddressTokens([...(recipient.nameIsAmbiguous ? [] : [`${agentName}:${ordinal}`]),
    ...(recipient.agentId ? [`${recipient.agentId}:${ordinal}`] : [])]);
  return filterOperationalMentions(message.body, scanMentionAddresses(message.body, tokens)).length > 0 ? "work" : "context";
}

/**
 * Whether one live delivery may cancel the recipient's active provider turn.
 *
 * Human input is steering and keeps the historical immediate-interrupt
 * behaviour. An Agent's ordinary Channel reply is different: cancelling every
 * peer that is still producing its answer makes a multi-Agent summon converge
 * on whichever provider finishes first. Peer replies remain work deliveries,
 * but wait behind the active turn. An exact `@agent:N` address is deliberate
 * steering, so it may still interrupt that one Instance.
 */
export function agentChannelMessageRequestsInterrupt(
  message: ChannelMessage,
  recipient: { agentName: string; agentId?: string; channelInstanceId?: string; nameIsAmbiguous?: boolean },
): boolean {
  if (agentChannelMessageDeliveryIntent(message, recipient) === "context") return false;
  if (message.from.kind !== "agent") return true;

  const ordinal = recipient.channelInstanceId?.trim();
  const agentName = recipient.agentName.trim();
  if (!ordinal || !agentName) return false;
  const tokens = mentionAddressTokens([...(recipient.nameIsAmbiguous ? [] : [`${agentName}:${ordinal}`]),
    ...(recipient.agentId ? [`${recipient.agentId}:${ordinal}`] : [])]);
  return filterOperationalMentions(message.body, scanMentionAddresses(message.body, tokens)).length > 0;
}

export type ChannelMessageFrameInput = {
  channelId?: unknown;
  messageId?: unknown;
  sequence?: unknown;
  entityVersion?: unknown;
  bodyHash?: unknown;
  from?: unknown;
  body?: unknown;
  sentAt?: unknown;
  replyToMessageId?: unknown;
  replyTo?: unknown;
  attachments?: unknown;
  appMentions?: unknown;
  metadata?: unknown;
  mentionReadStatuses?: unknown;
  reactions?: unknown;
  thread?: unknown;
  editedAt?: unknown;
  editedBy?: unknown;
  recalledAt?: unknown;
  deletedAt?: unknown;
  recalledBy?: unknown;
  /** Read for the Hub's own supersession judgment only; never forwarded as is. */
  annotations?: unknown;
};

function plainRecord(value: unknown): boolean {
  return protocolRecord(value) !== undefined;
}

function boundedId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function presentArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function normalizedThreadSummary(value: unknown): ChannelMessage["thread"] | undefined {
  if (!plainRecord(value)) return undefined;
  const input = value as Record<string, unknown>;
  const channelId = boundedId(input.channelId);
  const updatedAt = boundedId(input.updatedAt);
  const archivedAt = boundedId(input.archivedAt);
  const replyCount = Number(input.replyCount);
  if (!channelId || !updatedAt || !Number.isSafeInteger(replyCount) || replyCount < 0) return undefined;
  const replies = Array.isArray(input.replies) ? input.replies.flatMap((reply) => {
    if (!plainRecord(reply)) return [];
    const normalized = channelMessage({ ...(reply as Record<string, unknown>), thread: undefined });
    return normalized ? [normalized] : [];
  }).slice(0, 2) : [];
  return {
    channelId,
    updatedAt,
    replyCount,
    replies,
    ...(archivedAt ? { archivedAt } : {}),
  };
}

/**
 * Normalize one committed message into the shape every reader shares.
 *
 * Returns undefined when the message cannot be addressed — a delivery without
 * an id, body, sender, timestamp, or sequence is not a message anyone can act on.
 */
export function channelMessage(
  input: ChannelMessageFrameInput,
): ChannelMessage | undefined {
  const channelId = boundedId(input.channelId);
  const messageId = boundedId(input.messageId);
  const sentAt = boundedId(input.sentAt);
  const body = typeof input.body === "string" ? input.body : undefined;
  const sequenceValue = Number(input.sequence);
  const sequence = Number.isSafeInteger(sequenceValue) && sequenceValue >= 1
    ? sequenceValue
    : undefined;
  if (!channelId || !messageId || !sentAt || body === undefined || sequence === undefined ||
      !plainRecord(input.from)) {
    return undefined;
  }
  const replyToMessageId = boundedId(input.replyToMessageId);
  const editedAt = boundedId(input.editedAt);
  const recalledAt = boundedId(input.recalledAt);
  const deletedAt = boundedId(input.deletedAt);
  const thread = normalizedThreadSummary(input.thread);
  // Only the Hub's own judgment crosses; other annotations stay out of frames.
  const supersededBy = recalledAt ? undefined : boundedId(supersededByOf(input.annotations));
  return {
    messageId,
    channelId,
    sequence,
    ...messagePublicationEvidence(input),
    ...((recalledAt || deletedAt) && Number.isSafeInteger(input.entityVersion) && Number(input.entityVersion) > 0
      ? { entityVersion: Number(input.entityVersion) } : {}),
    from: input.from as ChannelMessage["from"],
    body,
    sentAt,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(plainRecord(input.replyTo)
      ? { replyTo: input.replyTo as ChannelMessage["replyTo"] }
      : {}),
    ...(presentArray(input.attachments)
      ? { attachments: input.attachments as ChannelMessage["attachments"] }
      : {}),
    ...(presentArray(input.appMentions)
      ? { appMentions: input.appMentions as ChannelMessage["appMentions"] }
      : {}),
    ...(plainRecord(input.metadata)
      ? { metadata: input.metadata as Record<string, unknown> }
      : {}),
    ...(presentArray(input.mentionReadStatuses)
      ? {
          mentionReadStatuses:
            input.mentionReadStatuses as ChannelMessage["mentionReadStatuses"],
        }
      : {}),
    // Post-commit state. A live delivery has none of it; a replayed or read
    // message carries whatever it has accumulated, through this same builder.
    ...(presentArray(input.reactions)
      ? { reactions: input.reactions as ChannelMessage["reactions"] }
      : {}),
    ...(thread ? { thread } : {}),
    ...(editedAt ? { editedAt } : {}),
    ...(editedAt && plainRecord(input.editedBy)
      ? { editedBy: input.editedBy as ChannelMessage["editedBy"] }
      : {}),
    ...(recalledAt ? { recalledAt } : {}),
    ...(deletedAt ? { deletedAt } : {}),
    ...(recalledAt && plainRecord(input.recalledBy)
      ? { recalledBy: input.recalledBy as ChannelMessage["recalledBy"] }
      : {}),
    ...(supersededBy ? { supersededBy } : {}),
  };
}
