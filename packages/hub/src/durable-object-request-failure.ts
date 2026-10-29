import { reportError, type ErrorReportContext } from "@xmatrix/protocol/error-reporting";

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
  const evidence = { operation: safeOperation(context?.().operation) ?? "unavailable",
    retryable: flags.retryable === true, overloaded: flags.overloaded === true };
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
    if (!item || typeof item !== "object" || Object.keys(item).length !== 3 ||
        !Object.keys(item).every(key => ["operation", "retryable", "overloaded"].includes(key)) ||
        (item.operation !== "unavailable" && !safeOperation(item.operation)) ||
        typeof item.retryable !== "boolean" || typeof item.overloaded !== "boolean") return [];
    return [`Durable Object failure: ${item.operation} · retryable=${item.retryable} · overloaded=${item.overloaded}`];
  } catch { return []; }
}
