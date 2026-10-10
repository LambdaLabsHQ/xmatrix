/** Raw CLI send content, before App-mention rendering or sender presentation.
 * This is correlation evidence only; the Hub owns identity and permission.
 */
export function agentSendSubmissionCanonical(scope: {
  channelId: string; messageId: string; agentId: string; runId: string; instanceId: string;
}, raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(key => ![
    "body", "clientMessageId", "senderAgentId", "senderAgentName", "senderAgentInstanceId",
    "senderRunId", "senderExecutionKey", "attachments", "finalReplyExecutionId", "awaitsResponse",
  ].includes(key)) || typeof body.body !== "string") return null;
  const attachments = body.attachments === undefined ? [] : body.attachments;
  if (!Array.isArray(attachments) || attachments.length > 10) return null;
  const bindings: Array<Array<string | number>> = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment) ||
        Object.keys(attachment).some(key => ![
          "attachmentId", "objectKey", "contentHash", "encodedBytes", "mimeType", "name",
        ].includes(key))) return null;
    const { attachmentId, objectKey, contentHash, encodedBytes, mimeType, name } = attachment;
    if (![attachmentId, objectKey, contentHash, mimeType, name].every(value => typeof value === "string") ||
        !Number.isSafeInteger(encodedBytes) || encodedBytes < 1) return null;
    bindings.push([attachmentId, objectKey, contentHash, encodedBytes, mimeType, name]);
  }
  const finalId = body.finalReplyExecutionId;
  if (finalId !== undefined && (typeof finalId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(finalId))) return null;
  // A declared wait changes who the message waits on, not what was sent: it is not part of the identity.
  // Keep ordinary sends byte-compatible; final intent is part of v2 identity.
  if (finalId !== undefined) return JSON.stringify(["xmatrix-agent-send-v2", scope.channelId, scope.messageId,
    scope.agentId, scope.runId, scope.instanceId, body.body, bindings, finalId]);
  // Positional, versioned encoding has identical UTF-8 bytes in JS and Rust.
  return JSON.stringify(["xmatrix-agent-send-v1", scope.channelId, scope.messageId,
    scope.agentId, scope.runId, scope.instanceId, body.body, bindings]);
}
