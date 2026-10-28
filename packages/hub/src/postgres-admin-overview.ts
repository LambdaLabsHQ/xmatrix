import type {
  AdminPlatformOverview,
  AdminUserSummary,
} from "@xmatrix/protocol";
import type { AuthorityDatabase } from "@xmatrix/db";
import type { QueryResultRow } from "pg";

import {
  createPostgresAuthorityFleet,
  type PostgresAuthorityFleet,
} from "./postgres-authority-fleet";
import type { Env } from "./types";
import { adminDate } from "./postgres-admin-activity-rollup";
import {
  POSTGRES_ADMIN_OVERVIEW_QUERY,
  POSTGRES_ADMIN_OVERVIEW_STATE_QUERY,
  POSTGRES_ADMIN_OVERVIEW_UNROLLED_QUERY,
} from "./postgres-admin-overview-query";
import {
  adminActivityUtcWindow,
  adminDayAfter,
  emptyAdminPlatformTotals,
  mergeAdminOverviewPartitions,
  withActiveUsers,
  type AdminUserDays,
} from "./admin-overview-merge";

const ADMIN_OVERVIEW_USER_BOUND = 10_000;
const ADMIN_OVERVIEW_STORAGE_CATEGORY_BOUND = 1_000;
const ADMIN_OVERVIEW_MACHINE_OWNER_BOUND = 10_000;
const ADMIN_OVERVIEW_ACTIVE_USER_BOUND = 10_000;

interface AdminOverviewInput {
  now: string;
  spaceLimit: number;
  userLimit: number;
  activityDays: number;
}

interface TotalsRow extends QueryResultRow {
  spaces: string | number;
  channels: string | number;
  active_channels: string | number;
  messages: string | number;
  messages_last_24h: string | number;
  messages_last_7d: string | number;
  human_messages: string | number;
  agent_messages: string | number;
  agent_registrations: string | number;
  runs: string | number;
  active_runs: string | number;
  agent_instances: string | number;
  automations: string | number;
  enabled_automations: string | number;
  storage_logical_bytes: string | number;
}

interface SpaceRow extends QueryResultRow {
  id: string;
  name: string;
  owner_user_id: string;
  members: string | number;
  channels: string | number;
  active_channels: string | number;
  agent_registrations: string | number;
  messages: string | number;
  messages_last_7d: string | number;
  created_at: Date | string;
  last_message_at: Date | string | null;
}

interface UserRow extends QueryResultRow {
  user_id: string;
  email: string | null;
  spaces: string | number;
  owned_spaces: string | number;
  agent_registrations: string | number;
  messages: string | number;
  first_seen_at: Date | string | null;
  last_message_at: Date | string | null;
  total_count: string | number;
}

interface ActivityRow extends QueryResultRow {
  day: string;
  messages: string | number;
  human_messages: string | number;
  agent_messages: string | number;
  own_messages: string | number;
  active_spaces: string | number;
  runs_started: string | number;
}

interface UserDaysRow extends QueryResultRow {
  user_id: string;
  days: Array<string | number>;
  total_count: string | number;
}

interface RollupStateRow extends QueryResultRow {
  settled_through: Date | string | null;
}

interface StorageRow extends QueryResultRow {
  category: string;
  rows: string | number;
  logical_bytes: string | number;
  updated_at: Date | string;
}

interface MachineRow extends QueryResultRow {
  owner_user_id: string;
  email: string | null;
  machines: string | number;
  online_machines: string | number;
  total_count: string | number;
}

interface PostgresAdminOverviewPartition {
  overview: AdminPlatformOverview;
  machines: MachineRow[];
  userDays: AdminUserDays[];
}

function numberValue(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("PostgreSQL admin overview returned an invalid count");
  }
  return parsed;
}

function timestamp(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) {
    throw new Error("PostgreSQL admin overview returned an invalid timestamp");
  }
  return result;
}

/** The shard's last settled day, read before the aggregate so its live scan is planned on a real bound. */
async function readSettledThrough(
  database: AuthorityDatabase,
  shardId: string,
): Promise<string | null> {
  const state = (await database.transaction({
    requestId: `admin-overview-state:${shardId}`.slice(0, 200),
    operation: "admin.overview.state",
    statement: "single_read",
  }, (transaction) => transaction.query<RollupStateRow>({
    name: "postgres_admin_overview_state_v1",
    text: POSTGRES_ADMIN_OVERVIEW_STATE_QUERY,
    values: [],
    maxRows: 1,
  })))[0];
  if (!state) throw new Error("PostgreSQL admin activity roll-up state is missing");
  return state.settled_through === null ? null : adminDate(state.settled_through);
}

async function readShardPartition(
  database: AuthorityDatabase,
  shardId: string,
  input: AdminOverviewInput,
  includeGlobalMachines: boolean,
): Promise<PostgresAdminOverviewPartition> {
  const now = new Date(input.now);
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const activityWindow = adminActivityUtcWindow(now.getTime(), input.activityDays);
  const today = activityWindow.lastDay;
  const settledThrough = await readSettledThrough(database, shardId);
  const values = [since24h, today, input.spaceLimit + 1,
    activityWindow.firstDay, today, includeGlobalMachines];
  return database.transaction({
    requestId: `admin-overview:${shardId}`.slice(0, 200),
    operation: "admin.overview.read",
    statement: "single_read",
  }, async (transaction) => {
    const result = (await transaction.query<QueryResultRow & {
      settled_through: Date | string | null;
      totals: TotalsRow[];
      spaces: SpaceRow[];
      users: UserRow[];
      user_days: UserDaysRow[];
      activity: ActivityRow[];
      storage: StorageRow[];
      machines: MachineRow[];
    }>(settledThrough === null ? {
      name: "postgres_admin_overview_unrolled_v1",
      text: POSTGRES_ADMIN_OVERVIEW_UNROLLED_QUERY,
      values,
      maxRows: 1,
    } : {
      name: "postgres_admin_overview_v2",
      text: POSTGRES_ADMIN_OVERVIEW_QUERY,
      values: [...values, `${adminDayAfter(settledThrough)}T00:00:00.000Z`],
      maxRows: 1,
    }))[0];
    if (settledThrough !== null && (result?.settled_through ?? null) === null) {
      throw new Error("PostgreSQL admin activity roll-up state disappeared during the read");
    }
    const totals = result?.totals[0];
    if (!totals) throw new Error("PostgreSQL admin overview totals are unavailable");
    const { spaces: spaceRows, users: userRows, user_days: userDayRows, activity: activityRows,
      storage: storageRows, machines: machineRows } = result!;
    // The outer row is a JSON envelope: prove the nested inventory bounds too.
    if (spaceRows.length > input.spaceLimit + 1 || activityRows.length > input.activityDays) {
      throw new Error("PostgreSQL admin overview result bound was reached");
    }
    if (userRows.length > ADMIN_OVERVIEW_USER_BOUND ||
        numberValue(userRows[0]?.total_count) > ADMIN_OVERVIEW_USER_BOUND) {
      throw new Error("PostgreSQL admin overview user bound was reached");
    }
    if (userDayRows.length > ADMIN_OVERVIEW_ACTIVE_USER_BOUND ||
        numberValue(userDayRows[0]?.total_count) > ADMIN_OVERVIEW_ACTIVE_USER_BOUND) {
      throw new Error("PostgreSQL admin overview active-user bound was reached");
    }
    if (storageRows.length > ADMIN_OVERVIEW_STORAGE_CATEGORY_BOUND) {
      throw new Error("PostgreSQL admin overview storage-category bound was reached");
    }
    if (machineRows.length > ADMIN_OVERVIEW_MACHINE_OWNER_BOUND ||
        numberValue(machineRows[0]?.total_count) > ADMIN_OVERVIEW_MACHINE_OWNER_BOUND) {
      throw new Error("PostgreSQL admin overview machine-owner bound was reached");
    }

    return {
      overview: {
        generatedAt: input.now,
        activityDays: input.activityDays,
        totals: {
          users: userRows.length,
          spaces: numberValue(totals.spaces),
          channels: numberValue(totals.channels),
          activeChannels: numberValue(totals.active_channels),
          archivedChannels: numberValue(totals.channels) - numberValue(totals.active_channels),
          messages: numberValue(totals.messages),
          messagesLast24h: numberValue(totals.messages_last_24h),
          messagesLast7d: numberValue(totals.messages_last_7d),
          humanMessages: numberValue(totals.human_messages),
          agentMessages: numberValue(totals.agent_messages),
          agentRegistrations: numberValue(totals.agent_registrations),
          runs: numberValue(totals.runs),
          activeRuns: numberValue(totals.active_runs),
          agentInstances: numberValue(totals.agent_instances),
          machines: 0,
          onlineMachines: 0,
          scheduledTasks: numberValue(totals.automations),
          enabledScheduledTasks: numberValue(totals.enabled_automations),
          storageLogicalBytes: numberValue(totals.storage_logical_bytes),
          archivedSegmentBytes: 0,
        },
        spaces: spaceRows.map((row) => ({
          id: row.id,
          name: row.name,
          ownerUserId: row.owner_user_id,
          members: numberValue(row.members),
          channels: numberValue(row.channels),
          activeChannels: numberValue(row.active_channels),
          agentRegistrations: numberValue(row.agent_registrations),
          messages: numberValue(row.messages),
          messagesLast7d: numberValue(row.messages_last_7d),
          createdAt: timestamp(row.created_at)!,
          ...(timestamp(row.last_message_at)
            ? { lastMessageAt: timestamp(row.last_message_at) }
            : {}),
        })),
        users: userRows.map((row) => ({
          userId: row.user_id,
          ...(row.email ? { email: row.email } : {}),
          spaces: numberValue(row.spaces),
          ownedSpaces: numberValue(row.owned_spaces),
          agentRegistrations: numberValue(row.agent_registrations),
          machines: 0,
          messages: numberValue(row.messages),
          ...(timestamp(row.first_seen_at)
            ? { firstSeenAt: timestamp(row.first_seen_at) }
            : {}),
          ...(timestamp(row.last_message_at)
            ? { lastMessageAt: timestamp(row.last_message_at) }
            : {}),
        })),
        activity: activityRows.map((row) => ({
          date: row.day,
          messages: numberValue(row.messages),
          humanMessages: numberValue(row.human_messages),
          agentMessages: numberValue(row.agent_messages),
          ownMessages: numberValue(row.own_messages),
          activeSpaces: numberValue(row.active_spaces),
          runsStarted: numberValue(row.runs_started),
        })),
        storage: storageRows.map((row) => ({
          category: row.category,
          rows: numberValue(row.rows),
          logicalBytes: numberValue(row.logical_bytes),
          updatedAt: timestamp(row.updated_at)!,
        })),
        truncated: {
          spaces: numberValue(totals.spaces) > input.spaceLimit,
          users: userRows.length > input.userLimit,
        },
      },
      machines: machineRows.map((row) => ({ ...row })),
      userDays: userDayRows.map((row) => ({
        userId: row.user_id,
        days: row.days.map((day) => numberValue(day)),
      })),
    };
  });
}

export async function readPostgresAdminOverviewFromFleet(
  fleet: Pick<PostgresAuthorityFleet, "defaultShardId" | "physicalShards">,
  input: AdminOverviewInput,
): Promise<AdminPlatformOverview> {
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("admin overview now is invalid");
  const partitions = await Promise.all(fleet.physicalShards.map(({ shardId, database }) =>
    readShardPartition(database, shardId, input, shardId === fleet.defaultShardId)));
  const memberUserIds = new Set(partitions.flatMap((partition) =>
    partition.overview.users.map((user) => user.userId)));
  const machineTotals = emptyAdminPlatformTotals();
  const machineUsers: AdminUserSummary[] = [];
  for (const row of partitions.flatMap((partition) => partition.machines)) {
    const machines = numberValue(row.machines);
    machineTotals.machines += machines;
    machineTotals.onlineMachines += numberValue(row.online_machines);
    if (!memberUserIds.has(row.owner_user_id)) continue;
    machineUsers.push({
      userId: row.owner_user_id,
      ...(row.email ? { email: row.email } : {}),
      spaces: 0,
      ownedSpaces: 0,
      agentRegistrations: 0,
      machines,
      messages: 0,
    });
  }
  const machinePartition: AdminPlatformOverview = {
    generatedAt: input.now,
    activityDays: input.activityDays,
    totals: machineTotals,
    spaces: [],
    users: machineUsers,
    activity: [],
    storage: [],
    truncated: { spaces: false, users: false },
  };
  return withActiveUsers(
    mergeAdminOverviewPartitions(
      input,
      [...partitions.map((partition) => partition.overview), machinePartition],
    ),
    partitions.flatMap((partition) => partition.userDays),
  );
}

export function readPostgresAdminOverview(
  env: Env,
  input: AdminOverviewInput,
): Promise<AdminPlatformOverview> {
  const fleet = createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-admin-overview",
    statementTimeoutMs: 8_000,
    transactionTimeoutMs: 30_000,
    lockTimeoutMs: 2_000,
  });
  return readPostgresAdminOverviewFromFleet(fleet, input);
}
