/** Acknowledged normalized assistant text; tool output and diagnostic traces are excluded. */
import { utf8ByteLength } from "./hex.js";

export const PAGE_ASSISTANT_OUTPUT_CAPABILITY = "page_assistant_output_v1";
export interface PageAssistantOutput {
  stream: string;
  startedAt: number;
  seq: number;
  type: "text" | "end" | "cancel";
  text?: string;
}
export interface PageAssistantOutputAck {
  stream: string;
  seq: number;
  at: number;
  status: "accepted" | "limited" | "unknown" | "rejected";
  retryAfterMs?: number;
  problems: string[];
}
export function parsePageAssistantOutput(value: unknown): PageAssistantOutput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.stream !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(v.stream) ||
      typeof v.startedAt !== "number" || !Number.isSafeInteger(v.startedAt) ||
      typeof v.seq !== "number" || !Number.isSafeInteger(v.seq) || v.seq < 0 ||
      (v.type !== "text" && v.type !== "end" && v.type !== "cancel") ||
      (v.type === "text" && (typeof v.text !== "string" || utf8ByteLength(v.text) > 4096)) ||
      (v.type !== "text" && v.text !== undefined)) return null;
  return { stream: v.stream, startedAt: v.startedAt, seq: v.seq, type: v.type,
    ...(v.type === "text" ? { text: v.text as string } : {}) };
}

