/** Value parsing shared by the platform-admin PostgreSQL reads. */

import type { AdminPaidCallKind } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";

export type AdminCountValue = string | number;
export type AdminTimeValue = Date | string;

export function adminCount(value: AdminCountValue | null | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("PostgreSQL admin read returned an invalid count");
  }
  return parsed;
}

export function adminIso(value: AdminTimeValue): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function adminOptionalIso(value: AdminTimeValue | null | undefined): string | undefined {
  return value == null ? undefined : adminIso(value);
}

/**
 * Cut each list at `bound`, remembering which lists were cut, so a list at its
 * bound says so instead of growing.
 */
export function adminListBound(bound: number): {
  truncated: string[];
  cut: <T>(rows: readonly T[], key: string) => T[];
} {
  const truncated: string[] = [];
  return {
    truncated,
    cut: (rows, key) => {
      if (rows.length > bound) truncated.push(key);
      return rows.slice(0, bound);
    },
  };
}

/** Paid-call receipts grouped by kind, status and outcome. */
export interface AdminPaidCallRow extends QueryResultRow {
  kind: string;
  status: string;
  outcome: string | null;
  calls: AdminCountValue;
  units: AdminCountValue;
  credits: AdminCountValue;
}

/** One row per kind; a receipt still reserved has no outcome yet and counts as "reserved". */
export function adminPaidCallKinds(rows: readonly AdminPaidCallRow[]): AdminPaidCallKind[] {
  const byKind = new Map<string, AdminPaidCallKind>();
  for (const row of rows) {
    const current = byKind.get(row.kind) ?? { kind: row.kind, calls: 0, byOutcome: {}, units: 0, credits: 0 };
    const calls = adminCount(row.calls);
    const outcome = row.status === "reserved" ? "reserved" : row.outcome ?? row.status;
    current.calls += calls;
    current.byOutcome[outcome] = (current.byOutcome[outcome] ?? 0) + calls;
    current.units += adminCount(row.units);
    current.credits += adminCount(row.credits);
    byKind.set(row.kind, current);
  }
  return [...byKind.values()].sort((left, right) =>
    right.credits - left.credits || right.calls - left.calls || left.kind.localeCompare(right.kind));
}

/** Add one status-keyed count map into another. */
export function addAdminCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}
