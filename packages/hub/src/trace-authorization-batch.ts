export interface TraceAuthorizationCheck {
  userId: string;
  channelId: string;
}

export interface TraceAuthorizationDecision extends TraceAuthorizationCheck {
  allowed: boolean;
}

export function traceAuthorizationChecksForChannels(
  userId: string,
  channelIds: readonly string[],
): TraceAuthorizationCheck[] {
  return Array.from(new Set(channelIds), (channelId) => ({ userId, channelId }));
}

export function authorizedTraceChannelIds(
  value: unknown,
  instanceId: string,
  userId: string,
  requestedChannelIds: readonly string[],
): Set<string> | null {
  return authorizedTraceDecisionValues(
    value,
    instanceId,
    new Set(requestedChannelIds),
    (decision) => decision.userId === userId ? decision.channelId : null,
  );
}

function authorizedTraceDecisionValues(
  value: unknown,
  instanceId: string,
  requestedValues: ReadonlySet<string>,
  valueForDecision: (decision: TraceAuthorizationDecision) => string | null,
): Set<string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.instanceId !== instanceId || !Array.isArray(result.decisions)) return null;
  const seen = new Set<string>();
  const authorized = new Set<string>();
  for (const raw of result.decisions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const decision = raw as Record<string, unknown>;
    if (typeof decision.userId !== "string" || typeof decision.channelId !== "string" ||
        typeof decision.allowed !== "boolean") return null;
    const decisionValue = valueForDecision(decision as unknown as TraceAuthorizationDecision);
    if (decisionValue === null || !requestedValues.has(decisionValue) || seen.has(decisionValue)) {
      return null;
    }
    seen.add(decisionValue);
    if (decision.allowed) authorized.add(decisionValue);
  }
  return seen.size === requestedValues.size ? authorized : null;
}
