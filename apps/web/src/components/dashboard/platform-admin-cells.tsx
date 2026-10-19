"use client";

/** Small readings every platform-admin detail shares: ages, UTC times, counts by status. */

import type { ReactNode } from "react";

import type { AdminColumn } from "./admin-table";
import { adminTime, formatAdminAge, formatAdminCount } from "./platform-admin-overview";

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

/** A detail's name, one line about it, and which of its lists were cut at their bound. */
export function AdminDetailHeader({ title, truncated, children }: { title: string; truncated: readonly string[]; children: ReactNode }) {
  return (
    <header>
      <h2 className="text-2xl font-semibold leading-tight [overflow-wrap:anywhere]">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{children}</p>
      {truncated.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">Lists cut at their bound: {truncated.join(", ")}.</p>
      )}
    </header>
  );
}

/** The Automation figures a Space and the platform both show. */
export function adminAutomationStats(automations: {
  total: number; enabled: number; withError: number; occurrencesByStatus: Record<string, number>;
}, days: number): Array<{ label: string; value: string; hint?: string }> {
  const occurrences = adminSum(automations.occurrencesByStatus);
  const failed = automations.occurrencesByStatus.failed ?? 0;
  return [
    { label: "Automations", value: formatAdminCount(automations.total),
      hint: `${formatAdminCount(automations.enabled)} enabled` },
    { label: "Last run errored", value: formatAdminCount(automations.withError) },
    { label: `Occurrences, ${days}d`, value: formatAdminCount(occurrences),
      ...(occurrences > 0 ? { hint: `${adminPercent(failed, occurrences)}% failed` } : {}) },
  ];
}

/** A sortable time column read as an age, the exact UTC time on hover. */
export function adminTimeColumn<Row>(key: string, label: string, read: (row: Row) => string | undefined): AdminColumn<Row> {
  return { key, label, numeric: true, value: (row) => adminTime(read(row)), render: (row) => <TimeCell value={read(row)} /> };
}
