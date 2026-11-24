import { parseDiagnosticEvent, type DiagnosticEvent, type DiagnosticEventSchema } from "./diagnostic-events.js";
import { plainRecord as record } from "./plain-record.js";

/**
 * Hand to xMatrix support (docs/cross-space-read-grants.md#support-handoffs).
 * A person hands one of their conversations to xMatrix support: a one-line
 * description, the parts they ticked, and their explicit agreement. Support
 * reads the ticked parts, read-only, for 14 days or until it is withdrawn.
 */

/** What a handoff can include. Nothing is included unless the person ticks it. */
export const SUPPORT_HANDOFF_PARTS = ["messages", "diagnostics", "logs"] as const;
export type SupportHandoffPart = typeof SUPPORT_HANDOFF_PARTS[number];

export const SUPPORT_HANDOFF_LINE_MAX = 500;
/** The daemon log tail, already redacted on the person's machine. */
export const SUPPORT_HANDOFF_LOG_EXCERPT_MAX = 16_000;
export const SUPPORT_HANDOFF_DAYS = 14;

export interface SupportHandoffRequest {
  line: string;
  parts: SupportHandoffPart[];
  /** Required with the `logs` part, refused without it. */
  logExcerpt?: string;
  /** The person ticked "I agree to let xMatrix support read what I selected". */
  consent: true;
}

export type SupportHandoffStatus = "approved" | "revoked" | "expired";

/** One handoff as the person who made it, their Space's admins, or support read it. */
export interface SupportHandoff {
  id: string;
  /** The person's Space, where the grant lives. */
  spaceId: string;
  /** The conversation handed over. */
  channelId: string;
  /** The support conversation opened for it, in the support Space. */
  supportChannelId: string;
  supportSpaceId: string;
  ownerUserId: string;
  line: string;
  parts: SupportHandoffPart[];
  status: SupportHandoffStatus;
  readCount: number;
  requestedAt: string;
  expiresAt: string;
  lastReadAt?: string;
}

/** Why a request is refused, before it reaches the Hub or at the Hub. */
export function supportHandoffRequestProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "The request must be an object";
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["line", "parts", "logExcerpt", "consent"].includes(key)) return `Unknown field ${key}`;
  }
  if (input.consent !== true) return "Tick the agreement before anything is sent";
  if (typeof input.line !== "string" || !input.line.trim() || input.line.length > SUPPORT_HANDOFF_LINE_MAX) {
    return `Say what went wrong in at most ${SUPPORT_HANDOFF_LINE_MAX} characters`;
  }
  if (!Array.isArray(input.parts) || input.parts.length > SUPPORT_HANDOFF_PARTS.length ||
      new Set(input.parts).size !== input.parts.length ||
      !input.parts.every((part) => (SUPPORT_HANDOFF_PARTS as readonly unknown[]).includes(part))) {
    return "parts must name messages, diagnostics or logs at most once each";
  }
  const logs = input.parts.includes("logs");
  if (logs !== (input.logExcerpt !== undefined)) return "Daemon logs go with the logs part, and only with it";
  if (logs && (typeof input.logExcerpt !== "string" || !input.logExcerpt.trim() ||
      input.logExcerpt.length > SUPPORT_HANDOFF_LOG_EXCERPT_MAX)) {
    return `The log excerpt must be at most ${SUPPORT_HANDOFF_LOG_EXCERPT_MAX} characters`;
  }
  return undefined;
}

export function parseSupportHandoffRequest(value: unknown): SupportHandoffRequest | undefined {
  if (supportHandoffRequestProblem(value)) return undefined;
  const input = value as SupportHandoffRequest;
  return { line: input.line.trim(), parts: [...input.parts], consent: true,
    ...(input.logExcerpt !== undefined ? { logExcerpt: input.logExcerpt } : {}) };
}

/**
 * The daemon log excerpt a person previews before ticking logs. The owner,
 * signed in as a Human, asks one of their own online Machines; its daemon
 * reads only a bounded recent tail of its own log and redacts it on the
 * machine (home paths, emails, URL queries, token-like strings) before it
 * answers. The Hub keeps nothing beyond the command's own result, which only
 * the owner reads; the excerpt reaches support only when the person sends the
 * handoff with it.
 */
export const MACHINE_LOG_EXCERPT_CAPABILITY = "machine_log_excerpt_v1";
/** Unclaimed this long, a request expires instead of running late. */
export const LOG_EXCERPT_CLAIM_TTL_MS = 2 * 60_000;
/** Longest the daemon spends reading its logs. */
export const LOG_EXCERPT_TIMEOUT_MS = 30_000;
export const LOG_EXCERPT_SETTLE_MS = LOG_EXCERPT_CLAIM_TTL_MS + LOG_EXCERPT_TIMEOUT_MS + 60_000;
const LOG_EXCERPT_REQUEST_ID = /^logs:[0-9a-f-]{36}$/u;
const LOG_EXCERPT_ERROR_MAX = 1_024;

export interface LogExcerptRequest { requestId: string }

export interface LogExcerptResult {
  status: "succeeded" | "failed";
  /** On success: the redacted tail, newest lines last. */
  excerpt?: string;
  error?: string;
}

export interface LogExcerptStatus {
  controlId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "expired";
  excerpt?: string;
  error?: string;
  requestedAt?: string;
  completedAt?: string;
}

/** Lines and tabs are a log's shape; any other control character is refused. */
function logText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value);
}

export function parseLogExcerptRequest(value: unknown): LogExcerptRequest {
  const input = record(value);
  if (!input || typeof input.requestId !== "string" || !LOG_EXCERPT_REQUEST_ID.test(input.requestId)) {
    throw new Error("Invalid log excerpt request");
  }
  return { requestId: input.requestId };
}

/** Fail closed: a success carries a bounded excerpt, a failure only its reason. */
export function parseLogExcerptResult(value: unknown): LogExcerptResult {
  const input = record(value);
  if (!input || Object.keys(input).some((key) => !["status", "excerpt", "error"].includes(key))) {
    throw new Error("Log excerpt result is invalid");
  }
  if (input.status === "succeeded" && logText(input.excerpt, SUPPORT_HANDOFF_LOG_EXCERPT_MAX) &&
      input.error === undefined) {
    return { status: "succeeded", excerpt: input.excerpt };
  }
  if (input.status === "failed" && input.excerpt === undefined && logText(input.error, LOG_EXCERPT_ERROR_MAX)) {
    return { status: "failed", error: input.error };
  }
  throw new Error("Log excerpt result is invalid");
}

const LAUNCH_STATES = ["prepared", "queued", "admitted", "spawned", "connected", "failed", "cancelled"] as const;
const TIME = { kind: "number", min: 0, max: 8.64e15, integer: true } as const;

/**
 * One start of an Agent in the conversation, as support's diagnostics show
 * it. Only states, codes, counts and times: an error's message, the prompt
 * and every id are left out, and a row that does not fit is dropped whole
 * (src/diagnostic-events.ts).
 */
export const SUPPORT_LAUNCH_DIAGNOSTIC_EVENT = {
  kind: { kind: "enum", values: ["launch"] },
  state: { kind: "enum", values: LAUNCH_STATES },
  launchKind: { kind: "code", optional: true },
  errorStage: { kind: "code", optional: true },
  errorCode: { kind: "code", optional: true },
  retryable: { kind: "boolean" },
  attempt: { kind: "number", min: 0, max: 1_000_000, integer: true },
  createdAt: TIME,
  finishedAt: { ...TIME, optional: true },
  firstReplyAt: { ...TIME, optional: true },
} as const satisfies DiagnosticEventSchema;

/** One execution's state in the conversation. */
export const SUPPORT_RUN_DIAGNOSTIC_EVENT = {
  kind: { kind: "enum", values: ["run"] },
  status: { kind: "code" },
  createdAt: TIME,
  finishedAt: { ...TIME, optional: true },
} as const satisfies DiagnosticEventSchema;

export type SupportDiagnosticEvent =
  | DiagnosticEvent<typeof SUPPORT_LAUNCH_DIAGNOSTIC_EVENT>
  | DiagnosticEvent<typeof SUPPORT_RUN_DIAGNOSTIC_EVENT>;

/** The event if it passes its declared schema, else nothing. */
export function parseSupportDiagnosticEvent(value: unknown): SupportDiagnosticEvent | undefined {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  if (kind === "launch") return parseDiagnosticEvent(SUPPORT_LAUNCH_DIAGNOSTIC_EVENT, value);
  if (kind === "run") return parseDiagnosticEvent(SUPPORT_RUN_DIAGNOSTIC_EVENT, value);
  return undefined;
}
