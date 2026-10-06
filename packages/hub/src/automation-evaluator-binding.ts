import { plainRecord } from "@xmatrix/protocol";
export type AutomationEvaluatorBinding = {
  actor: { kind: "user" | "agent"; id: string };
  authorityRootUserId: string;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return plainRecord(value);
}

export function automationEvaluatorBinding(value: unknown): AutomationEvaluatorBinding | undefined {
  const automation = object(value);
  if (!automation) return undefined;
  const storedInput = object(automation.input);
  const envRef = object(storedInput?.envRef);
  const candidateActor = object(envRef?.actor);
  const actor = candidateActor
    ? (candidateActor.kind === "user" || candidateActor.kind === "agent") &&
        typeof candidateActor.id === "string" && candidateActor.id
      ? candidateActor as AutomationEvaluatorBinding["actor"]
      : undefined
    // Only an Agent-created Automation stores its actor; one without it is
    // Human-owned and acts as its owner.
    : typeof automation.ownerUserId === "string" && automation.ownerUserId
      ? { kind: "user" as const, id: automation.ownerUserId }
      : undefined;
  const hasStoredAuthority = envRef && Object.prototype.hasOwnProperty.call(envRef, "authorityRootUserId");
  const authorityRootUserId = hasStoredAuthority
    ? typeof envRef?.authorityRootUserId === "string" && envRef.authorityRootUserId
      ? envRef.authorityRootUserId
      : undefined
    : typeof automation.authorityRootUserId === "string" && automation.authorityRootUserId
      ? automation.authorityRootUserId
      : undefined;
  return actor && authorityRootUserId ? { actor, authorityRootUserId } : undefined;
}
