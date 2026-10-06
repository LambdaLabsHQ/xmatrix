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
import {
  adminActivityUtcWindow,
  emptyAdminPlatformTotals,
  mergeAdminOverviewPartitions,
} from "./admin-overview-merge";

const ADMIN_OVERVIEW_USER_BOUND = 10_000;
const ADMIN_OVERVIEW_STORAGE_CATEGORY_BOUND = 1_000;
const ADMIN_OVERVIEW_MACHINE_OWNER_BOUND = 10_000;

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

async function readShardPartition(
  database: AuthorityDatabase,
  shardId: string,
  input: AdminOverviewInput,
  includeGlobalMachines: boolean,
): Promise<PostgresAdminOverviewPartition> {
  const now = new Date(input.now);
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000);
  const activityWindow = adminActivityUtcWindow(now.getTime(), input.activityDays);
  return database.transaction({
    requestId: `admin-overview:${shardId}`.slice(0, 200),
    operation: "admin.overview.read",
  }, async (transaction) => {
    const totals = (await transaction.query<TotalsRow>({
      name: "postgres_admin_totals_v4",
      text: `WITH space_totals AS (
          SELECT COUNT(*) AS spaces FROM data.spaces
        ), channel_totals AS (
          SELECT COUNT(*) AS channels,
            COUNT(*) AS active_channels FROM data.channels
        ), message_totals AS (
          SELECT COUNT(*) AS messages,
            COUNT(*) FILTER (WHERE created_at >= $1) AS messages_last_24h,
            COUNT(*) FILTER (WHERE created_at >= $2) AS messages_last_7d,
            COUNT(*) FILTER (WHERE author_kind = 'user') AS human_messages,
            COUNT(*) FILTER (WHERE author_kind = 'agent') AS agent_messages
           FROM data.messages WHERE deleted_at IS NULL
        ), run_totals AS (
          SELECT COUNT(*) AS runs,
            COUNT(*) FILTER (WHERE status IN ('starting', 'running')) AS active_runs FROM data.runs
        ), automation_totals AS (
          SELECT COUNT(*) AS automations,
            COUNT(*) FILTER (WHERE enabled) AS enabled_automations FROM data.automations
        )
        SELECT space_totals.*, channel_totals.*, message_totals.*,
          (SELECT COUNT(*) FROM data.space_agent_registrations) AS agent_registrations,
          run_totals.*, (SELECT COUNT(*) FROM data.instances) AS agent_instances,
          automation_totals.*,
          (SELECT COALESCE(SUM(logical_bytes), 0) FROM data.space_storage_usage) AS storage_logical_bytes
        FROM space_totals CROSS JOIN channel_totals CROSS JOIN message_totals
        CROSS JOIN run_totals CROSS JOIN automation_totals`,
      values: [since24h, since7d],
      maxRows: 1,
    }))[0];
    if (!totals) throw new Error("PostgreSQL admin overview totals are unavailable");

    const spaceRows = await transaction.query<SpaceRow>({
      name: "postgres_admin_spaces_v3",
      text: `WITH member_counts AS (
          SELECT space_id, COUNT(*) AS members FROM data.space_members GROUP BY space_id
        ), channel_counts AS (
          SELECT space_id, COUNT(*) AS channels,
            COUNT(*) AS active_channels
           FROM data.channels GROUP BY space_id
        ), agent_counts AS (
          SELECT space_id, COUNT(*) AS agent_registrations FROM data.space_agent_registrations GROUP BY space_id
        ), message_counts AS (
          SELECT space_id, COUNT(*) AS messages,
            COUNT(*) FILTER (WHERE created_at >= $1) AS messages_last_7d,
            MAX(created_at) AS last_message_at
           FROM data.messages WHERE deleted_at IS NULL GROUP BY space_id
        )
       SELECT s.space_id AS id, s.name, s.owner_user_id,
        COALESCE(member_counts.members, 0) AS members,
        COALESCE(channel_counts.channels, 0) AS channels,
        COALESCE(channel_counts.active_channels, 0) AS active_channels,
        COALESCE(agent_counts.agent_registrations, 0) AS agent_registrations,
        COALESCE(message_counts.messages, 0) AS messages,
        COALESCE(message_counts.messages_last_7d, 0) AS messages_last_7d,
        s.created_at, message_counts.last_message_at
       FROM data.spaces s LEFT JOIN member_counts USING (space_id)
       LEFT JOIN channel_counts USING (space_id) LEFT JOIN agent_counts USING (space_id)
       LEFT JOIN message_counts USING (space_id)
       ORDER BY s.created_at DESC, s.space_id LIMIT $2`,
      values: [since7d, input.spaceLimit + 1],
      maxRows: input.spaceLimit + 1,
    });

    const userRows = await transaction.query<UserRow>({
      name: "postgres_admin_users_v4",
      text: `WITH membership_users AS (
          SELECT user_id, MIN(email) AS email, COUNT(*) AS spaces,
            COUNT(*) FILTER (WHERE role = 'owner') AS owned_spaces,
            MIN(created_at) AS first_seen_at FROM data.space_members GROUP BY user_id
        ), agent_counts AS (
          SELECT owner_user_id AS user_id, COUNT(*) AS agent_registrations
           FROM data.space_agent_registrations GROUP BY owner_user_id
        ), message_counts AS (
          SELECT author_id AS user_id, COUNT(*) AS messages, MAX(created_at) AS last_message_at
           FROM data.messages WHERE author_kind = 'user' AND deleted_at IS NULL GROUP BY author_id
        )
       SELECT membership_users.*, COALESCE(agent_counts.agent_registrations, 0) AS agent_registrations,
        COALESCE(message_counts.messages, 0) AS messages, message_counts.last_message_at,
        COUNT(*) OVER () AS total_count
       FROM membership_users LEFT JOIN agent_counts USING (user_id)
       LEFT JOIN message_counts USING (user_id)
       ORDER BY spaces DESC, first_seen_at, user_id
       LIMIT ${ADMIN_OVERVIEW_USER_BOUND}`,
      maxRows: ADMIN_OVERVIEW_USER_BOUND,
    });
    if (numberValue(userRows[0]?.total_count) > ADMIN_OVERVIEW_USER_BOUND) {
      throw new Error("PostgreSQL admin overview user bound was reached");
    }

    const activityRows = await transaction.query<ActivityRow>({
      name: "postgres_admin_activity_v3",
      text: `WITH daily_counts AS (
        SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day,
          COUNT(*) AS messages,
          COUNT(*) FILTER (WHERE author_kind = 'user') AS human_messages,
          COUNT(*) FILTER (WHERE author_kind = 'agent') AS agent_messages
         FROM data.messages
         WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2
         GROUP BY date_trunc('day', created_at AT TIME ZONE 'UTC')
       )
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
         COALESCE(daily_counts.messages, 0) AS messages,
         COALESCE(daily_counts.human_messages, 0) AS human_messages,
         COALESCE(daily_counts.agent_messages, 0) AS agent_messages
        FROM generate_series($1::timestamptz AT TIME ZONE 'UTC',
          ($2::timestamptz AT TIME ZONE 'UTC') - interval '1 day',
          interval '1 day') AS days(day)
        LEFT JOIN daily_counts USING (day) ORDER BY days.day`,
      values: [activityWindow.since, activityWindow.before],
      maxRows: input.activityDays,
    });

    const storageRows = await transaction.query<StorageRow>({
      name: "postgres_admin_storage_v2",
      text: `SELECT category, SUM(logical_rows) AS rows, SUM(logical_bytes) AS logical_bytes,
        MAX(updated_at) AS updated_at FROM data.space_storage_usage
       GROUP BY category ORDER BY logical_bytes DESC, category
       LIMIT ${ADMIN_OVERVIEW_STORAGE_CATEGORY_BOUND + 1}`,
      maxRows: ADMIN_OVERVIEW_STORAGE_CATEGORY_BOUND + 1,
    });
    if (storageRows.length > ADMIN_OVERVIEW_STORAGE_CATEGORY_BOUND) {
      throw new Error("PostgreSQL admin overview storage-category bound was reached");
    }

    const machineRows = includeGlobalMachines ? await transaction.query<MachineRow>({
      name: "postgres_admin_machines_v3",
      text: `SELECT owner_user_id, MIN(owner_email) AS email, COUNT(*) AS machines,
        COUNT(*) FILTER (WHERE status = 'online') AS online_machines,
        COUNT(*) OVER () AS total_count
       FROM data.machine_daemons GROUP BY owner_user_id ORDER BY owner_user_id
       LIMIT ${ADMIN_OVERVIEW_MACHINE_OWNER_BOUND}`,
      maxRows: ADMIN_OVERVIEW_MACHINE_OWNER_BOUND,
    }) : [];
    if (numberValue(machineRows[0]?.total_count) > ADMIN_OVERVIEW_MACHINE_OWNER_BOUND) {
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
  return mergeAdminOverviewPartitions(
    input,
    [...partitions.map((partition) => partition.overview), machinePartition],
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
