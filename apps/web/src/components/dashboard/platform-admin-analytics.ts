/**
 * Platform activity as the admin Overview reads it: a range of UTC days, what
 * changed against the range before it, how new accounts got going, and who
 * came back. Pure derivations over one overview read, so switching ranges
 * never asks the Hub again and every figure stays unit-testable.
 *
 * A person is active on a day they sent a message of their own; signing in,
 * an Agent's message, or a scheduled post does not make them active.
 */

import {
  ADMIN_OVERVIEW_MAX_ACTIVITY_DAYS,
  type AdminActivityPoint,
  type AdminPlatformOverview,
  type AdminUserSummary,
} from "@xmatrix/protocol";

const DAY_MS = 86_400_000;

/** Days the Overview reads at once, the most the Hub serves, so every range below is a slice of one read. */
export const ADMIN_OVERVIEW_SERIES_DAYS = ADMIN_OVERVIEW_MAX_ACTIVITY_DAYS;

export const ADMIN_RANGES = [
  { key: "7d", label: "7 days", short: "7d", days: 7 },
  { key: "30d", label: "30 days", short: "30d", days: 30 },
  { key: "90d", label: "90 days", short: "90d", days: 90 },
  { key: "all", label: "All time", short: "All", days: null },
] as const;

export function adminRange(key: string): typeof ADMIN_RANGES[number] {
  return ADMIN_RANGES.find((range) => range.key === key) ?? ADMIN_RANGES[1];
}

/** Days since 1970-01-01 of a `YYYY-MM-DD` UTC date. */
export function adminDayNumber(date: string): number {
  return Math.round(Date.parse(`${date.slice(0, 10)}T00:00:00.000Z`) / DAY_MS);
}

export function adminDateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** "Oct 27", the way the charts and their readouts name a UTC day. */
export function formatAdminDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  });
}

/**
 * The first day xMatrix had a person on it: a registration or someone's own
 * message. Earlier days only hold imported history, so "All time" starts here.
 */
export function adminFirstActiveDate(activity: readonly AdminActivityPoint[]): string | undefined {
  return activity.find((point) => (point.ownMessages ?? 0) > 0 || (point.signups ?? 0) > 0)?.date
    ?? activity.find((point) => point.messages > 0)?.date;
}

export interface AdminPeriod {
  /** The range's days, oldest first; the last one is today, still running. */
  current: AdminActivityPoint[];
  /** The same number of days just before it, when the read reaches back that far. */
  previous: AdminActivityPoint[] | null;
  start: number;
  end: number;
}

export function adminPeriod(activity: readonly AdminActivityPoint[], rangeKey: string): AdminPeriod {
  const range = adminRange(rangeKey);
  const first = adminFirstActiveDate(activity);
  const fromFirst = first ? activity.length - activity.findIndex((point) => point.date === first) : activity.length;
  const days = Math.max(1, Math.min(range.days ?? fromFirst, activity.length));
  const current = activity.slice(activity.length - days);
  const before = activity.slice(Math.max(0, activity.length - 2 * days), activity.length - days);
  const end = current.length ? adminDayNumber(current.at(-1)!.date) : 0;
  return {
    current,
    previous: range.days !== null && before.length === days ? before : null,
    start: end - current.length + 1,
    end,
  };
}

/** People with a message of their own on any day in `[start, end]`. */
export function adminActivePeople(users: readonly AdminUserSummary[], start: number, end: number): number {
  return users.filter((user) => user.activeDays?.some((day) => day >= start && day <= end)).length;
}

function sum(points: readonly AdminActivityPoint[], read: (point: AdminActivityPoint) => number | undefined): number {
  return points.reduce((total, point) => total + (read(point) ?? 0), 0);
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

/** Days that are over: the running day is left out of averages so a morning does not drag them down. */
function completeDays(points: readonly AdminActivityPoint[]): AdminActivityPoint[] {
  return points.length > 1 ? points.slice(0, -1) : [...points];
}

/** UTC days in the last `span` (today included) on which a person sent a message of their own. */
export function adminRecentActiveDays(
  user: Pick<AdminUserSummary, "activeDays">,
  today = Math.floor(Date.now() / DAY_MS),
  span = 30,
): number {
  return user.activeDays?.filter((day) => day > today - span && day <= today).length ?? 0;
}

export interface AdminPeriodFigures {
  activePeople: number;
  averageDailyActive: number;
  /** Average daily active people as a share of people active in the last 30 days. */
  stickiness: number | null;
  signups: number | null;
  ownMessages: number;
  messages: number;
  agentMessages: number;
  humanMessages: number;
  averageActiveSpaces: number;
  runsStarted: number;
}

export function adminPeriodFigures(
  points: readonly AdminActivityPoint[],
  users: readonly AdminUserSummary[],
  start: number,
  end: number,
): AdminPeriodFigures {
  const complete = completeDays(points);
  const averageDailyActive = mean(complete.map((point) => point.activeUsers ?? 0));
  const monthly = points.at(-1)?.activeUsers30d ?? 0;
  return {
    activePeople: adminActivePeople(users, start, end),
    averageDailyActive,
    stickiness: monthly > 0 ? averageDailyActive / monthly : null,
    signups: points.every((point) => point.signups !== undefined) ? sum(points, (point) => point.signups) : null,
    ownMessages: sum(points, (point) => point.ownMessages),
    messages: sum(points, (point) => point.messages),
    agentMessages: sum(points, (point) => point.agentMessages),
    humanMessages: sum(points, (point) => point.humanMessages),
    averageActiveSpaces: mean(complete.map((point) => point.activeSpaces ?? 0)),
    runsStarted: sum(points, (point) => point.runsStarted),
  };
}

/** Relative change from `previous` to `current`; null when there is nothing to compare with. */
export function adminChange(current: number | null, previous: number | null | undefined): number | null {
  if (current === null || previous === null || previous === undefined || previous === 0) return null;
  return (current - previous) / previous;
}

export function formatAdminChange(change: number | null): string | undefined {
  if (change === null || !Number.isFinite(change)) return undefined;
  const percent = Math.round(change * 100);
  if (percent === 0) return "no change";
  return `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%`;
}

export function formatAdminPercent(share: number | null): string {
  return share === null || !Number.isFinite(share) ? "—" : `${Math.round(share * 100)}%`;
}

/** Registered accounts at the end of each day, counted back from today's total. */
export function adminRegisteredSeries(points: readonly AdminActivityPoint[], registered: number): number[] | null {
  if (points.some((point) => point.signups === undefined)) return null;
  const after = points.map((point) => point.signups ?? 0);
  let later = 0;
  const totals = after.map(() => 0);
  for (let index = points.length - 1; index >= 0; index--) {
    totals[index] = registered - later;
    later += after[index]!;
  }
  return totals;
}

export interface AdminFunnelStep {
  key: string;
  label: string;
  people: number;
}

/**
 * How far the accounts registered in `[start, end]` got, step by step, in the
 * order the new-user funnel reads them. Each step counts the people who reached
 * it, whatever they skipped on the way.
 */
export function adminActivationFunnel(
  overview: Pick<AdminPlatformOverview, "users" | "userAccess">,
  start: number,
  end: number,
): AdminFunnelStep[] {
  const cohort = overview.users.filter((user) => {
    if (!user.registeredAt) return !overview.userAccess;
    const day = Math.floor(Date.parse(user.registeredAt) / DAY_MS);
    return day >= start && day <= end;
  });
  const count = (reached: (user: AdminUserSummary) => boolean) => cohort.filter(reached).length;
  return [
    { key: "registered", label: "Registered", people: cohort.length },
    { key: "space", label: "Joined or made a Space", people: count((user) => user.spaces > 0) },
    { key: "machine", label: "Connected a Machine", people: count((user) => user.machines > 0) },
    { key: "agent", label: "Added an Agent", people: count((user) => user.agentRegistrations > 0) },
    // Their active days reach back past registration, so any message of their own is in them.
    { key: "message", label: "Sent a message of their own", people: count((user) => Boolean(user.activeDays?.length)) },
    { key: "active", label: "Active in the last 7 days",
      people: count((user) => Boolean(user.activeDays?.some((day) => day > end - 7 && day <= end))) },
  ];
}

export interface AdminRetentionCohort {
  /** Monday of the registration week. */
  week: string;
  people: number;
  /** Share of the cohort active in each week since registering; null for weeks still to come. */
  weeks: Array<{ active: number; share: number } | null>;
}

/**
 * Weekly retention: accounts by the UTC week (from Monday) they registered,
 * and how many of them sent a message of their own in each week after.
 */
export function adminWeeklyRetention(
  users: readonly AdminUserSummary[],
  today: number,
  cohorts = 8,
): AdminRetentionCohort[] {
  // 1970-01-01 was a Thursday: day 4 of a week that started on Monday.
  const weekOf = (day: number) => day - ((day + 3) % 7);
  const thisWeek = weekOf(today);
  const rows: AdminRetentionCohort[] = [];
  for (let index = cohorts - 1; index >= 0; index--) {
    const week = thisWeek - index * 7;
    const people = users.filter((user) => user.registeredAt
      && weekOf(Math.floor(Date.parse(user.registeredAt) / DAY_MS)) === week);
    const weeks = Array.from({ length: cohorts }, (_, offset) => {
      const from = week + offset * 7;
      if (from > today) return null;
      const active = people.filter((user) => user.activeDays?.some((day) => day >= from && day < from + 7)).length;
      return { active, share: people.length ? active / people.length : 0 };
    });
    rows.push({ week: adminDateOf(week), people: people.length, weeks });
  }
  // Weeks before the first registration say nothing.
  return rows.slice(Math.max(0, rows.findIndex((row) => row.people > 0)));
}

/**
 * Sums daily points into weeks (from Monday) when a range is too long for one
 * bar a day to be read; a partial first or last week keeps its own days only.
 */
export function adminBucketPoints<Point extends { date: string }>(
  points: readonly Point[],
  combine: (bucket: readonly Point[]) => Omit<Point, "date">,
  maxBars = 120,
): Array<Point & { days: number }> {
  if (points.length <= maxBars) return points.map((point) => ({ ...point, days: 1 }));
  const buckets = new Map<number, Point[]>();
  for (const point of points) {
    const day = adminDayNumber(point.date);
    const week = day - ((day + 3) % 7);
    buckets.set(week, [...(buckets.get(week) ?? []), point]);
  }
  return [...buckets.values()].map((bucket) => ({
    ...(combine(bucket) as Omit<Point, "date">),
    date: bucket[0]!.date,
    days: bucket.length,
  }) as Point & { days: number });
}

/**
 * An axis top at or above `value` whose half is a whole, round count, so the
 * three labels (0, half, top) never show a fraction of a person or message.
 */
export function adminNiceCeiling(value: number): number {
  if (!(value > 0)) return 2;
  const half = value / 2;
  const magnitude = 10 ** Math.floor(Math.log10(half));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const tick = step * magnitude;
    if (tick >= half && tick >= 1 && Number.isInteger(tick)) return 2 * tick;
  }
  return 20 * magnitude;
}
