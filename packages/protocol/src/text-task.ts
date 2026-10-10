import { utf8ByteLength as bytes } from "./hex.js";

/**
 * One bounded piece of text work a Machine does for the Hub: an instruction
 * and the text it is about go to a harness, one piece of text comes back. The
 * harness starts fresh for every task, with no Run token, no tools and no
 * channel, so a task is isolated from every other and from the Space.
 */
export const MACHINE_TEXT_TASK_CAPABILITY = "machine_text_task_v1";

/** The harnesses with a one-shot mode a daemon knows how to start. */
export const TEXT_TASK_HARNESSES: readonly string[] = ["claude", "codex"];

export const TEXT_TASK_INSTRUCTION_MAX_BYTES = 4 * 1024;
export const TEXT_TASK_INPUT_MAX_BYTES = 256 * 1024;
export const TEXT_TASK_OUTPUT_MAX_BYTES = 16 * 1024;
/** A task nobody claimed in this long is dropped: its answer would describe old text. */
export const TEXT_TASK_CLAIM_TTL_MS = 5 * 60 * 1_000;

export const TEXT_TASK_STATUSES = ["completed", "unavailable", "failed"] as const;
export type TextTaskStatus = typeof TEXT_TASK_STATUSES[number];

export interface TextTaskRequest { requestId: string; presetId: string; instruction: string; input: string }
export interface TextTaskResult { presetId: string; status: TextTaskStatus; text?: string; reason?: string }


function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Text task is not an object");
  return value as Record<string, unknown>;
}

/** The task as the Hub issues it; anything else is refused before a daemon sees it. */
export function parseTextTaskRequest(value: unknown): TextTaskRequest {
  const task = record(value);
  const { requestId, presetId, instruction, input } = task;
  if (typeof requestId !== "string" || !requestId || requestId.length > 200) throw new Error("Text task has no request id");
  if (typeof presetId !== "string" || !TEXT_TASK_HARNESSES.includes(presetId)) throw new Error("Text task names no one-shot harness");
  if (typeof instruction !== "string" || !instruction.trim() || bytes(instruction) > TEXT_TASK_INSTRUCTION_MAX_BYTES) {
    throw new Error("Text task instruction is empty or too long");
  }
  if (typeof input !== "string" || bytes(input) > TEXT_TASK_INPUT_MAX_BYTES) throw new Error("Text task input is too long");
  return { requestId, presetId, instruction, input };
}

/** A daemon's answer to the task it was issued; an answer about another harness is not one. */
export function parseTextTaskResult(value: unknown, request: Pick<TextTaskRequest, "presetId">): TextTaskResult {
  const result = record(value);
  if (Object.keys(result).some((key) => !["presetId", "status", "text", "reason"].includes(key))) {
    throw new Error("Text task result has an unexpected field");
  }
  const { presetId, status, text, reason } = result;
  if (presetId !== request.presetId) throw new Error("Text task result names another harness");
  if (typeof status !== "string" || !(TEXT_TASK_STATUSES as readonly string[]).includes(status)) {
    throw new Error("Text task result has an unknown status");
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 400)) throw new Error("Text task reason is invalid");
  if (status === "completed") {
    if (typeof text !== "string" || !text.trim() || bytes(text) > TEXT_TASK_OUTPUT_MAX_BYTES) {
      throw new Error("Text task answered nothing or too much");
    }
    return { presetId: request.presetId, status, text };
  }
  if (text !== undefined) throw new Error("Only a completed text task carries text");
  return { presetId: request.presetId, status: status as TextTaskStatus, ...(reason ? { reason } : {}) };
}
