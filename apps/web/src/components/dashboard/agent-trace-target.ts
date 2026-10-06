import type { SerializedAgentInstance } from "@xmatrix/protocol";

export type AgentTraceTargetLike = {
  id?: string;
  instanceId?: string;
  instanceIds?: string[];
  exactInstanceIds?: string[];
  instanceScoped?: boolean;
  ownerUserId?: string;
  channelId?: string;
};

export function agentTraceExactInstanceIds(
  target: AgentTraceTargetLike
): string[] {
  const candidates = target.exactInstanceIds?.length
    ? target.exactInstanceIds
    : target.instanceId
      ? [target.instanceId]
      : [];
  return Array.from(new Set(candidates.filter(isNonEmptyString)));
}

export type AgentTraceOwnerLike = {
  id: string;
  userId?: string;
};

export type AgentTraceScopeLike = {
  channelId: string;
  agentId: string;
  instanceId: string;
};

export function agentTraceInstanceIds(instance: SerializedAgentInstance): string[] {
  return Array.from(new Set([instance.id, instance.channelInstanceId].filter(isNonEmptyString)));
}

export function agentTraceScopeMatchesTarget(
  scope: AgentTraceScopeLike,
  target: AgentTraceTargetLike,
  channelId?: string
): boolean {
  if (channelId && scope.channelId !== channelId) return false;
  if (target.channelId && scope.channelId !== target.channelId) return false;
  if (target.id && scope.agentId !== target.id) return false;
  if (target.instanceScoped) {
    if (!target.instanceIds || target.instanceIds.length === 0) return false;
    if (!target.instanceIds.includes(scope.instanceId)) return false;
  }
  return true;
}

export function resolveAgentTraceTargetOwner<T extends AgentTraceTargetLike>(
  target: T,
  agents: readonly AgentTraceOwnerLike[]
): T {
  if (isNonEmptyString(target.ownerUserId) || !isNonEmptyString(target.id)) {
    return target;
  }
  const ownerUserId = agents.find((agent) => agent.id === target.id)?.userId;
  return isNonEmptyString(ownerUserId) ? { ...target, ownerUserId } : target;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
