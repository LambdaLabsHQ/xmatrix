import { hasControlCharacter } from "./field-validation.js";
import { plainRecord } from "./plain-record.js";

/** Daemon observations of the exact checkout base, never repository authority. */
export interface RepositoryBaseline {
  baseRef: string;
  baseOid: string;
  confirmedAt?: string;
  historyRewritten?: boolean;
  remote?: { baseRef: string; baseOid: string; confirmedAt: string };
  relationship?: "ancestor" | "diverged" | "unknown";
  /** Stable, opaque notification identity for this checkout/base pair. */
  noticeKey?: string;
}

function basePair(value: Record<string, unknown>): { baseRef: string; baseOid: string } | undefined {
  const ref = value.baseRef;
  const oid = value.baseOid;
  if (typeof ref !== "string" || !ref.startsWith("origin/") || ref.length > 1_000 ||
      hasControlCharacter(ref) || /[\s~^:?*[\\]/u.test(ref) || ref.includes("..") || ref.includes("@{") ||
      typeof oid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) return undefined;
  return { baseRef: ref, baseOid: oid };
}

function utcTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

/** Allowlist for daemon reports and persisted/imported invocation projections. */
export function cleanRepositoryBaseline(value: unknown): RepositoryBaseline | undefined {
  const record = plainRecord(value) ?? {};
  const base = basePair(record);
  if (!base) return undefined;
  const confirmedAt = utcTimestamp(record.confirmedAt);
  const remoteRecord = plainRecord(record.remote) ?? {};
  const remoteBase = basePair(remoteRecord);
  const remoteAt = utcTimestamp(remoteRecord.confirmedAt);
  const remote = remoteBase && remoteAt ? { ...remoteBase, confirmedAt: remoteAt } : undefined;
  const relationship = record.relationship === "unknown" ? "unknown"
    : remote && (record.relationship === "ancestor" || record.relationship === "diverged") ? record.relationship : undefined;
  const noticeKey = relationship === "diverged" && typeof record.noticeKey === "string" && /^[0-9a-f]{64}$/u.test(record.noticeKey)
    ? record.noticeKey : undefined;
  return { ...base, ...(confirmedAt ? { confirmedAt } : {}),
    ...(typeof record.historyRewritten === "boolean" ? { historyRewritten: record.historyRewritten } : {}),
    ...(remote ? { remote } : {}), ...(relationship ? { relationship } : {}), ...(noticeKey ? { noticeKey } : {}) };
}
