/**
 * Presentation model for the platform admin view.
 *
 * Pure derivations only: the view renders what these return, so the number
 * formatting, sorting, and chart scaling stay unit-testable without React.
 */

import type {
  AdminActivityPoint,
  AdminPlatformTotals,
  AdminSpaceSummary,
  AdminUserSummary,
} from "@xmatrix/protocol";

import { ageInDays, formatRelativeAge } from "./time-display";

export type AdminSpaceSortKey =
  | "recent"
  | "messages"
  | "members"
  | "channels"
  | "name";

export type AdminUserSortKey =
  | "recent"
  | "registered"
  | "sessions"
  | "messages"
  | "spaces"
  | "name";

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

export function sortAdminSpaces(
  spaces: AdminSpaceSummary[],
  key: AdminSpaceSortKey,
): AdminSpaceSummary[] {
  const sorted = [...spaces];
  sorted.sort((left, right) => {
    switch (key) {
      case "messages":
        return right.messages - left.messages || compareNames(left, right);
      case "members":
        return right.members - left.members || compareNames(left, right);
      case "channels":
        return right.activeChannels - left.activeChannels || compareNames(left, right);
      case "name":
        return compareNames(left, right);
      default:
        return compareTimestamps(right.lastMessageAt || right.createdAt, left.lastMessageAt || left.createdAt)
          || compareNames(left, right);
    }
  });
  return sorted;
}

export function filterAdminSpaces(
  spaces: AdminSpaceSummary[],
  query: string,
): AdminSpaceSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return spaces;
  return spaces.filter((space) =>
    space.name.toLowerCase().includes(needle)
    || space.id.toLowerCase().includes(needle)
    || (space.ownerEmail || "").toLowerCase().includes(needle)
    || space.ownerUserId.toLowerCase().includes(needle));
}

export function filterAdminUsers(users: AdminUserSummary[], query: string): AdminUserSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return users;
  return users.filter((user) =>
    (user.name || "").toLowerCase().includes(needle)
    || (user.handle || "").toLowerCase().includes(needle)
    || (user.email || "").toLowerCase().includes(needle)
    || user.userId.toLowerCase().includes(needle)
    || (user.providers || []).some((provider) => provider.toLowerCase().includes(needle)));
}

export function sortAdminUsers(
  users: AdminUserSummary[],
  key: AdminUserSortKey,
): AdminUserSummary[] {
  return [...users].sort((left, right) => {
    switch (key) {
      case "registered":
        return compareTimestamps(right.registeredAt, left.registeredAt) || compareUserNames(left, right);
      case "sessions":
        return (right.sessionCount ?? 0) - (left.sessionCount ?? 0) || compareUserNames(left, right);
      case "messages":
        return right.messages - left.messages || compareUserNames(left, right);
      case "spaces":
        return right.spaces - left.spaces || compareUserNames(left, right);
      case "name":
        return compareUserNames(left, right);
      default:
        return compareTimestamps(right.lastSessionAt, left.lastSessionAt)
          || compareUserNames(left, right);
    }
  });
}

export function adminUserLabel(
  user: Pick<AdminUserSummary, "name" | "email" | "userId">,
): string {
  return user.name || user.email || user.userId;
}

function compareNames(left: AdminSpaceSummary, right: AdminSpaceSummary): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function compareUserNames(left: AdminUserSummary, right: AdminUserSummary): number {
  return adminUserLabel(left).localeCompare(adminUserLabel(right))
    || left.userId.localeCompare(right.userId);
}

function compareTimestamps(left: string | undefined, right: string | undefined): number {
  const leftMs = left ? Date.parse(left) : Number.NaN;
  const rightMs = right ? Date.parse(right) : Number.NaN;
  const leftValue = Number.isFinite(leftMs) ? leftMs : 0;
  const rightValue = Number.isFinite(rightMs) ? rightMs : 0;
  return leftValue - rightValue;
}

function trimNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
