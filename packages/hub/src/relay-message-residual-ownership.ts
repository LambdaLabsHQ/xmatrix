/** Canonical message facts and owned graphs cannot be smuggled into residual fields. */
const RESIDUAL_FORBIDDEN_FIELDS = new Set([
  "messageId", "channelId", "sequence", "timelineSequence", "from", "sender",
  "senderSnapshot", "body", "content", "contentHash", "bodyHash", "recordDigest",
  "reactions", "reaction", "attachments", "attachment", "contentRefs", "contentRef",
  "mentionReadStatuses", "readStatuses", "attention", "deliveryCursor", "acl", "grants",
]);

export function messageResidualFieldForbidden(field: string): boolean {
  return RESIDUAL_FORBIDDEN_FIELDS.has(field);
}
