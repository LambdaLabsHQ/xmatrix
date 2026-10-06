/** A bounded lookup of an HTTP message append's original durable receipt. */
export type MessageCommitReceipt = {
  schemaVersion: 1;
  channelId: string;
  messageId: string;
  observedAt: string;
} & (
  | { status: "committed"; sequence: number; bodyHash: string;
      /** Absent for legacy or non-CLI-compatible submissions. Never inferred. */
      agentSendFingerprint?: string;
      sender: { kind: "user" | "agent"; id: string; instanceId?: string } }
  | { status: "not_found" | "receipt_unavailable" }
);
