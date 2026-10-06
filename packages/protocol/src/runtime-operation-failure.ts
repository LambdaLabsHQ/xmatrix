/** Bounded diagnostic evidence; never an authorization or retry command. */
export interface RuntimeOperationFailure {
  code: string;
  diagnosticId: string;
  retryable: boolean;
  stage: string;
  originStage?: string;
}

export function cleanRuntimeOperationFailure(value: unknown): RuntimeOperationFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_.-]{0,79}$/u.test(value);
  if (!identifier(record.code) || !identifier(record.stage) || typeof record.retryable !== "boolean" ||
      typeof record.diagnosticId !== "string" || !/^diag_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(record.diagnosticId) ||
      record.originStage !== undefined && !identifier(record.originStage)) return undefined;
  return { code: record.code, diagnosticId: record.diagnosticId, retryable: record.retryable, stage: record.stage,
    ...(record.originStage ? { originStage: record.originStage as string } : {}) };
}
