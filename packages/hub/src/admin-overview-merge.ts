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
): { since: string; before: string } {
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(days) || days < 1) {
    throw new Error("admin activity window is invalid");
  }
  const now = new Date(nowMs);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    since: new Date(today - (days - 1) * UTC_DAY_MS).toISOString(),
    before: new Date(today + UTC_DAY_MS).toISOString(),
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
    };
    current.messages += point.messages;
    current.humanMessages += point.humanMessages;
    current.agentMessages += point.agentMessages;
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
