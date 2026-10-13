/** Host-owned position in one process-local trace stream, independent of clocks. */
export interface AgentTraceOrder {
  streamId: string;
  sequence: number;
}

export function parseAgentTraceOrder(value: unknown): AgentTraceOrder | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { streamId, sequence } = value as Record<string, unknown>;
  if (typeof streamId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(streamId) ||
      typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) return undefined;
  return { streamId, sequence };
}

export function agentTraceOrderCursor(order: AgentTraceOrder): string {
  return `received:${order.streamId}:${order.sequence}`;
}

export function parseAgentTraceOrderCursor(value: unknown): AgentTraceOrder | undefined {
  if (typeof value !== "string" || value.length > 70) return undefined;
  const match = /^received:([^:]+):([1-9]\d{0,15})$/.exec(value);
  return match ? parseAgentTraceOrder({ streamId: match[1], sequence: Number(match[2]) }) : undefined;
}
