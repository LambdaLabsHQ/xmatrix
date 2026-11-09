import { AppControlError, databaseFailureEvidence } from "@xmatrix/db";
import { ProviderRequestError } from "./http";

const PHASES = ["current", "grant", "app", "snapshot", "stage", "route", "deliver", "automation",
  "delivered", "finish", "unknown"] as const;
const KINDS = ["provider", "app_control", "database", "transport", "unclassified"] as const;
const PROVIDER_KINDS = ["http_status", "response_too_large", "proxy_contract", "provider_status",
  "message_contract", "unclassified"] as const;
const TRANSPORT = ["AbortError", "TimeoutError", "TypeError"] as const;
const LIMIT = 8;
const FIELDS = ["phase", "status", "kind", "code", "retryRecorded"] as const;

/** Fixed watch diagnostics. Never a bundle id, product id, credential or provider body. */
export interface AppleCommerceWatchEvidence {
  phase: typeof PHASES[number];
  status: number;
  kind: typeof KINDS[number];
  code: string;
  retryRecorded: boolean;
}

const recorded = new WeakMap<object, readonly AppleCommerceWatchEvidence[]>();
const phases = new WeakMap<object, AppleCommerceWatchEvidence["phase"]>();

export function markAppleCommerceWatchPhase(error: unknown, phase: AppleCommerceWatchEvidence["phase"]): void {
  if (error && typeof error === "object" && PHASES.includes(phase)) phases.set(error, phase);
}

export function appleCommerceWatchPhase(error: unknown): AppleCommerceWatchEvidence["phase"] {
  if (!error || typeof error !== "object") return "unknown";
  return phases.get(error) ?? "unknown";
}

function httpStatus(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : 0;
}

/** Collapse one rejection to the fields the next event can show. */
export function classifyAppleCommerceWatchFailure(error: unknown, phase: AppleCommerceWatchEvidence["phase"],
  retryRecorded: boolean): AppleCommerceWatchEvidence {
  const safePhase = PHASES.includes(phase) ? phase : "unknown";
  const recordedRetry = retryRecorded === true;
  const database = databaseFailureEvidence(error)[0];
  if (database) return { phase: safePhase, status: 0, kind: "database", code: database.code, retryRecorded: recordedRetry };
  if (error instanceof ProviderRequestError) return { phase: safePhase, status: httpStatus(error.status), kind: "provider",
    code: PROVIDER_KINDS.includes(error.failureKind) ? error.failureKind : "unclassified", retryRecorded: recordedRetry };
  if (error instanceof AppControlError) return { phase: safePhase, status: httpStatus(error.status), kind: "app_control",
    code: /^[a-z][a-z0-9_]{0,63}$/u.test(error.code) ? error.code : "unclassified", retryRecorded: recordedRetry };
  if (error instanceof Error && TRANSPORT.includes(error.name as typeof TRANSPORT[number])) {
    return { phase: safePhase, status: 0, kind: "transport", code: error.name, retryRecorded: recordedRetry };
  }
  return { phase: safePhase, status: 0, kind: "unclassified", code: "unclassified", retryRecorded: recordedRetry };
}

/** The issue reader accepts only this exact bounded projection from Sentry. */
export function parseAppleCommerceWatchEvidence(value: unknown): AppleCommerceWatchEvidence[] {
  if (!Array.isArray(value) || value.length > LIMIT) return [];
  const result: AppleCommerceWatchEvidence[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (Object.keys(row).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(row, key)) ||
        typeof row.phase !== "string" || !PHASES.includes(row.phase as AppleCommerceWatchEvidence["phase"]) ||
        typeof row.status !== "number" || !Number.isSafeInteger(row.status) ||
        (row.status !== 0 && (row.status < 100 || row.status > 599)) ||
        typeof row.kind !== "string" || !KINDS.includes(row.kind as AppleCommerceWatchEvidence["kind"]) ||
        typeof row.code !== "string" || !/^[A-Za-z0-9_]{1,64}$/u.test(row.code) ||
        typeof row.retryRecorded !== "boolean") return [];
    result.push({ phase: row.phase as AppleCommerceWatchEvidence["phase"], status: row.status,
      kind: row.kind as AppleCommerceWatchEvidence["kind"], code: row.code, retryRecorded: row.retryRecorded });
  }
  return result;
}

export function recordAppleCommerceWatchFailure(error: unknown, rows: readonly AppleCommerceWatchEvidence[]): void {
  const safe = parseAppleCommerceWatchEvidence([...rows]);
  if (error && typeof error === "object" && safe.length) recorded.set(error, Object.freeze(safe));
}

/** Follow only Error causes and aggregate children, with cycle and size bounds. */
export function appleCommerceWatchEvidence(error: unknown): readonly AppleCommerceWatchEvidence[] {
  const seen = new Set<Error>();
  const visit = (value: unknown): AppleCommerceWatchEvidence[] => {
    if (!(value instanceof Error) || seen.has(value) || seen.size >= LIMIT) return [];
    seen.add(value);
    const own = recorded.get(value);
    if (own) return [...own];
    return value instanceof AggregateError ? value.errors.slice(0, LIMIT).flatMap(visit) : visit(value.cause);
  };
  return visit(error).slice(0, LIMIT);
}
