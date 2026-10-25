import type { ChannelAttachment, ChannelMessage } from "@xmatrix/protocol";

/**
 * A Channel message as an Agent Instance reads it in a turn: the header naming its Channel, id,
 * parent, delivery time and sender, the message it replies to, then its body and attachments. The
 * Hub renders it for each recipient and sends it beside the message (`prompt` on a delivery frame),
 * so its wording changes with a Hub deploy. A runtime that read the attachments onto its machine
 * lists where they are after it; one that predates `prompt` renders the message itself.
 */

/** Who reads it: a reply to this Agent or this Instance says so. */
export interface AgentTurnReader { agentId?: string; instanceId?: string }

/** A `data:` URL in text is replaced by its length: a pasted image must not flood a prompt. */
export function redactDataUrls(text: string): string {
  return text.replace(/data:[^\s"')\]}<>]*/gu, (candidate) =>
    candidate.includes(";base64,") ? `[data URL redacted: ${candidate.length} chars]` : candidate);
}

/** One attachment as the turn names it, by its Hub link when it has one. */
export function attachmentLine(attachment: ChannelAttachment): string {
  const kind = attachment.kind?.trim() ? attachment.kind : "file";
  const at = attachment.url ? ` at ${attachment.url}` : "";
  return `- ${kind} ${attachment.name}${at} (${attachment.size} bytes, ${attachment.mimeType})\n`;
}

function crossChannelReply(metadata: Record<string, unknown> | undefined):
  { channelId: string; messageId?: string; replierKind?: "user" | "agent" } | undefined {
  if (!metadata || metadata.xmatrixProvenance !== "cross_channel_reply") return undefined;
  const relayed = metadata.crossChannelReply as Record<string, unknown> | undefined;
  const text = (key: string) => {
    const value = relayed?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const channelId = text("sourceChannelId");
  if (!channelId) return undefined;
  const kind = text("replierKind");
  return { channelId, messageId: text("sourceMessageId"),
    replierKind: kind === "user" || kind === "agent" ? kind : undefined };
}

export function renderAgentTurnMessage(message: ChannelMessage, reader: AgentTurnReader, deliveredAt: string): string {
  let body = redactDataUrls(message.body.trim());
  if (message.attachments?.length) {
    if (body) body += "\n\n";
    body += `Attachments:\n${message.attachments.map(attachmentLine).join("")}`;
  }
  const ids = message.replyToMessageId
    ? ` messageId=${message.messageId} replyToMessageId=${message.replyToMessageId}` : ` messageId=${message.messageId}`;
  const relayed = crossChannelReply(message.metadata);
  const where = relayed
    ? ` replying in Channel ${relayed.channelId} to a cross-Channel request from this Channel` +
      (relayed.messageId ? ` (answer there with \`xmatrix send ${relayed.channelId} --reply-to ${relayed.messageId}\`)` : "")
    : message.from.originChannelId?.trim() ? ` via Channel ${message.from.originChannelId.trim()}` : "";
  const reply = message.replyTo;
  const toReader = reply?.from.kind === "agent" && (
    (reader.agentId !== undefined && reply.from.identityId === reader.agentId) ||
    (reader.instanceId !== undefined && reply.from.instanceId === reader.instanceId));
  const replyContext = reply
    ? `\nReply context: ${message.from.label} ${toReader ? "replied to your message" : "replied to"} ` +
      `[${reply.from.label}] messageId=${reply.messageId} preview="${redactDataUrls(reply.bodyPreview.trim())}"\n`
    : "";
  return `xMatrix channel ${message.channelId}${ids} deliveredAt=${deliveredAt} from ${message.from.label} ` +
    `[${relayed?.replierKind ?? message.from.kind}]${where}:${replyContext}${body.trim()}`;
}
