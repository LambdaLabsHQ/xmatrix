"use client";

/** Small readings every platform-admin detail shares: ages, UTC times, counts by status. */

import { formatAdminAge, formatAdminCount } from "./platform-admin-overview";

export function adminAge(value: string | undefined, fallback = "—"): string {
  return formatAdminAge(value, Date.now()) || fallback;
}

/** A time cell: one line, the exact UTC time on hover. */
export function TimeCell({ value, fallback }: { value: string | undefined; fallback?: string }) {
  return <span className="whitespace-nowrap text-xs text-muted-foreground" title={value}>{adminAge(value, fallback).replace(" UTC", "")}</span>;
}

export function adminUtc(value: string | undefined): string {
  return value ? `${value.slice(0, 16).replace("T", " ")} UTC` : "—";
}

/** "completed 29 · running 1", largest first; empty when nothing was counted. */
export function adminStatusLine(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([status, value]) => `${status} ${formatAdminCount(value)}`)
    .join(" · ");
}

export function adminSum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

/** Share of `part` in `total` as a whole percentage; 0 when there is no total. */
export function adminPercent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}
