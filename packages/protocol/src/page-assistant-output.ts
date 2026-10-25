/** Acknowledged normalized assistant text; tool output and diagnostic traces are excluded. */
import { utf8ByteLength } from "./hex.js";

export const PAGE_ASSISTANT_OUTPUT_CAPABILITY = "page_assistant_output_v1";
export const PAGE_COWRITE_OUTPUT_CAPABILITY = "page_cowrite_output_v1";
/** The Page issued this turn on this exact live connection; a reconnect cannot adopt it. */
export interface PageAssistantOutputTarget { page: string; session: string; turn: number }
export interface PageAssistantOutput {
  stream: string;
  startedAt: number;
  seq: number;
  type: "text" | "end" | "cancel";
  text?: string;
  target?: PageAssistantOutputTarget;
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
  const target = v.target as Partial<PageAssistantOutputTarget> | undefined;
  if (target !== undefined && (!target || typeof target !== "object" ||
      typeof target.page !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(target.page) ||
      typeof target.session !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(target.session) ||
      typeof target.turn !== "number" || !Number.isSafeInteger(target.turn) || target.turn < 0)) return null;
  return { stream: v.stream, startedAt: v.startedAt, seq: v.seq, type: v.type,
    ...(target ? { target: { page: target.page!, session: target.session!, turn: target.turn! } } : {}),
    ...(v.type === "text" ? { text: v.text as string } : {}) };
}

