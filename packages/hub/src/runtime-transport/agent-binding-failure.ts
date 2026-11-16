import { reportError } from "@xmatrix/protocol/error-reporting";

const SOURCES = ["connect_message", "authority_snapshot", "authority_binding", "refresh_principal"] as const;
const FIELDS = ["token", "ownerUserId", "agentId", "agentName", "spaceId", "runId", "executionKey",
  "channelId", "machineId", "instanceId", "status", "instanceStatus"] as const;

export type AgentBindingFailure = {
  source: typeof SOURCES[number];
  field: typeof FIELDS[number];
};

/** Only the failed comparison's fixed label, never either compared value. */
export function reportAgentBindingFailure(error: Error, diagnosticId: string, evidence: AgentBindingFailure): void {
  reportError(error, { operation: "runtime.agent-binding",
    fingerprint: ["agent-run-binding", evidence.source, evidence.field],
    ids: { diagnosticId, agent_binding_source: evidence.source, agent_binding_field: evidence.field } });
}

/** The connector never exports arbitrary context, identity or credential values. */
export function agentBindingFailureMetadata(extra: Record<string, unknown>): string[] {
  const source = extra.agent_binding_source, field = extra.agent_binding_field;
  return SOURCES.some(value => value === source) && FIELDS.some(value => value === field)
    ? [`Agent binding failure: ${source} · ${field}`] : [];
}
