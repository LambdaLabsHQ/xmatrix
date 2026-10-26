import type { AgentFailureEvidence } from "@xmatrix/protocol";

export type TurnProblem = "rate_limited" | "provider_refused" | "unreachable" | "process_exited" | "no_status" | "unknown";

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
  // No labelled status, code, close, or exit: the harness ended the turn and named nothing further.
  if (evidence.category === "provider" && !evidence.httpStatuses.length && !evidence.codes.length
    && !evidence.websocketCloseCodes.length && !evidence.exitCodes.length) return "no_status";
  return "unknown";
}

/** A later message from this Agent, enough to tell that a failed turn was followed. */
export type TurnFailureSpeaker = {
  id: string;
  author?: string;
  senderKind?: string;
  senderInstanceId?: string;
  recalledAt?: string;
  sendStatus?: string;
  provenance?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Turn-failure notices that the same Agent followed with its own later message.
 * A human reply, another failure, or a system notice leaves the card asking for a reply.
 */
export function turnFailuresContinuedByLaterSpeech(items: readonly TurnFailureSpeaker[]): ReadonlySet<string> {
  const openByKey = new Map<string, string[]>();
  const continued = new Set<string>();
  const keyOf = (item: TurnFailureSpeaker): string | undefined => {
    if (item.senderKind !== "agent" || item.recalledAt) return undefined;
    if (item.senderInstanceId) return `i:${item.senderInstanceId}`;
    const author = item.author?.trim();
    return author ? `a:${author}` : undefined;
  };
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    if (item.sendStatus === "pending" || item.sendStatus === "unconfirmed" || item.sendStatus === "failed") continue;
    if (turnFailureEvidenceOf(item.metadata)) {
      openByKey.set(key, [...(openByKey.get(key) ?? []), item.id]);
      continue;
    }
    if (item.provenance) continue;
    for (const id of openByKey.get(key) ?? []) continued.add(id);
    openByKey.delete(key);
  }
  return continued;
}
