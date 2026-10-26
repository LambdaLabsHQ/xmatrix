import type { AgentFailureEvidence } from "@xmatrix/protocol";

export type TurnProblem = "usage_limited" | "rate_limited" | "provider_refused" | "unreachable" | "process_exited" | "unknown";

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
  const limit = evidence.usageLimit;
  const usageLimit = limit && typeof limit === "object" && !Array.isArray(limit) ? limit as Record<string, unknown> : undefined;
  const resetsAt = typeof usageLimit?.resetsAt === "string" && Number.isFinite(Date.parse(usageLimit.resetsAt))
    ? usageLimit.resetsAt : undefined;
  return { category: evidence.category as AgentFailureEvidence["category"], httpStatuses: numbers("httpStatuses"), codes: strings("codes"),
    requestIds: strings("requestIds"), websocketCloseCodes: numbers("websocketCloseCodes"), exitCodes: numbers("exitCodes"),
    ...(usageLimit ? { usageLimit: resetsAt ? { resetsAt } : {} } : {}) };
}

/** The original cause line remains visible, including for notices from older Hubs. No classification from prose. */
export function turnFailureSummary(body: string): string | undefined {
  const line = body.split(/\r?\n/u)[0] ?? "";
  const prefix = /^xMatrix could not complete this .+? turn(?::\s*|\.$)/u;
  if (!prefix.test(line)) return undefined;
  return line.replace(prefix, "").trim().slice(0, 600) || undefined;
}

/** What the recorded evidence says went wrong; only labelled facts decide, never the prose. */
export function turnProblem(evidence: AgentFailureEvidence): TurnProblem {
  if (evidence.usageLimit) return "usage_limited";
  if (evidence.httpStatuses.includes(429)) return "rate_limited";
  if (evidence.httpStatuses.some((status) => status === 401 || status === 403)) return "provider_refused";
  if (["timeout", "dns", "tls", "connection"].includes(evidence.category)) return "unreachable";
  if (evidence.category === "process") return "process_exited";
  return "unknown";
}
