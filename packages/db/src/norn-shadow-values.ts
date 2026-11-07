import { commandFields } from "./command-fields.js";
import { ControlError } from "./control-error.js";

export class NornShadowError extends ControlError {}
export const shadowFields = commandFields(field => new NornShadowError("invalid_norn_comparison",400,`${field} is invalid`));
export const NORN_SHADOW_HOST = "xmatrix-shadow:1";
export const NORN_SHADOW_MAPPING = "execution-final-receipt:1";
export type ShadowState = "ready" | "waiting" | "completed" | "failed" | "incomplete" | "revoked";
export type ShadowClassification = "equivalent" | "intentional_difference" | "unexpected" | "incomplete";
export interface ShadowEvidence {
  id: string;
  runId: string;
  instanceId: string;
  executionId: string;
  finalReplyId: string | null;
  declaration: string;
  observedAt: number;
}
export interface ShadowSelection {
  bindingId: string;
  participant: string;
  sourceRef: string;
}
export interface ShadowTransition {
  snapshot: unknown;
  state: ShadowState;
  due: number | null;
  kind: string;
  classification: ShadowClassification;
  reason: string;
  outcomeTag?: string | null;
  intent?: { operation: string; digest: string } | null;
  disposition?: "consumed" | "late" | "obsolete";
}
/** Pure evaluator: no database, fetch, dispatch, message, approval or model port. */
export interface NornShadowEvaluator {
  readonly abi: string;
  create(ast: string, now: number): { codeId: string; snapshot: unknown };
  advance(ast: string, snapshot: unknown, selection: ShadowSelection, evidence: ShadowEvidence | null, now: number): ShadowTransition;
}
export function comparisonId(value: unknown): string {
  const id = shadowFields.text(value,"comparisonId",36);
  if (id !== value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) {
    throw new NornShadowError("invalid_norn_comparison",400,"comparisonId is invalid");
  }
  return id;
}
/** Admission policy, not a language limit. No raw captured messages are stored. */
export function comparisonJson(value: unknown): string {
  const result = JSON.stringify(value);
  if (!result || new TextEncoder().encode(result).byteLength > 256 * 1024) {
    throw new NornShadowError("norn_comparison_capacity",413,"Comparison checkpoint exceeds its storage budget");
  }
  return result;
}
