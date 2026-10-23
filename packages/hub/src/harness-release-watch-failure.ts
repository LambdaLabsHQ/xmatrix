/** Fixed transport diagnostics; no registry, daemon, request or response content. */
export interface HarnessReleaseWatchEvidence {
  phase: "runtime_fetch" | "response_body" | "response_contract";
  durationMs: number;
  responseStatus: number;
  retryable: boolean;
  overloaded: boolean;
}

/** Preserve the originating rejection and a local stack without replaying a partial pass. */
export class HarnessReleaseWatchFailure extends Error {
  readonly evidence: HarnessReleaseWatchEvidence;

  constructor(cause: unknown, phase: HarnessReleaseWatchEvidence["phase"], started: number, responseStatus: number) {
    super(`Harness release watch failed during ${phase}`, { cause });
    const flags = cause && typeof cause === "object" ? cause as { retryable?: unknown; overloaded?: unknown } : {};
    this.evidence = { phase, durationMs: Math.min(120_000, Math.max(0, Date.now() - started)), responseStatus,
      retryable: flags.retryable === true, overloaded: flags.overloaded === true };
  }
}

/** The Sentry connector exports only this exact, bounded projection. */
export function parseHarnessReleaseWatchEvidence(value: unknown): HarnessReleaseWatchEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const fields = ["phase", "durationMs", "responseStatus", "retryable", "overloaded"];
  if (Object.keys(row).length !== fields.length || Object.keys(row).some(key => !fields.includes(key)) ||
      typeof row.phase !== "string" || !["runtime_fetch", "response_body", "response_contract"].includes(row.phase) ||
      typeof row.durationMs !== "number" || !Number.isSafeInteger(row.durationMs) || row.durationMs < 0 || row.durationMs > 120_000 ||
      typeof row.responseStatus !== "number" || !Number.isSafeInteger(row.responseStatus) ||
      (row.responseStatus !== 0 && (row.responseStatus < 100 || row.responseStatus > 599)) ||
      typeof row.retryable !== "boolean" || typeof row.overloaded !== "boolean") return undefined;
  return { phase: row.phase as HarnessReleaseWatchEvidence["phase"], durationMs: row.durationMs,
    responseStatus: row.responseStatus, retryable: row.retryable, overloaded: row.overloaded };
}
