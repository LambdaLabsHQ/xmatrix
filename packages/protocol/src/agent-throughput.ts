import { hasControlCharacter } from "./field-validation.js";

/** Actual output tokens per inference time, including provider/network waits
 * and excluding local tool execution. Never a task-success or quality score. */
export interface AgentThroughputObservation {
  model: string;
  effort?: string;
  observedAt: string;
  outputTokens: number;
  inferenceMs: number;
  samples: number;
}

/** Only numeric, scoped, recent facts survive a runtime report. The observation
 * time belongs to the completed inference, never the heartbeat carrying it. */
export function agentThroughputObservation(value: unknown, now: number): AgentThroughputObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isFinite(now)) return undefined;
  const row = value as Record<string, unknown>;
  const text = (value: unknown, limit: number): value is string => typeof value === "string" &&
    value.length > 0 && value.length <= limit && !hasControlCharacter(value);
  const integer = (value: unknown, min: number, max: number): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
  const observed = typeof row.observedAt === "string" ? Date.parse(row.observedAt) : NaN;
  if (!text(row.model, 160) || row.effort !== undefined && !text(row.effort, 80) ||
    !Number.isFinite(observed) || observed > now || now - observed > 30 * 60_000 ||
    !integer(row.samples, 1, 64) || !integer(row.outputTokens, 32, 100_000_000) ||
    !integer(row.inferenceMs, 100, 64 * 600_000) || row.outputTokens / row.inferenceMs > 1000) return undefined;
  return { model: row.model, ...(row.effort !== undefined ? { effort: row.effort } : {}),
    observedAt: new Date(observed).toISOString(), outputTokens: row.outputTokens,
    inferenceMs: row.inferenceMs, samples: row.samples };
}
