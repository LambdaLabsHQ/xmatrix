/**
 * One Space's operator detail.
 *
 * A Space lives on one shard, so each physical shard is asked and the one that
 * holds it answers. Each query names its columns: metadata only. Message and
 * page bodies, Automation payloads and error text, connector secrets, scopes
 * and errors, billing provider ids and payload digests, invite tokens, and
 * every `metadata_json` are never selected.
 */

import {
  ADMIN_SPACE_DETAIL_DAYS,
  ADMIN_SPACE_DETAIL_MAX_ROWS,
  type AdminSpaceDetail,
} from "@xmatrix/protocol";
import type { AuthorityDatabase } from "@xmatrix/db";
import type { QueryResultRow } from "pg";

import { adminActivityUtcWindow } from "./admin-overview-merge";
import {
  adminCount as count,
  adminIso as iso,
  adminOptionalIso as optionalIso,
  adminPaidCallKinds,
  type AdminCountValue as Count,
  type AdminPaidCallRow,
  type AdminTimeValue as Time,
} from "./postgres-admin-values";
import {
  createPostgresAuthorityFleet,
  type PostgresAuthorityFleet,
} from "./postgres-authority-fleet";
import type { Env } from "./types";

interface SpaceRow extends QueryResultRow {
  space_id: string; name: string; owner_user_id: string; created_at: Time;
}

interface TotalsRow extends QueryResultRow {
  members: Count; channels: Count; agents: Count; pages: Count; storage_logical_bytes: Count;
  active_invites: Count; pending_join_requests: Count; free_messages: Count;
  messages: Count; messages_last_7d: Count; messages_last_30d: Count;
  human_messages: Count; agent_messages: Count; last_message_at: Time | null;
}

interface MemberRow extends QueryResultRow {
  user_id: string; email: string | null; role: string; created_at: Time; messages: Count;
}

interface AgentRow extends QueryResultRow {
  machine_id: string; harness: string; display_name: string; owner_user_id: string;
  created_at: Time; updated_at: Time;
}

interface ConnectorRow extends QueryResultRow {
  provider_id: string; provider_name: string; status: string; auth_mode: string;
  created_by: string | null; created_at: Time; last_checked_at: Time | null;
}

interface AutomationRow extends QueryResultRow {
  total: Count; enabled: Count; with_error: Count; run_count: Count; last_run_at: Time | null;
}

interface StatusRow extends QueryResultRow { status: string; total: Count; last_at?: Time | null }

interface BillingRow extends QueryResultRow {
  plan: string; status: string; seat_quantity: number; billing_provider: string | null;
  current_period_end: Time | null; cancel_at_period_end: boolean; grace_until: Time | null;
  updated_at: Time;
}

interface WebhookRow extends QueryResultRow {
  space_id: string; event_type: string; outcome: string; processed_at: Time;
}

interface StorageRow extends QueryResultRow { category: string; logical_rows: Count; logical_bytes: Count }

interface ActivityRow extends QueryResultRow {
  day: string; messages: Count; human_messages: Count; agent_messages: Count;
}

/** Space-scoped Channels: Runs and Automations reach their Space through them. */
const SPACE_CHANNELS = "SELECT channel_id FROM data.channels WHERE space_id = $1";

async function readShard(
  database: AuthorityDatabase,
  shardId: string,
  spaceId: string,
  now: Date,
): Promise<Omit<AdminSpaceDetail, "generatedAt"> | null> {
  const since7d = new Date(now.getTime() - 7 * 86_400_000);
  const window = adminActivityUtcWindow(now.getTime(), ADMIN_SPACE_DETAIL_DAYS);
  const since = new Date(window.since);
  const bound = ADMIN_SPACE_DETAIL_MAX_ROWS;
  return database.transaction({
    requestId: `admin-space-detail:${shardId}`.slice(0, 200),
    operation: "admin.space.detail.read",
  }, async (transaction) => {
    const space = (await transaction.query<SpaceRow>({
      name: "postgres_admin_space_v1",
      text: "SELECT space_id, name, owner_user_id, created_at FROM data.spaces WHERE space_id = $1",
      values: [spaceId],
      maxRows: 1,
    }))[0];
    if (!space) return null;

    const totals = (await transaction.query<TotalsRow>({
      name: "postgres_admin_space_totals_v1",
      text: `WITH space_messages AS (
          SELECT author_kind, created_at FROM data.messages
          WHERE space_id = $1 AND deleted_at IS NULL
        )
        SELECT
          (SELECT COUNT(*) FROM data.space_members WHERE space_id = $1) AS members,
          (SELECT COUNT(*) FROM data.channels WHERE space_id = $1) AS channels,
          (SELECT COUNT(*) FROM data.space_agent_registrations WHERE space_id = $1) AS agents,
          (SELECT COUNT(*) FROM data.pages WHERE space_id = $1) AS pages,
          (SELECT COALESCE(SUM(logical_bytes), 0) FROM data.space_storage_usage
            WHERE space_id = $1) AS storage_logical_bytes,
          (SELECT COUNT(*) FROM data.space_invites WHERE space_id = $1 AND status = 'active'
            AND (expires_at IS NULL OR expires_at > $2)) AS active_invites,
          (SELECT COUNT(*) FROM data.space_join_requests WHERE space_id = $1
            AND status = 'pending') AS pending_join_requests,
          (SELECT COALESCE(MAX(free_message_count), 0) FROM data.space_billing_usage
            WHERE space_id = $1) AS free_messages,
          COUNT(*) AS messages,
          COUNT(*) FILTER (WHERE created_at >= $3) AS messages_last_7d,
          COUNT(*) FILTER (WHERE created_at >= $4) AS messages_last_30d,
          COUNT(*) FILTER (WHERE author_kind = 'user') AS human_messages,
          COUNT(*) FILTER (WHERE author_kind = 'agent') AS agent_messages,
          MAX(created_at) AS last_message_at
        FROM space_messages`,
      values: [spaceId, now, since7d, since],
      maxRows: 1,
    }))[0];

    const members = await transaction.query<MemberRow>({
      name: "postgres_admin_space_members_v1",
      text: `SELECT m.user_id, m.email, m.role, m.created_at,
          (SELECT COUNT(*) FROM data.messages msg WHERE msg.space_id = m.space_id
            AND msg.author_kind = 'user' AND msg.author_id = m.user_id
            AND msg.deleted_at IS NULL) AS messages
        FROM data.space_members m WHERE m.space_id = $1
        ORDER BY m.created_at, m.user_id LIMIT $2`,
      values: [spaceId, bound + 1],
      maxRows: bound + 1,
    });

    const agents = await transaction.query<AgentRow>({
      name: "postgres_admin_space_agents_v1",
      text: `SELECT machine_id, harness, display_name, owner_user_id, created_at, updated_at
        FROM data.space_agent_registrations WHERE space_id = $1
        ORDER BY updated_at DESC, machine_id, harness LIMIT $2`,
      values: [spaceId, bound + 1],
      maxRows: bound + 1,
    });

    const connectors = await transaction.query<ConnectorRow>({
      name: "postgres_admin_space_connectors_v1",
      text: `SELECT provider_id, provider_name, status, auth_mode, created_by, created_at, last_checked_at
        FROM data.app_connector_connections WHERE space_id = $1
        ORDER BY created_at DESC, connection_id LIMIT $2`,
      values: [spaceId, bound + 1],
      maxRows: bound + 1,
    });

    const automations = (await transaction.query<AutomationRow>({
      name: "postgres_admin_space_automations_v1",
      text: `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE enabled) AS enabled,
          COUNT(*) FILTER (WHERE last_error IS NOT NULL) AS with_error,
          COALESCE(SUM(run_count), 0) AS run_count, MAX(last_run_at) AS last_run_at
        FROM data.automations WHERE channel_id IN (${SPACE_CHANNELS})`,
      values: [spaceId],
      maxRows: 1,
    }))[0];

    const occurrences = await transaction.query<StatusRow>({
      name: "postgres_admin_space_occurrences_v1",
      text: `SELECT occurrence.status, COUNT(*) AS total
        FROM data.automation_occurrences occurrence
        JOIN data.automations automation USING (automation_id)
        WHERE automation.channel_id IN (${SPACE_CHANNELS}) AND occurrence.scheduled_for >= $2
        GROUP BY occurrence.status ORDER BY occurrence.status LIMIT 50`,
      values: [spaceId, since],
      maxRows: 50,
    });

    const runs = await transaction.query<StatusRow>({
      name: "postgres_admin_space_runs_v1",
      text: `SELECT status, COUNT(*) AS total, MAX(created_at) AS last_at FROM data.runs
        WHERE channel_id IN (${SPACE_CHANNELS}) AND created_at >= $2
        GROUP BY status ORDER BY status LIMIT 50`,
      values: [spaceId, since],
      maxRows: 50,
    });

    const billing = (await transaction.query<BillingRow>({
      name: "postgres_admin_space_billing_v1",
      text: `SELECT plan, status, seat_quantity, billing_provider, current_period_end,
          cancel_at_period_end, grace_until, updated_at
        FROM data.space_billing_subscriptions WHERE space_id = $1`,
      values: [spaceId],
      maxRows: 1,
    }))[0];

    const webhooks = await transaction.query<WebhookRow>({
      name: "postgres_admin_space_webhooks_v1",
      text: `SELECT space_id, event_type, outcome, processed_at
        FROM data.space_billing_webhook_events WHERE space_id = $1
        ORDER BY processed_at DESC, provider_event_id LIMIT 50`,
      values: [spaceId],
      maxRows: 50,
    });

    const paidCalls = await transaction.query<AdminPaidCallRow>({
      name: "postgres_admin_space_paid_calls_v1",
      text: `SELECT kind, status, outcome, COUNT(*) AS calls,
          COALESCE(SUM(COALESCE(actual_units, reserved_units)), 0) AS units,
          COALESCE(SUM(COALESCE(actual_credits, reserved_credits)), 0) AS credits
        FROM data.paid_call_receipts WHERE space_id = $1 AND created_at >= $2
        GROUP BY kind, status, outcome ORDER BY kind LIMIT 500`,
      values: [spaceId, since],
      maxRows: 500,
    });

    const storage = await transaction.query<StorageRow>({
      name: "postgres_admin_space_storage_v1",
      text: `SELECT category, logical_rows, logical_bytes FROM data.space_storage_usage
        WHERE space_id = $1 ORDER BY logical_bytes DESC, category LIMIT 100`,
      values: [spaceId],
      maxRows: 100,
    });

    const activity = await transaction.query<ActivityRow>({
      name: "postgres_admin_space_activity_v1",
      text: `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
          COUNT(*) AS messages,
          COUNT(*) FILTER (WHERE author_kind = 'user') AS human_messages,
          COUNT(*) FILTER (WHERE author_kind = 'agent') AS agent_messages
        FROM data.messages WHERE space_id = $1 AND deleted_at IS NULL
          AND created_at >= $2 AND created_at < $3
        GROUP BY 1 ORDER BY 1`,
      values: [spaceId, window.since, window.before],
      maxRows: ADMIN_SPACE_DETAIL_DAYS,
    });

    const truncated: string[] = [];
    const cut = <T>(rows: readonly T[], key: string): T[] => {
      if (rows.length > bound) truncated.push(key);
      return rows.slice(0, bound);
    };
    const byStatus = (rows: readonly StatusRow[]) =>
      Object.fromEntries(rows.map((row) => [row.status, count(row.total)]));
    const daily = new Map(activity.map((row) => [row.day, row]));
    const days: AdminSpaceDetail["activity"] = [];
    for (let day = since.getTime(); day < new Date(window.before).getTime(); day += 86_400_000) {
      const date = new Date(day).toISOString().slice(0, 10);
      const row = daily.get(date);
      days.push({
        date,
        messages: count(row?.messages),
        humanMessages: count(row?.human_messages),
        agentMessages: count(row?.agent_messages),
      });
    }
    const lastRunAt = runs.map((row) => optionalIso(row.last_at)).filter(Boolean).sort().at(-1);
    const memberRows = cut(members, "members");
    const ownerEmail = members.find((row) => row.user_id === space.owner_user_id)?.email;
    const lastMessageAt = optionalIso(totals?.last_message_at);
    const lastAutomationRunAt = optionalIso(automations?.last_run_at);

    return {
      space: {
        spaceId: space.space_id,
        name: space.name,
        ownerUserId: space.owner_user_id,
        ...(ownerEmail ? { ownerEmail } : {}),
        createdAt: iso(space.created_at),
        ...(lastMessageAt ? { lastMessageAt } : {}),
      },
      totals: {
        members: count(totals?.members),
        channels: count(totals?.channels),
        agents: count(totals?.agents),
        messages: count(totals?.messages),
        messagesLast7d: count(totals?.messages_last_7d),
        messagesLast30d: count(totals?.messages_last_30d),
        humanMessages: count(totals?.human_messages),
        agentMessages: count(totals?.agent_messages),
        pages: count(totals?.pages),
        storageLogicalBytes: count(totals?.storage_logical_bytes),
        activeInvites: count(totals?.active_invites),
        pendingJoinRequests: count(totals?.pending_join_requests),
      },
      members: memberRows.map((row) => ({
        userId: row.user_id,
        ...(row.email ? { email: row.email } : {}),
        role: row.role,
        joinedAt: iso(row.created_at),
        messages: count(row.messages),
      })),
      agents: cut(agents, "agents").map((row) => ({
        machineId: row.machine_id,
        harness: row.harness,
        displayName: row.display_name,
        ownerUserId: row.owner_user_id,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      })),
      connectors: cut(connectors, "connectors").map((row) => {
        const lastCheckedAt = optionalIso(row.last_checked_at);
        return {
          providerId: row.provider_id,
          providerName: row.provider_name,
          status: row.status,
          authMode: row.auth_mode,
          ...(row.created_by ? { createdBy: row.created_by } : {}),
          createdAt: iso(row.created_at),
          ...(lastCheckedAt ? { lastCheckedAt } : {}),
        };
      }),
      automations: {
        total: count(automations?.total),
        enabled: count(automations?.enabled),
        withError: count(automations?.with_error),
        runCount: count(automations?.run_count),
        ...(lastAutomationRunAt ? { lastRunAt: lastAutomationRunAt } : {}),
        occurrencesByStatus: byStatus(occurrences),
      },
      runs: {
        total: runs.reduce((sum, row) => sum + count(row.total), 0),
        byStatus: byStatus(runs),
        ...(lastRunAt ? { lastRunAt } : {}),
      },
      ...(billing ? {
        billing: {
          plan: billing.plan,
          status: billing.status,
          seats: billing.seat_quantity,
          ...(billing.billing_provider ? { provider: billing.billing_provider } : {}),
          ...(optionalIso(billing.current_period_end)
            ? { currentPeriodEnd: optionalIso(billing.current_period_end) } : {}),
          cancelAtPeriodEnd: billing.cancel_at_period_end === true,
          ...(optionalIso(billing.grace_until) ? { graceUntil: optionalIso(billing.grace_until) } : {}),
          updatedAt: iso(billing.updated_at),
        },
      } : {}),
      freeMessages: count(totals?.free_messages),
      webhookEvents: webhooks.map((row) => ({
        spaceId: row.space_id,
        eventType: row.event_type,
        outcome: row.outcome,
        processedAt: iso(row.processed_at),
      })),
      paidCalls: adminPaidCallKinds(paidCalls),
      storage: storage.map((row) => ({
        category: row.category,
        rows: count(row.logical_rows),
        logicalBytes: count(row.logical_bytes),
      })),
      activity: days,
      truncated,
    };
  });
}

export async function readPostgresAdminSpaceDetailFromFleet(
  fleet: Pick<PostgresAuthorityFleet, "physicalShards">,
  spaceId: string,
  now: string,
): Promise<AdminSpaceDetail | null> {
  const nowDate = new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error("admin space detail now is invalid");
  const parts = await Promise.all(fleet.physicalShards.map(({ shardId, database }) =>
    readShard(database, shardId, spaceId, nowDate)));
  const found = parts.find((part) => part !== null);
  return found ? { generatedAt: now, ...found } : null;
}

export function readPostgresAdminSpaceDetail(
  env: Env,
  spaceId: string,
  now: string,
): Promise<AdminSpaceDetail | null> {
  const fleet = createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-admin-space-detail",
    statementTimeoutMs: 8_000,
    transactionTimeoutMs: 20_000,
    lockTimeoutMs: 2_000,
  });
  return readPostgresAdminSpaceDetailFromFleet(fleet, spaceId, now);
}
