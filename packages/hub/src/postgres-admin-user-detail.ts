/**
 * One user's operator detail, read from every physical shard and merged.
 *
 * Each query names its columns: metadata only. Message and page bodies,
 * `metadata_json`, `configuration_json`, connector secret refs and error
 * text, and Machine host names are never selected, so they cannot leak
 * through a later change to the response shape.
 */

import {
  ADMIN_USER_DETAIL_ACTIVITY_DAYS,
  ADMIN_USER_DETAIL_MAX_ROWS,
  type AdminUserAgentRegistration,
  type AdminUserConnector,
  type AdminUserDetail,
  type AdminUserMachine,
  type AdminUserSpaceMembership,
} from "@xmatrix/protocol";
import type { AuthorityDatabase } from "@xmatrix/db";
import type { QueryResultRow } from "pg";

import { adminActivityUtcWindow } from "./admin-overview-merge";
import {
  createPostgresAuthorityFleet,
  type PostgresAuthorityFleet,
} from "./postgres-authority-fleet";
import type { Env } from "./types";

type Count = string | number;
type Time = Date | string;

interface MembershipRow extends QueryResultRow {
  space_id: string; name: string; role: string; owner_user_id: string; joined_at: Time;
  members: Count; messages: Count;
  plan: string | null; billing_status: string | null; seat_quantity: number | null;
  current_period_end: Time | null; cancel_at_period_end: boolean | null; grace_until: Time | null;
}

interface AgentRow extends QueryResultRow {
  space_id: string; machine_id: string; harness: string; display_name: string;
  created_at: Time; updated_at: Time;
}

interface MachineRow extends QueryResultRow {
  machine_id: string; status: string; created_at: Time; updated_at: Time;
}

interface ConnectorRow extends QueryResultRow {
  space_id: string; provider_id: string; provider_name: string; status: string;
  created_at: Time; last_checked_at: Time | null;
}

interface RunRow extends QueryResultRow {
  status: string; runs: Count; last_30d: Count; last_run_at: Time | null;
}

interface MessageRow extends QueryResultRow {
  total: Count; last_7d: Count; last_30d: Count; last_message_at: Time | null;
}

interface ActivityRow extends QueryResultRow { day: string; messages: Count }

const ACTIVE_RUN_STATUSES = new Set(["starting", "running"]);

function count(value: Count | null | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("PostgreSQL admin user detail returned an invalid count");
  }
  return parsed;
}

function iso(value: Time): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function optionalIso(value: Time | null | undefined): string | undefined {
  return value == null ? undefined : iso(value);
}

/** The shard-local part of one user's detail, before identity is joined in. */
export type AdminUserShardDetail = Omit<AdminUserDetail, "generatedAt" | "user" | "sessions">;

async function readShard(
  database: AuthorityDatabase,
  shardId: string,
  userId: string,
  now: Date,
  includeMachines: boolean,
): Promise<AdminUserShardDetail> {
  const since7d = new Date(now.getTime() - 7 * 86_400_000);
  const since30d = new Date(now.getTime() - 30 * 86_400_000);
  const window = adminActivityUtcWindow(now.getTime(), ADMIN_USER_DETAIL_ACTIVITY_DAYS);
  const bound = ADMIN_USER_DETAIL_MAX_ROWS;
  return database.transaction({
    requestId: `admin-user-detail:${shardId}`.slice(0, 200),
    operation: "admin.user.detail.read",
  }, async (transaction) => {
    const memberships = await transaction.query<MembershipRow>({
      name: "postgres_admin_user_spaces_v1",
      text: `SELECT m.space_id, s.name, m.role, s.owner_user_id, m.created_at AS joined_at,
          (SELECT COUNT(*) FROM data.space_members all_members
            WHERE all_members.space_id = m.space_id) AS members,
          (SELECT COUNT(*) FROM data.messages msg WHERE msg.space_id = m.space_id
            AND msg.author_kind = 'user' AND msg.author_id = m.user_id
            AND msg.deleted_at IS NULL) AS messages,
          b.plan, b.status AS billing_status, b.seat_quantity, b.current_period_end,
          b.cancel_at_period_end, b.grace_until
        FROM data.space_members m JOIN data.spaces s USING (space_id)
        LEFT JOIN data.space_billing_subscriptions b ON b.space_id = m.space_id
        WHERE m.user_id = $1 ORDER BY m.created_at DESC, m.space_id LIMIT $2`,
      values: [userId, bound + 1],
      maxRows: bound + 1,
    });
    const spaceIds = memberships.map((row) => row.space_id);

    const agents = await transaction.query<AgentRow>({
      name: "postgres_admin_user_agents_v1",
      text: `SELECT space_id, machine_id, harness, display_name, created_at, updated_at
        FROM data.space_agent_registrations WHERE owner_user_id = $1
        ORDER BY updated_at DESC, space_id, machine_id, harness LIMIT $2`,
      values: [userId, bound + 1],
      maxRows: bound + 1,
    });

    const machines = includeMachines ? await transaction.query<MachineRow>({
      name: "postgres_admin_user_machines_v1",
      text: `SELECT machine_id, status, created_at, updated_at
        FROM data.machine_daemons WHERE owner_user_id = $1
        ORDER BY updated_at DESC, machine_id LIMIT $2`,
      values: [userId, bound + 1],
      maxRows: bound + 1,
    }) : [];

    const connectors = await transaction.query<ConnectorRow>({
      name: "postgres_admin_user_connectors_v1",
      text: `SELECT space_id, provider_id, provider_name, status, created_at, last_checked_at
        FROM data.app_connector_connections WHERE created_by = $1
        ORDER BY created_at DESC, connection_id LIMIT $2`,
      values: [userId, bound + 1],
      maxRows: bound + 1,
    });

    const runs = await transaction.query<RunRow>({
      name: "postgres_admin_user_runs_v1",
      text: `SELECT status, COUNT(*) AS runs,
          COUNT(*) FILTER (WHERE created_at >= $2) AS last_30d,
          MAX(created_at) AS last_run_at
        FROM data.runs WHERE owner_user_id = $1 GROUP BY status ORDER BY status LIMIT 100`,
      values: [userId, since30d],
      maxRows: 100,
    });

    const messages = spaceIds.length ? (await transaction.query<MessageRow>({
      name: "postgres_admin_user_messages_v1",
      text: `SELECT COUNT(*) AS total,
          COUNT(*) FILTER (WHERE created_at >= $3) AS last_7d,
          COUNT(*) FILTER (WHERE created_at >= $4) AS last_30d,
          MAX(created_at) AS last_message_at
        FROM data.messages WHERE space_id = ANY($1::text[]) AND author_kind = 'user'
          AND author_id = $2 AND deleted_at IS NULL`,
      values: [spaceIds, userId, since7d, since30d],
      maxRows: 1,
    }))[0] : undefined;

    const activity = spaceIds.length ? await transaction.query<ActivityRow>({
      name: "postgres_admin_user_activity_v1",
      text: `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
          COUNT(*) AS messages
        FROM data.messages WHERE space_id = ANY($1::text[]) AND author_kind = 'user'
          AND author_id = $2 AND deleted_at IS NULL AND created_at >= $3 AND created_at < $4
        GROUP BY 1 ORDER BY 1`,
      values: [spaceIds, userId, window.since, window.before],
      maxRows: ADMIN_USER_DETAIL_ACTIVITY_DAYS,
    }) : [];

    const pages = (await transaction.query<{ pages: Count } & QueryResultRow>({
      name: "postgres_admin_user_pages_v1",
      text: "SELECT COUNT(*) AS pages FROM data.pages WHERE created_by_user_id = $1",
      values: [userId],
      maxRows: 1,
    }))[0];

    const truncated: string[] = [];
    const cut = <T>(rows: readonly T[], key: string): T[] => {
      if (rows.length > bound) truncated.push(key);
      return rows.slice(0, bound);
    };
    const byStatus: Record<string, number> = {};
    let lastRunAt: string | undefined;
    for (const row of runs) {
      byStatus[row.status] = count(row.runs);
      const at = optionalIso(row.last_run_at);
      if (at && (!lastRunAt || at > lastRunAt)) lastRunAt = at;
    }
    const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0);
    return {
      spaces: cut(memberships, "spaces").map((row): AdminUserSpaceMembership => ({
        spaceId: row.space_id,
        name: row.name,
        role: row.role,
        ownerUserId: row.owner_user_id,
        joinedAt: iso(row.joined_at),
        members: count(row.members),
        messages: count(row.messages),
        ...(row.plan && row.billing_status ? {
          billing: {
            plan: row.plan,
            status: row.billing_status,
            seats: row.seat_quantity ?? 0,
            ...(optionalIso(row.current_period_end) ? { currentPeriodEnd: optionalIso(row.current_period_end) } : {}),
            cancelAtPeriodEnd: row.cancel_at_period_end === true,
            ...(optionalIso(row.grace_until) ? { graceUntil: optionalIso(row.grace_until) } : {}),
          },
        } : {}),
      })),
      agents: cut(agents, "agents").map((row): AdminUserAgentRegistration => ({
        spaceId: row.space_id,
        machineId: row.machine_id,
        harness: row.harness,
        displayName: row.display_name,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      })),
      machines: cut(machines, "machines").map((row): AdminUserMachine => ({
        machineId: row.machine_id,
        status: row.status,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      })),
      connectors: cut(connectors, "connectors").map((row): AdminUserConnector => ({
        spaceId: row.space_id,
        providerId: row.provider_id,
        providerName: row.provider_name,
        status: row.status,
        createdAt: iso(row.created_at),
        ...(optionalIso(row.last_checked_at) ? { lastCheckedAt: optionalIso(row.last_checked_at) } : {}),
      })),
      runs: {
        total,
        active: Object.entries(byStatus)
          .filter(([status]) => ACTIVE_RUN_STATUSES.has(status))
          .reduce((sum, [, value]) => sum + value, 0),
        last30d: runs.reduce((sum, row) => sum + count(row.last_30d), 0),
        byStatus,
        ...(lastRunAt ? { lastRunAt } : {}),
      },
      messages: {
        total: count(messages?.total),
        last7d: count(messages?.last_7d),
        last30d: count(messages?.last_30d),
        ...(optionalIso(messages?.last_message_at) ? { lastMessageAt: optionalIso(messages?.last_message_at) } : {}),
      },
      pagesCreated: count(pages?.pages),
      activity: activity.map((row) => ({ date: row.day, messages: count(row.messages) })),
      truncated,
    };
  });
}

function laterOf(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

/** Merge shard parts and fill the activity series with zero days, oldest first. */
export function mergeAdminUserShardDetails(
  parts: readonly AdminUserShardDetail[],
  nowMs: number,
): AdminUserShardDetail {
  const window = adminActivityUtcWindow(nowMs, ADMIN_USER_DETAIL_ACTIVITY_DAYS);
  const daily = new Map<string, number>();
  for (let day = new Date(window.since).getTime(); day < new Date(window.before).getTime(); day += 86_400_000) {
    daily.set(new Date(day).toISOString().slice(0, 10), 0);
  }
  const byStatus: Record<string, number> = {};
  const merged: AdminUserShardDetail = {
    spaces: [], agents: [], machines: [], connectors: [],
    runs: { total: 0, active: 0, last30d: 0, byStatus },
    messages: { total: 0, last7d: 0, last30d: 0 },
    pagesCreated: 0,
    activity: [],
    truncated: [],
  };
  for (const part of parts) {
    merged.spaces.push(...part.spaces);
    merged.agents.push(...part.agents);
    merged.machines.push(...part.machines);
    merged.connectors.push(...part.connectors);
    merged.runs.total += part.runs.total;
    merged.runs.active += part.runs.active;
    merged.runs.last30d += part.runs.last30d;
    for (const [status, value] of Object.entries(part.runs.byStatus)) {
      byStatus[status] = (byStatus[status] ?? 0) + value;
    }
    const lastRunAt = laterOf(merged.runs.lastRunAt, part.runs.lastRunAt);
    if (lastRunAt) merged.runs.lastRunAt = lastRunAt;
    merged.messages.total += part.messages.total;
    merged.messages.last7d += part.messages.last7d;
    merged.messages.last30d += part.messages.last30d;
    const lastMessageAt = laterOf(merged.messages.lastMessageAt, part.messages.lastMessageAt);
    if (lastMessageAt) merged.messages.lastMessageAt = lastMessageAt;
    merged.pagesCreated += part.pagesCreated;
    for (const point of part.activity) {
      if (daily.has(point.date)) daily.set(point.date, daily.get(point.date)! + point.messages);
    }
    for (const key of part.truncated) if (!merged.truncated.includes(key)) merged.truncated.push(key);
  }
  merged.activity = [...daily].map(([date, messages]) => ({ date, messages }));
  return merged;
}

export async function readPostgresAdminUserDetailFromFleet(
  fleet: Pick<PostgresAuthorityFleet, "defaultShardId" | "physicalShards">,
  userId: string,
  now: string,
): Promise<AdminUserShardDetail> {
  const nowDate = new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error("admin user detail now is invalid");
  const parts = await Promise.all(fleet.physicalShards.map(({ shardId, database }) =>
    readShard(database, shardId, userId, nowDate, shardId === fleet.defaultShardId)));
  return mergeAdminUserShardDetails(parts, nowDate.getTime());
}

export function readPostgresAdminUserDetail(
  env: Env,
  userId: string,
  now: string,
): Promise<AdminUserShardDetail> {
  const fleet = createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-admin-user-detail",
    statementTimeoutMs: 8_000,
    transactionTimeoutMs: 20_000,
    lockTimeoutMs: 2_000,
  });
  return readPostgresAdminUserDetailFromFleet(fleet, userId, now);
}
