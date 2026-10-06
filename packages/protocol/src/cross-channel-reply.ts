import { plainRecord as record } from "./plain-record.js";

/**
 * A reply to a cross-Channel link, relayed into the link's Channel
 * (docs/design/evolving-system-zh.md §5.4). The Hub writes the relay under the
 * link owner's authority, so its sender never names who answered; this
 * metadata records where the reply was written and, for an Agent, the exact
 * Instance that wrote it.
 */
export interface CrossChannelReplyRelay {
  sourceChannelId: string;
  sourceMessageId?: string;
  /** The link message in the relay's Channel. */
  linkMessageId?: string;
  replierKind?: "user" | "agent";
  /** Present only for an Agent replier. */
  replierAgentId?: string;
  replierInstanceId?: string;
  /** The Instance that wrote the link: the only one that takes the answer as
   *  work while it is live. Other Instances in its Channel get it as context. */
  requesterInstanceId?: string;
}

const PROVENANCE = "cross_channel_reply";

/** The message metadata that marks a relayed cross-Channel reply. */
export function crossChannelReplyMetadata(relay: CrossChannelReplyRelay): Record<string, unknown> {
  return { xmatrixProvenance: PROVENANCE, crossChannelReply: relay };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The relay a message's metadata carries, if it is a relayed cross-Channel reply. */
export function crossChannelReplyRelay(metadata: unknown): CrossChannelReplyRelay | undefined {
  const values = record(metadata);
  if (values?.xmatrixProvenance !== PROVENANCE) return undefined;
  const relay = record(values.crossChannelReply);
  const sourceChannelId = text(relay?.sourceChannelId);
  if (!relay || !sourceChannelId) return undefined;
  const replierKind = relay.replierKind === "user" || relay.replierKind === "agent" ? relay.replierKind : undefined;
  const agent = (value: unknown) => (replierKind === "agent" ? text(value) : undefined);
  const optional = {
    sourceMessageId: text(relay.sourceMessageId),
    linkMessageId: text(relay.linkMessageId),
    replierKind,
    replierAgentId: agent(relay.replierAgentId),
    replierInstanceId: agent(relay.replierInstanceId),
    requesterInstanceId: text(relay.requesterInstanceId),
  };
  return {
    sourceChannelId,
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  };
}
