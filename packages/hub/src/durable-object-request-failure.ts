import { reportError, type ErrorReportContext } from "@xmatrix/protocol/error-reporting";

interface SocketFailure {
  cell: "owner" | "unassigned";
  durationMs: number;
  remote: boolean | "unavailable";
  reason: "internal" | "request_count" | "data_size" | "queue_age" | "request_rate" | "other";
}

// Keep the original platform Error (even a frozen, stackless one) intact.
// Entries disappear with their errors; neither the request nor the owner is retained.
const socketFailures = new WeakMap<object, SocketFailure>();
const OVERLOAD_REASONS = new Map<string, SocketFailure["reason"]>([
  ["Durable Object is overloaded. Too many requests queued.", "request_count"],
  ["Durable Object is overloaded. Too much data queued.", "data_size"],
  ["Durable Object is overloaded. Requests queued for too long.", "queue_age"],
  ["Durable Object is overloaded. Too many requests for the same object within a 10 second window.", "request_rate"],
]);

/** Annotate once at the socket fetch boundary; the HTTP boundary still owns reporting. */
export function recordSocketFetchFailure(error: unknown, cell: SocketFailure["cell"], started: number): void {
  if (!error || typeof error !== "object") return;
  const flags = error as { remote?: unknown; message?: unknown };
  socketFailures.set(error, { cell, durationMs: Math.min(120_000, Math.max(0, Date.now() - started)),
    remote: typeof flags.remote === "boolean" ? flags.remote : "unavailable",
    reason: typeof flags.message === "string" ? OVERLOAD_REASONS.get(flags.message) ??
      (/^internal error; reference = [a-z0-9]+$/u.test(flags.message) ? "internal" : "other") : "other" });
}

function socketMetadata(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const fields = ["cell", "durationMs", "remote", "reason"];
  if (Object.keys(row).length !== fields.length || Object.keys(row).some(key => !fields.includes(key)) ||
      (row.cell !== "owner" && row.cell !== "unassigned") ||
      typeof row.durationMs !== "number" || !Number.isSafeInteger(row.durationMs) || row.durationMs < 0 || row.durationMs > 120_000 ||
      (typeof row.remote !== "boolean" && row.remote !== "unavailable") ||
      !["internal", "other", ...OVERLOAD_REASONS.values()].includes(row.reason as SocketFailure["reason"])) return;
  return `Runtime socket fetch: cell=${row.cell} · durationMs=${row.durationMs} · remote=${row.remote} · reason=${row.reason}`;
}

/** Only code-defined boundaries and route templates, never a URL or path values. */
function safeOperation(value: unknown): string | undefined {
  if (value === "PageSession.fetch" || value === "HarnessReleaseWatch.runtime") return value;
  return typeof value === "string" && value.length <= 240 &&
    /^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD) (?:\*|\/(?:[a-z][a-z-]*[0-9]?|:[A-Za-z]+|\*)(?:\/(?:[a-z][a-z-]*[0-9]?|:[A-Za-z]+|\*))*)$/u.test(value)
    ? value : undefined;
}

/** One original exception report; console capture alone loses the HTTP caller. */
export function reportDurableObjectUnavailable(error: unknown, context?: () => ErrorReportContext): void {
  const flags = error as { retryable?: unknown; overloaded?: unknown };
  const socket = error && typeof error === "object" ? socketFailures.get(error) : undefined;
  const evidence = { operation: safeOperation(context?.().operation) ?? "unavailable",
    retryable: flags.retryable === true, overloaded: flags.overloaded === true, ...(socket ? { socket } : {}) };
  reportError(error, { operation: "durable-object.unavailable",
    fingerprint: ["{{ default }}", "durable-object.unavailable", evidence.operation],
    ids: { durable_object_failure: JSON.stringify(evidence) } });
  console.warn("Durable Object is briefly unavailable", evidence);
}

/** The issue reader exports only this bounded, content-free diagnostic shape. */
export function durableObjectFailureMetadata(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 1024) return [];
  try {
    const item = JSON.parse(value);
    if (!item || typeof item !== "object" || ![3, 4].includes(Object.keys(item).length) ||
        !Object.keys(item).every(key => ["operation", "retryable", "overloaded", "socket"].includes(key)) ||
        (item.operation !== "unavailable" && !safeOperation(item.operation)) ||
        typeof item.retryable !== "boolean" || typeof item.overloaded !== "boolean") return [];
    const socket = "socket" in item ? socketMetadata(item.socket) : undefined;
    if ("socket" in item && !socket) return [];
    return [`Durable Object failure: ${item.operation} · retryable=${item.retryable} · overloaded=${item.overloaded}`,
      ...(socket ? [socket] : [])];
  } catch { return []; }
}
