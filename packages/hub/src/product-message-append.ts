import { messagePublicationEvidence } from "@xmatrix/protocol";
import { appendChannelMessage, channelMessageResult, publishChannelLiveDelivery } from "./channel-messages";
import { productMessageSenderPresentation } from "./message-sender-presentation";
import type { Env } from "./types";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/**
 * A message the Hub writes itself reaches live readers the same way a sent
 * one does. The Durable Object authority broadcast every append; on
 * PostgreSQL only the two send routes published, so notices, Automation
 * facts and GitHub posts were stored but seen only after a reload, and never
 * reached a live Agent. Delivery follows the commit: its failure is logged,
 * never turned into a failed append.
 */
export async function deliverCommittedProductMessage(
  env: Env,
  channelId: string,
  command: Record<string, unknown>,
  committed: Record<string, unknown>,
  publish: typeof publishChannelLiveDelivery = publishChannelLiveDelivery,
): Promise<void> {
  const snapshot = record(committed.senderSnapshot) ?? record(command.senderSnapshot);
  const messageId = typeof command.messageId === "string" ? command.messageId : undefined;
  const sequence = Number(committed.sequence);
  if (!snapshot || !messageId || !Number.isSafeInteger(sequence) || sequence < 1) return;
  const kind = snapshot.kind === "agent" || snapshot.kind === "app" || snapshot.kind === "system" ? snapshot.kind : "user";
  const authorId = String(snapshot.identityId ?? record(command.principal)?.id ?? "");
  const residual = record(command.residual);
  const metadata = record(residual?.appMetadata);
  try {
    await publish(env, () => {}, channelId, {
      channelId,
      messageId,
      sequence,
      ...messagePublicationEvidence(committed),
      body: typeof command.body === "string" ? command.body : "",
      from: productMessageSenderPresentation(snapshot, kind, authorId),
      sentAt: typeof committed.committedAt === "string" ? committed.committedAt : new Date().toISOString(),
      clientMessageId: messageId,
      ...(typeof residual?.replyToMessageId === "string" ? { replyToMessageId: residual.replyToMessageId } : {}),
      ...(metadata ? { metadata } : {}),
      ...(Array.isArray(committed.attachments) && committed.attachments.length
        ? { attachments: committed.attachments } : {}),
    });
  } catch (error) {
    console.error("Product message live delivery failed", {
      channelId, messageId, error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Append a product-internal message in PostgreSQL and deliver it live once committed. */
export async function dispatchProductMessageAppend(
  env: Env,
  channelId: string,
  command: Record<string, unknown>,
): Promise<Response> {
  const result = await channelMessageResult(() => appendChannelMessage(env, channelId, command));
  if (!result.ok) return result.response;
  await deliverCommittedProductMessage(env, channelId, command, result.payload);
  return Response.json(result.payload, { headers: { "cache-control": "no-store" } });
}
