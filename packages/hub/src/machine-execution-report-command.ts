export function executionReportCommand(principal: { ownerUserId: string; machineId: string; hostId: string }, raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const scope = body.scope as Record<string, unknown> | undefined;
  if (Object.keys(body).some(key => !["schemaVersion", "requestId", "scope", "report"].includes(key)) ||
      !scope || typeof scope !== "object" || Array.isArray(scope) ||
      Object.keys(scope).some(key => !["hubOrigin", "channelId", "agentId", "runId", "instanceId", "executionFingerprint"].includes(key)) ||
      typeof body.requestId !== "string" || !/^[0-9a-f-]{36}$/u.test(body.requestId) ||
      typeof scope.channelId !== "string" || !scope.channelId || scope.channelId.length > 300) return null;
  return { commandId: `machine-execution:${body.requestId}`, action: "report",
    eventType: "machine_execution_report", channelId: scope.channelId, payload: body,
    ownerUserId: principal.ownerUserId, machineId: principal.machineId, hostId: principal.hostId,
    principal: { kind: "machine", ownerUserId: principal.ownerUserId, machineId: principal.machineId, hostId: principal.hostId },
  };
}
