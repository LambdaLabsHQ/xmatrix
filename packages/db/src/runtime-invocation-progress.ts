import { cleanAgentRuntimeExecutions, cleanRuntimeOperationFailure } from "@xmatrix/protocol";

/** Presentation evidence only. Never used to authorize or terminalize a Run. */
const PHASES = new Set([
  "relay_register_retrying", "channel_join_retrying", "relay_auth_refresh_retrying", "wrapper_startup_failed",
  "turn_completed", "turn_failed", "turn_unknown", "run_delivery_failed", "runtime_starting", "running",
  "wrapper_starting", "cwd_preparing", "cwd_ready", "auth_resolving", "workspace_registering",
  "relay_registering", "relay_registered", "channel_joined", "runtime_ready", "turn_running", "turn_retrying", "turn_interrupted",
]);
const STARTUP_PHASES = new Set(["wrapper_starting", "cwd_preparing", "cwd_ready", "auth_resolving",
  "workspace_registering", "relay_registering", "relay_registered", "channel_joined",
  "runtime_starting", "runtime_ready", "turn_running"]);
function normalizedPhase(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const phase = /^(codex|zcode|grok|acp)_app_ready$/u.test(value) ? "runtime_ready"
    : /^(codex|zcode|grok|acp)_app_starting$/u.test(value) ? "runtime_starting" : value;
  return PHASES.has(phase) ? phase : undefined;
}
export function invocationProgress(value: unknown, observedAt: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const taskExecution = item.taskExecution && typeof item.taskExecution === "object" && !Array.isArray(item.taskExecution)
    ? cleanAgentRuntimeExecutions(item.taskExecution as Record<string, unknown>) : {};
  const phase = normalizedPhase(item.statusPhase);
  const operationFailure = cleanRuntimeOperationFailure(item.operationFailure);
  const startupSteps: Array<{ phase: string; at: string }> = [];
  for (const raw of Array.isArray(item.startupSteps) ? item.startupSteps.slice(0, 16) : []) {
    const step = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const key = normalizedPhase(step.phase);
    const at = step.atMillis;
    if (key && STARTUP_PHASES.has(key) && !startupSteps.some((step) => step.phase === key) &&
        typeof at === "number" && Number.isSafeInteger(at) && at > 0 && at <= Date.parse(observedAt) + 300_000) {
      startupSteps.push({ phase: key, at: new Date(at).toISOString() });
    }
  }
  const wrapperVersion = typeof item.wrapperVersion === "string" && item.wrapperVersion.length <= 80 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(item.wrapperVersion) ? item.wrapperVersion : undefined;
  const readyMs = item.wrapperReadyAtMillis;
  const wrapperReadyAt = typeof readyMs === "number" && Number.isSafeInteger(readyMs) && readyMs > 0 &&
    readyMs <= Date.parse(observedAt) + 300_000 ? new Date(readyMs).toISOString() : undefined;
  if (!phase && !wrapperReadyAt && !startupSteps.length && !Object.keys(taskExecution).length && !operationFailure) return undefined;
  const retry = item.connectionRetry && typeof item.connectionRetry === "object"
    ? item.connectionRetry as Record<string, unknown> : {};
  const attempt = retry.attempt;
  const nextMs = retry.nextAttemptAtMillis;
  const nextAttemptAt = typeof nextMs === "number" && Number.isSafeInteger(nextMs) && nextMs > 0 &&
    nextMs <= Date.parse(observedAt) + 300_000 ? new Date(nextMs).toISOString() : undefined;
  const connectionRetry = typeof attempt === "number" && Number.isSafeInteger(attempt) &&
    attempt >= 1 && attempt <= 1_000_000 ? { attempt,
      ...(["registration", "channel_join", "credential_refresh"].includes(String(retry.kind)) ? { kind: retry.kind } : {}), ...(nextAttemptAt ? { nextAttemptAt } : {}) } : undefined;
  const phaseErrorCode = phase === "wrapper_startup_failed" ? "runtime.startup_failed"
    : phase === "channel_join_retrying" ? "relay.channel_join_retrying"
    : phase === "relay_register_retrying" ? "relay.registration_retrying"
      : phase === "relay_auth_refresh_retrying" ? "relay.credential_refresh_retrying"
        : phase === "turn_unknown" ? "runtime.turn_outcome_unknown"
          : phase === "turn_failed" ? "runtime.turn_failed"
          : phase === "run_delivery_failed" ? "reply.delivery_failed" : undefined;
  const diagnosticId = operationFailure?.diagnosticId ?? (typeof item.runStatusDetail === "string"
    ? /\bdiag_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/u.exec(item.runStatusDetail)?.[0]
    : undefined);
  const errorCode = operationFailure?.code ?? phaseErrorCode;
  return { ...(phase ? { phase } : {}), observedAt,
    ...(operationFailure ? { operationFailure } : {}),
    ...(Object.keys(taskExecution).length ? { taskExecution } : {}),
    ...(wrapperVersion ? { wrapperVersion } : {}),
    ...(startupSteps.length ? { startupSteps } : {}),
    ...(connectionRetry ? { connectionRetry } : {}),
    ...(diagnosticId ? { diagnosticId } : {}),
    ...(wrapperReadyAt ? { wrapperReadyAt } : {}), ...(errorCode ? { errorCode } : {}) };
}

/** Imported/legacy metadata must meet the same projection allowlist as reports. */
export function readInvocationProgress(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  if (typeof record.observedAt !== "string" || !Number.isFinite(Date.parse(record.observedAt))) return {};
  const retry = record.connectionRetry && typeof record.connectionRetry === "object"
    ? record.connectionRetry as Record<string, unknown> : {};
  return invocationProgress({ statusPhase: record.phase, wrapperVersion: record.wrapperVersion,
    operationFailure: record.operationFailure,
    taskExecution: record.taskExecution,
    startupSteps: Array.isArray(record.startupSteps) ? record.startupSteps.slice(0, 16).map((raw) => {
      const step = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return { phase: step.phase, atMillis: typeof step.at === "string" ? Date.parse(step.at) : undefined };
    }) : undefined,
    connectionRetry: { attempt: retry.attempt, kind: retry.kind,
      nextAttemptAtMillis: typeof retry.nextAttemptAt === "string" ? Date.parse(retry.nextAttemptAt) : undefined },
    wrapperReadyAtMillis: typeof record.wrapperReadyAt === "string" ? Date.parse(record.wrapperReadyAt) : undefined,
    runStatusDetail: typeof record.diagnosticId === "string" ? record.diagnosticId : undefined,
  }, record.observedAt) ?? {};
}
