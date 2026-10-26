import type { AgentFailureEvidence } from "@xmatrix/protocol";

export type TurnProblem = "rate_limited" | "provider_refused" | "unreachable" | "process_exited" | "unknown";

const EVIDENCE_CATEGORIES = new Set(["http", "timeout", "dns", "tls", "connection", "process", "rpc", "provider"]);

/** The evidence the Hub recorded on a failed turn's notice (agentFailureEvidence), or null for an older notice. */
export function turnFailureEvidenceOf(metadata: Record<string, unknown> | undefined): AgentFailureEvidence | null {
  if (metadata?.xmatrixTurnFailure !== true) return null;
  const value = metadata.xmatrixFailureEvidence;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const evidence = value as Record<string, unknown>;
  const numbers = (key: string) => Array.isArray(evidence[key]) ? (evidence[key] as unknown[]).filter((item): item is number => Number.isSafeInteger(item)) : [];
  const strings = (key: string) => Array.isArray(evidence[key]) ? (evidence[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
  if (typeof evidence.category !== "string" || !EVIDENCE_CATEGORIES.has(evidence.category)) return null;
  return { category: evidence.category as AgentFailureEvidence["category"], httpStatuses: numbers("httpStatuses"), codes: strings("codes"),
    requestIds: strings("requestIds"), websocketCloseCodes: numbers("websocketCloseCodes"), exitCodes: numbers("exitCodes") };
}

/** What the recorded evidence says went wrong; only labelled facts decide, never the prose. */
export function turnProblem(evidence: AgentFailureEvidence): TurnProblem {
  if (evidence.httpStatuses.includes(429)) return "rate_limited";
  if (evidence.httpStatuses.some((status) => status === 401 || status === 403)) return "provider_refused";
  if (["timeout", "dns", "tls", "connection"].includes(evidence.category)) return "unreachable";
  if (evidence.category === "process") return "process_exited";
  return "unknown";
}
