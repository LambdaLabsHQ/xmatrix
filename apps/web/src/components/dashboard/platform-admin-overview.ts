/**
 * Presentation model for the platform admin view.
 *
 * Pure derivations only: the view renders what these return, so the number
 * formatting, sorting, and chart scaling stay unit-testable without React.
 */

import type {
  AdminActivityPoint,
  AdminPlatformTotals,
  AdminUserSummary,
} from "@xmatrix/protocol";

import { ageInDays, formatRelativeAge } from "./time-display";

export interface AdminStatTile {
  key: string;
  label: string;
  value: string;
  hint?: string;
}

export interface AdminActivityBar extends AdminActivityPoint {
  /** 0-1 height relative to the busiest day in the window. */
  ratio: number;
  label: string;
}

export function formatAdminCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value);
  if (Math.abs(rounded) < 1000) return String(rounded);
  if (Math.abs(rounded) < 1_000_000) return `${trimNumber(rounded / 1000)}k`;
  if (Math.abs(rounded) < 1_000_000_000) return `${trimNumber(rounded / 1_000_000)}M`;
  return `${trimNumber(rounded / 1_000_000_000)}B`;
}

export function formatAdminBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${trimNumber(scaled)} ${units[unit]}`;
}

/**
 * Short relative age, e.g. "3m ago", "5h ago", "2d ago". Empty for a missing
 * timestamp.
 *
 * Past a month a duration stops being informative, so it falls back to the UTC
 * calendar date — labelled UTC, because this one is not rendered in the
 * reader's zone and a bare date would silently claim it was.
 */
export function formatAdminAge(value: string | undefined, nowMs: number): string {
  const days = ageInDays(value, nowMs);
  if (days === null) return "";
  if (days >= 30) return `${new Date(Date.parse(value!)).toISOString().slice(0, 10)} UTC`;
  return formatRelativeAge(value, nowMs) ?? "";
}

export function platformAdminStatTiles(totals: AdminPlatformTotals): AdminStatTile[] {
  return [
    {
      key: "users",
      label: "Users",
      value: formatAdminCount(totals.users),
      hint: `${formatAdminCount(totals.spaces)} spaces`,
    },
    {
      key: "channels",
      label: "Active channels",
      value: formatAdminCount(totals.activeChannels),
      hint: `${formatAdminCount(totals.archivedChannels)} archived`,
    },
    {
      key: "messages",
      label: "Messages",
      value: formatAdminCount(totals.messages),
      hint: `${formatAdminCount(totals.messagesLast24h)} in 24h`,
    },
    {
      key: "agents",
      label: "Agents",
      value: formatAdminCount(totals.agentRegistrations),
      hint: `${formatAdminCount(totals.activeRuns)} running`,
    },
    {
      key: "machines",
      label: "Machines online",
      value: formatAdminCount(totals.onlineMachines),
      hint: `${formatAdminCount(totals.machines)} enrolled`,
    },
    {
      key: "automation",
      label: "Automations",
      value: formatAdminCount(totals.enabledScheduledTasks),
      hint: `${formatAdminCount(totals.scheduledTasks)} total`,
    },
    {
      key: "storage",
      label: "Stored",
      value: formatAdminBytes(totals.storageLogicalBytes),
      hint: `${formatAdminBytes(totals.archivedSegmentBytes)} archived`,
    },
  ];
}

/** Share of messages authored by agents, 0-1. */
export function agentMessageShare(totals: AdminPlatformTotals): number {
  const attributed = totals.humanMessages + totals.agentMessages;
  if (attributed <= 0) return 0;
  return totals.agentMessages / attributed;
}

export function adminActivityBars(points: AdminActivityPoint[]): AdminActivityBar[] {
  const peak = points.reduce((max, point) => Math.max(max, point.messages), 0);
  return points.map((point) => ({
    ...point,
    ratio: peak > 0 ? point.messages / peak : 0,
    label: point.date.slice(5),
  }));
}

export function adminUserLabel(
  user: Pick<AdminUserSummary, "name" | "email" | "userId">,
): string {
  return user.name || user.email || user.userId;
}

/** One column of an admin table: how it sorts and exports. */
export interface AdminSortableColumn<Row> {
  key: string;
  label: string;
  value?: (row: Row) => string | number | undefined;
  noExport?: boolean;
}

function compareCells(left: string | number | undefined, right: string | number | undefined): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function missingCell(value: string | number | undefined): boolean {
  return value === undefined || value === "";
}

/** Stable sort on one column; rows without a value sort last in either direction. */
export function sortAdminRows<Row>(
  rows: readonly Row[],
  column: AdminSortableColumn<Row> | undefined,
  descending: boolean,
): Row[] {
  if (!column?.value) return [...rows];
  const value = column.value;
  return [...rows].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    if (missingCell(a) || missingCell(b)) return Number(missingCell(a)) - Number(missingCell(b));
    const order = compareCells(a, b);
    return descending ? -order : order;
  });
}

function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? "" : String(value);
  // A leading formula character is neutralised so a spreadsheet does not run it.
  const safe = /^[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\n]/u.test(safe) ? `"${safe.replaceAll("\"", "\"\"")}"` : safe;
}

export function adminTableCsv<Row>(rows: readonly Row[], columns: readonly AdminSortableColumn<Row>[]): string {
  const exported = columns.filter((column) => column.value && !column.noExport);
  return [
    exported.map((column) => csvCell(column.label)).join(","),
    ...rows.map((row) => exported.map((column) => csvCell(column.value!(row))).join(",")),
  ].join("\n");
}

/** Epoch milliseconds for sorting a timestamp column; missing stays missing. */
export function adminTime(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function trimNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
