import { parseDiagnosticEvent, type DiagnosticEvent, type DiagnosticEventSchema } from "./diagnostic-events.js";

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
