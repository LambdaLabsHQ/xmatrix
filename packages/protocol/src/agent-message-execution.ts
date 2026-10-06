/** A scoped runtime report for one immutable source message version. */
export interface SerializedAgentMessageExecution {
  id: string;
  channelId: string;
  sourceMessageId: string;
  sourceEntityVersion: number;
  /** Server-verified input revision; reactions do not advance it. */
  sourceInputVersion?: number;
  sourceBodyHash: string;
  runId: string;
  instanceId: string;
  agentName?: string;
  channelInstanceId?: string;
  executionId: string;
  revision: number;
  state: "accepted" | "running" | "completed" | "failed" | "interrupted" | "unknown";
  inputDisposition?: "pending" | "submitted" | "resumed_existing";
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  observedAt: string;
  runStatus: string;
  /** An explicit final reply from this Run/execution, still published unchanged. */
  finalReply?: { messageId: string; committedAt: string };
  /** Presentation hint only; the recovery endpoint rechecks current authority. */
  recoveryAvailable?: boolean;
}
