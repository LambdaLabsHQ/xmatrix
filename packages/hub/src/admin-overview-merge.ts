import type { AdminPlatformOverview, AdminPlatformTotals } from "@xmatrix/protocol";

export interface AdminOverviewMergeInput {
  now: string;
  spaceLimit: number;
  userLimit: number;
  activityDays: number;
}

const UTC_DAY_MS = 24 * 60 * 60 * 1_000;

/** Exact UTC calendar-day window represented by an admin activity series. */
export function adminActivityUtcWindow(
  nowMs: number,
  days: number,
): { since: string; before: string; firstDay: string; lastDay: string } {
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(days) || days < 1) {
    throw new Error("admin activity window is invalid");
  }
  const now = new Date(nowMs);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(today - (days - 1) * UTC_DAY_MS).toISOString();
  return {
    since,
    before: new Date(today + UTC_DAY_MS).toISOString(),
    firstDay: since.slice(0, 10),
    lastDay: new Date(today).toISOString().slice(0, 10),
  };
}

/** The UTC days one person sent a message of their own, as days since 1970-01-01. */
export interface AdminUserDays {
  userId: string;
  days: readonly number[];
}

/** The UTC date after a `YYYY-MM-DD` date. */
export function adminDayAfter(date: string): string {
  return new Date((adminDayNumber(date) + 1) * UTC_DAY_MS).toISOString().slice(0, 10);
}

/** Days since 1970-01-01 of a `YYYY-MM-DD` UTC date. */
export function adminDayNumber(date: string): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) throw new Error("admin activity date is invalid");
  return Math.round(ms / UTC_DAY_MS);
}

/**
 * Distinct people active on each day of the series and in the 7 and 30 days
 * ending on it, counted across shards; each person's active days in the
 * series go on their user row. Someone active but in no Space any more is
 * still a user who was active, so they join the list.
 */
export function withActiveUsers(
  overview: AdminPlatformOverview,
  userDays: readonly AdminUserDays[],
): AdminPlatformOverview {
  const first = overview.activity[0];
  if (!first) return overview;
  const start = adminDayNumber(first.date);
  const length = overview.activity.length;
  const daily = new Array<number>(length).fill(0);
  const weekly = new Array<number>(length).fill(0);
  const monthly = new Array<number>(length).fill(0);
  const byUser = new Map<string, Set<number>>();
  for (const entry of userDays) {
    const days = byUser.get(entry.userId) ?? new Set<number>();
    for (const day of entry.days) days.add(day);
    byUser.set(entry.userId, days);
  }
  // Each person adds one to every day their trailing window reaches, once.
  const cover = (counts: number[], sorted: readonly number[], span: number) => {
    let next = start;
    for (const day of sorted) {
      for (let at = Math.max(day, next); at < day + span && at < start + length; at++) {
        if (at >= start) counts[at - start]! += 1;
      }
      next = Math.max(next, day + span);
    }
  };
  const activeDays = new Map<string, number[]>();
  for (const [userId, days] of byUser) {
    const sorted = [...days].sort((left, right) => left - right);
    cover(daily, sorted, 1);
    cover(weekly, sorted, 7);
    cover(monthly, sorted, 30);
    const inSeries = sorted.filter((day) => day >= start && day < start + length);
    if (inSeries.length) activeDays.set(userId, inSeries);
  }
  const listed = new Set(overview.users.map((user) => user.userId));
  const unlisted = [...activeDays].filter(([userId]) => !listed.has(userId));
  return {
    ...overview,
    totals: { ...overview.totals, users: overview.totals.users + unlisted.length },
    activity: overview.activity.map((point, index) => ({
      ...point,
      activeUsers: daily[index]!,
      activeUsers7d: weekly[index]!,
      activeUsers30d: monthly[index]!,
    })),
    users: [
      ...overview.users.map((user) => activeDays.has(user.userId)
        ? { ...user, activeDays: activeDays.get(user.userId)! } : user),
      ...unlisted.map(([userId, days]) => ({
        userId, spaces: 0, ownedSpaces: 0, agentRegistrations: 0, machines: 0, messages: 0, activeDays: days,
      })),
    ],
  };
}

/**
 * Accounts registered on each day of the series, from the registered-user
 * inventory. Left out when that inventory is incomplete, rather than undercounted.
 */
export function withSignups(overview: AdminPlatformOverview): AdminPlatformOverview {
  if (!overview.userAccess || overview.truncated.users || overview.activity.length === 0) return overview;
  const byDate = new Map<string, number>();
  for (const user of overview.users) {
    if (!user.registeredAt) continue;
    const date = new Date(user.registeredAt).toISOString().slice(0, 10);
    byDate.set(date, (byDate.get(date) ?? 0) + 1);
  }
  return {
    ...overview,
    activity: overview.activity.map((point) => ({ ...point, signups: byDate.get(point.date) ?? 0 })),
  };
}

export function emptyAdminPlatformTotals(): AdminPlatformTotals {
  return {
    users: 0,
    spaces: 0,
    channels: 0,
    activeChannels: 0,
    archivedChannels: 0,
    messages: 0,
    messagesLast24h: 0,
    messagesLast7d: 0,
    humanMessages: 0,
    agentMessages: 0,
    agentRegistrations: 0,
    runs: 0,
    activeRuns: 0,
    agentInstances: 0,
    machines: 0,
    onlineMachines: 0,
    scheduledTasks: 0,
    enabledScheduledTasks: 0,
    storageLogicalBytes: 0,
    archivedSegmentBytes: 0,
  };
}

export function mergeAdminOverviewPartitions(
  input: AdminOverviewMergeInput,
  partitions: readonly AdminPlatformOverview[],
): AdminPlatformOverview {
  const totals = emptyAdminPlatformTotals();
  for (const partition of partitions) {
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      totals[key] += Number(partition.totals[key] ?? 0);
    }
  }
  const spaces = partitions.flatMap((overview) => overview.spaces)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  const users = new Map<string, AdminPlatformOverview["users"][number]>();
  for (const user of partitions.flatMap((overview) => overview.users)) {
    const current = users.get(user.userId);
    if (!current) {
      users.set(user.userId, { ...user });
      continue;
    }
    current.spaces += user.spaces;
    current.ownedSpaces += user.ownedSpaces;
    current.agentRegistrations += user.agentRegistrations;
    current.machines += user.machines;
    current.messages += user.messages;
    current.firstSeenAt = [current.firstSeenAt, user.firstSeenAt]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .sort()[0];
    current.lastMessageAt = [current.lastMessageAt, user.lastMessageAt]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .sort().at(-1);
    if (!current.email && user.email) current.email = user.email;
  }
  totals.users = users.size;
  const activityByDate = new Map<string, AdminPlatformOverview["activity"][number]>();
  for (const point of partitions.flatMap((overview) => overview.activity)) {
    const current = activityByDate.get(point.date) ?? {
      date: point.date, messages: 0, humanMessages: 0, agentMessages: 0,
      ownMessages: 0, activeSpaces: 0, runsStarted: 0,
    };
    current.messages += point.messages;
    current.humanMessages += point.humanMessages;
    current.agentMessages += point.agentMessages;
    // A Space and its Runs live on one shard, so these add across shards.
    current.ownMessages! += point.ownMessages ?? 0;
    current.activeSpaces! += point.activeSpaces ?? 0;
    current.runsStarted! += point.runsStarted ?? 0;
    activityByDate.set(point.date, current);
  }
  const storageByCategory = new Map<string, AdminPlatformOverview["storage"][number]>();
  for (const item of partitions.flatMap((overview) => overview.storage)) {
    const current = storageByCategory.get(item.category) ?? {
      category: item.category, rows: 0, logicalBytes: 0, updatedAt: item.updatedAt,
    };
    current.rows += item.rows;
    current.logicalBytes += item.logicalBytes;
    if (item.updatedAt > current.updatedAt) current.updatedAt = item.updatedAt;
    storageByCategory.set(item.category, current);
  }
  const orderedUsers = [...users.values()].sort((left, right) =>
    right.spaces - left.spaces || (left.firstSeenAt ?? "").localeCompare(right.firstSeenAt ?? "") ||
    left.userId.localeCompare(right.userId));
  return {
    generatedAt: input.now,
    activityDays: input.activityDays,
    totals,
    spaces: spaces.slice(0, input.spaceLimit),
    users: orderedUsers.slice(0, input.userLimit),
    activity: [...activityByDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
    storage: [...storageByCategory.values()].sort((left, right) =>
      right.logicalBytes - left.logicalBytes || left.category.localeCompare(right.category)).slice(0, 50),
    truncated: {
      spaces: totals.spaces > input.spaceLimit,
      users: users.size > input.userLimit,
    },
  };
}
