/** The original existing-instance address, resolved at message publication. */
export interface SerializedAgentMessageTarget {
  id: string;
  channelId: string;
  sourceMessageId: string;
  sourceEntityVersion: number;
  /** Server-verified input revision; reactions do not advance it. */
  sourceInputVersion?: number;
  sourceBodyHash: string;
  sourceMention: string;
  targetName: string;
  channelInstanceId: string;
  resolution: "resolved" | "unavailable";
  instanceId?: string;
  runId?: string;
  runStatus?: string;
  createdAt: string;
}
