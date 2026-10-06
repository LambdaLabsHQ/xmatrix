import { utf8ByteLength } from "./hex.js";
import { hasControlCharacter } from "./field-validation.js";
import type { AgentRuntimeExecutionEvidence, AgentRuntimeMessageSource } from "./authority-foundation.js";
import { messagePublicationEvidence } from "./message-publication.js";

export const AGENT_EXECUTION_SOURCE_LIMIT = 100;
export const AGENT_EXECUTION_HISTORY_LIMIT = 8;
export const AGENT_EXECUTION_WIRE_BUDGET = 128 * 1024;

function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && utf8ByteLength(value) <= 300 &&
    value.trim() === value && !hasControlCharacter(value) && !/[\u0080-\u009f]/u.test(value);
}

/** Sanitize reported evidence; this never substitutes for source/Run authorization. */
export function cleanAgentRuntimeExecution(value: unknown): AgentRuntimeExecutionEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (!id(input.executionId) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1 ||
      !Number.isSafeInteger(input.sourceCount) || Number(input.sourceCount) < 0 || Number(input.sourceCount) > AGENT_EXECUTION_SOURCE_LIMIT ||
      !Array.isArray(input.sources) || input.sources.length > Number(input.sourceCount) ||
      typeof input.state !== "string" || !["accepted", "running", "completed", "failed", "interrupted", "unknown"].includes(input.state) ||
      !Number.isSafeInteger(input.startedAtMillis) || Number(input.startedAtMillis) < 0 ||
      !Number.isSafeInteger(input.updatedAtMillis) || Number(input.updatedAtMillis) < Number(input.startedAtMillis) ||
      Number(input.updatedAtMillis) > 8_640_000_000_000_000) return undefined;
  const terminal = input.state !== "accepted" && input.state !== "running";
  if (input.inputDisposition !== undefined && !["pending", "submitted", "resumed_existing"].includes(input.inputDisposition as string)) return undefined;
  if (input.inputDisposition === "resumed_existing" && Number(input.sourceCount) > 0 &&
      input.state !== "accepted" && input.state !== "unknown") return undefined;
  if (terminal !== (input.finishedAtMillis !== undefined) || (terminal &&
      (!Number.isSafeInteger(input.finishedAtMillis) || Number(input.finishedAtMillis) < Number(input.startedAtMillis) ||
        Number(input.finishedAtMillis) > Number(input.updatedAtMillis)))) return undefined;
  const seen = new Set<string>();
  const sources: AgentRuntimeMessageSource[] = [];
  for (const raw of input.sources) {
    const source = cleanAgentRuntimeMessageSource(raw);
    if (!source) return undefined;
    const key = JSON.stringify([source.channelId, source.messageId]);
    if (seen.has(key)) return undefined;
    seen.add(key);
    sources.push(source);
  }
  return { executionId: input.executionId, revision: Number(input.revision), sourceCount: Number(input.sourceCount),
    sources, state: input.state as AgentRuntimeExecutionEvidence["state"],
    ...(input.inputDisposition !== undefined ? { inputDisposition: input.inputDisposition as AgentRuntimeExecutionEvidence["inputDisposition"] } : {}),
    startedAtMillis: Number(input.startedAtMillis), updatedAtMillis: Number(input.updatedAtMillis),
    ...(terminal ? { finishedAtMillis: Number(input.finishedAtMillis) } : {}) };
}

export function cleanAgentRuntimeExecutions(input: Record<string, unknown>) {
  let execution = cleanAgentRuntimeExecution(input.execution);
  let bytes = execution ? utf8ByteLength(JSON.stringify(execution)) : 0;
  if (bytes > AGENT_EXECUTION_WIRE_BUDGET) { execution = undefined; bytes = 0; }
  const recentExecutions: AgentRuntimeExecutionEvidence[] = [];
  const seen = new Set(execution ? [execution.executionId] : []);
  if (Array.isArray(input.recentExecutions)) {
    for (const raw of input.recentExecutions.slice(-AGENT_EXECUTION_HISTORY_LIMIT).reverse()) {
      const entry = cleanAgentRuntimeExecution(raw);
      if (!entry || entry.finishedAtMillis === undefined || seen.has(entry.executionId)) continue;
      const size = utf8ByteLength(JSON.stringify(entry));
      if (bytes + size > AGENT_EXECUTION_WIRE_BUDGET) continue;
      bytes += size;
      seen.add(entry.executionId);
      recentExecutions.unshift(entry);
    }
  }
  return { ...(execution ? { execution } : {}), ...(recentExecutions.length ? { recentExecutions } : {}) };
}

export function cleanAgentRuntimeMessageSource(raw: unknown): AgentRuntimeMessageSource | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const publication = messagePublicationEvidence(source);
  if (!publication || !id(source.channelId) || !id(source.messageId) ||
      !Number.isSafeInteger(source.sequence) || Number(source.sequence) < 1) return undefined;
  return { channelId: source.channelId, messageId: source.messageId, sequence: Number(source.sequence), ...publication };
}
