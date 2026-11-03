import type { CliReleaseChannel } from "@xmatrix/protocol";

const PHASES = ["feed_headers", "feed_body", "feed_contract", "feed_read", "owner_read",
  "cell_fetch", "cell_body", "cell_contract"] as const;

/** Fixed diagnostics only: never a URL, owner, cell identity or response body. */
export interface CliReleaseNoticeEvidence {
  channel: CliReleaseChannel;
  phase: typeof PHASES[number];
  attempt: number;
  durationMs: number;
  responseStatus: number;
}

export class CliReleaseNoticeFailure extends Error {
  readonly evidence: CliReleaseNoticeEvidence;

  constructor(cause: unknown, channel: CliReleaseChannel, phase: CliReleaseNoticeEvidence["phase"],
    started: number, responseStatus = 0, attempt = 1) {
    super(`CLI ${channel} release notice failed during ${phase}`, { cause });
    this.evidence = { channel, phase, attempt, responseStatus,
      durationMs: Math.min(120_000, Math.max(0, Date.now() - started)) };
  }
}

/** Include both failed reads and independent channel/cell failures, with bounded traversal. */
export function cliReleaseNoticeEvidence(error: unknown): CliReleaseNoticeEvidence[] {
  const seen = new Set<Error>();
  const visit = (value: unknown): CliReleaseNoticeEvidence[] => {
    if (!(value instanceof Error) || seen.has(value) || seen.size >= 32) return [];
    seen.add(value);
    if (value instanceof CliReleaseNoticeFailure) return [value.evidence];
    return value instanceof AggregateError ? value.errors.slice(0, 32).flatMap(visit) : visit(value.cause);
  };
  return visit(error);
}

/** The issue reader accepts only this exact bounded projection from Sentry. */
export function parseCliReleaseNoticeEvidence(value: unknown): CliReleaseNoticeEvidence[] {
  if (!Array.isArray(value) || value.length > 32) return [];
  const fields = ["channel", "phase", "attempt", "durationMs", "responseStatus"];
  return value.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (Object.keys(row).length !== fields.length || Object.keys(row).some(key => !fields.includes(key)) ||
        (row.channel !== "stable" && row.channel !== "dev") ||
        !PHASES.includes(row.phase as CliReleaseNoticeEvidence["phase"]) ||
        (row.attempt !== 1 && row.attempt !== 2) ||
        typeof row.durationMs !== "number" || !Number.isSafeInteger(row.durationMs) || row.durationMs < 0 || row.durationMs > 120_000 ||
        typeof row.responseStatus !== "number" || !Number.isSafeInteger(row.responseStatus) ||
        (row.responseStatus !== 0 && (row.responseStatus < 100 || row.responseStatus > 599))) return [];
    return [{ channel: row.channel, phase: row.phase as CliReleaseNoticeEvidence["phase"],
      attempt: row.attempt, durationMs: row.durationMs, responseStatus: row.responseStatus }];
  });
}
