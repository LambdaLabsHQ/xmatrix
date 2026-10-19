/**
 * Platform operations for operators: Machines and Agent runtimes, Runs,
 * Automations, the event delivery queue, billing, and paid calls.
 *
 * Each query names its columns: metadata only. Machine host and display
 * names, capabilities, Run and Automation payloads and error text, outbox
 * payloads, billing provider ids and payload digests, and every
 * `metadata_json` are never selected. Machines live on the directory shard;
 * everything else is read from every physical shard and merged.
 */

import {
  ADMIN_OPERATIONS_DAYS,
  ADMIN_OPERATIONS_MAX_ROWS,
  ACTIVE_RUN_STATUSES,
  type AdminBillingWebhookEvent,
  type AdminOperations,
  type AdminOperationsSubscription,
} from "@xmatrix/protocol";
import type { AuthorityDatabase } from "@xmatrix/db";
import type { QueryResultRow } from "pg";

import { adminActivityUtcWindow } from "./admin-overview-merge";
import {
  addAdminCounts,
  adminCount,
  adminIso,
  adminOptionalIso,
  adminPaidCallKinds,
  type AdminCountValue,
  type AdminPaidCallRow,
  type AdminTimeValue,
} from "./postgres-admin-values";
import {
  createPostgresAuthorityFleet,
  type PostgresAuthorityFleet,
} from "./postgres-authority-fleet";
import type { Env } from "./types";

/** How late a pending Automation occurrence may be before it counts as overdue. */
const OVERDUE_AFTER_MS = 5 * 60_000;
const WEBHOOK_ROWS = 200;
const HARNESS_OWNER_ROWS = 10_000;

interface MachineRow extends QueryResultRow {
  machine_id: string; owner_user_id: string; owner_email: string; status: string;
  created_at: AdminTimeValue; updated_at: AdminTimeValue;
}

interface StatusRow extends QueryResultRow { status: string; total: AdminCountValue }

interface HarnessRow extends QueryResultRow { harness: string; owner_user_id: string; agents: AdminCountValue }

interface HarnessSpacesRow extends QueryResultRow { harness: string; spaces: AdminCountValue }

interface RunTotalsRow extends QueryResultRow { active: AdminCountValue }

interface RunDayRow extends QueryResultRow { day: string; started: AdminCountValue; failed: AdminCountValue }

interface AutomationRow extends QueryResultRow { total: AdminCountValue; enabled: AdminCountValue; with_error: AdminCountValue }

interface OverdueRow extends QueryResultRow { overdue: AdminCountValue }

interface OutboxRow extends QueryResultRow {
  status: string; total: AdminCountValue; oldest_pending_at: AdminTimeValue | null; max_attempts: AdminCountValue | null;
}

interface SubscriptionRow extends QueryResultRow {
  space_id: string; space_name: string | null; plan: string; status: string; seat_quantity: number;
  billing_provider: string | null; current_period_end: AdminTimeValue | null; cancel_at_period_end: boolean;
  grace_until: AdminTimeValue | null; updated_at: AdminTimeValue;
}

interface WebhookRow extends QueryResultRow {
  space_id: string; event_type: string; outcome: string; processed_at: AdminTimeValue;
}

interface MachineCountRow extends QueryResultRow { machine_id: string; total: AdminCountValue }

interface ShardPart {
  machines: readonly MachineRow[];
  machinesByStatus: Record<string, number>;
  harnesses: readonly HarnessRow[];
  harnessSpaces: readonly HarnessSpacesRow[];
  activeRuns: number;
  runsByStatus: Record<string, number>;
  runDays: readonly RunDayRow[];
  automations: { total: number; enabled: number; withError: number; overdue: number };
  occurrencesByStatus: Record<string, number>;
  outbox: readonly OutboxRow[];
  subscriptions: AdminOperationsSubscription[];
  webhookEvents: AdminBillingWebhookEvent[];
  webhooksByOutcome: Record<string, number>;
  paidCalls: readonly AdminPaidCallRow[];
  truncated: string[];
}

function statusCounts(rows: readonly StatusRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, adminCount(row.total)]));
}

async function readShard(
  database: AuthorityDatabase,
  shardId: string,
  now: Date,
  includeMachines: boolean,
): Promise<ShardPart> {
  const window = adminActivityUtcWindow(now.getTime(), ADMIN_OPERATIONS_DAYS);
  const since = new Date(window.since);
  const bound = ADMIN_OPERATIONS_MAX_ROWS;
  const active = [...ACTIVE_RUN_STATUSES];
  return database.transaction({
    requestId: `admin-operations:${shardId}`.slice(0, 200),
    operation: "admin.operations.read",
  }, async (transaction) => {
    const machines = includeMachines ? await transaction.query<MachineRow>({
      name: "postgres_admin_operations_machines_v1",
      text: `SELECT machine_id, owner_user_id, owner_email, status, created_at, updated_at
        FROM data.machine_daemons ORDER BY updated_at DESC, machine_id LIMIT $1`,
      values: [bound + 1],
      maxRows: bound + 1,
    }) : [];
    const machineStatuses = includeMachines ? await transaction.query<StatusRow>({
      name: "postgres_admin_operations_machine_statuses_v1",
      text: `SELECT status, COUNT(*) AS total FROM data.machine_daemons
        GROUP BY status ORDER BY status LIMIT 20`,
      values: [],
      maxRows: 20,
    }) : [];

    const harnesses = await transaction.query<HarnessRow>({
      name: "postgres_admin_operations_harnesses_v1",
      text: `SELECT harness, owner_user_id, COUNT(*) AS agents
        FROM data.space_agent_registrations GROUP BY harness, owner_user_id
        ORDER BY harness, owner_user_id LIMIT $1`,
      values: [HARNESS_OWNER_ROWS],
      maxRows: HARNESS_OWNER_ROWS,
    });

    const harnessSpaces = await transaction.query<HarnessSpacesRow>({
      name: "postgres_admin_operations_harness_spaces_v1",
      text: `SELECT harness, COUNT(DISTINCT space_id) AS spaces FROM data.space_agent_registrations
        GROUP BY harness ORDER BY harness LIMIT 500`,
      values: [],
      maxRows: 500,
    });

    const runTotals = (await transaction.query<RunTotalsRow>({
      name: "postgres_admin_operations_active_runs_v1",
      text: "SELECT COUNT(*) AS active FROM data.runs WHERE status = ANY($1::text[])",
      values: [active],
      maxRows: 1,
    }))[0];
    const runStatuses = await transaction.query<StatusRow>({
      name: "postgres_admin_operations_run_statuses_v1",
      text: `SELECT status, COUNT(*) AS total FROM data.runs WHERE created_at >= $1
        GROUP BY status ORDER BY status LIMIT 50`,
      values: [since],
      maxRows: 50,
    });
    const runDays = await transaction.query<RunDayRow>({
      name: "postgres_admin_operations_run_days_v1",
      text: `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
          COUNT(*) AS started, COUNT(*) FILTER (WHERE status = 'failed') AS failed
        FROM data.runs WHERE created_at >= $1 AND created_at < $2
        GROUP BY 1 ORDER BY 1`,
      values: [window.since, window.before],
      maxRows: ADMIN_OPERATIONS_DAYS,
    });

    const automations = (await transaction.query<AutomationRow>({
      name: "postgres_admin_operations_automations_v1",
      text: `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE enabled) AS enabled,
          COUNT(*) FILTER (WHERE last_error IS NOT NULL) AS with_error
        FROM data.automations`,
      values: [],
      maxRows: 1,
    }))[0];
    const occurrences = await transaction.query<StatusRow>({
      name: "postgres_admin_operations_occurrences_v1",
      text: `SELECT status, COUNT(*) AS total FROM data.automation_occurrences
        WHERE scheduled_for >= $1 GROUP BY status ORDER BY status LIMIT 50`,
      values: [since],
      maxRows: 50,
    });
    const overdue = (await transaction.query<OverdueRow>({
      name: "postgres_admin_operations_overdue_v1",
      text: `SELECT COUNT(*) AS overdue FROM data.automation_occurrences
        WHERE status = 'pending' AND COALESCE(next_attempt_at, scheduled_for) < $1`,
      values: [new Date(now.getTime() - OVERDUE_AFTER_MS)],
      maxRows: 1,
    }))[0];

    const outbox = await transaction.query<OutboxRow>({
      name: "postgres_admin_operations_outbox_v1",
      text: `SELECT status, COUNT(*) AS total,
          MIN(created_at) FILTER (WHERE status IN ('pending', 'leased')) AS oldest_pending_at,
          MAX(attempts) FILTER (WHERE status <> 'delivered') AS max_attempts
        FROM data.outbox GROUP BY status ORDER BY status LIMIT 20`,
      values: [],
      maxRows: 20,
    });

    const subscriptions = await transaction.query<SubscriptionRow>({
      name: "postgres_admin_operations_subscriptions_v1",
      text: `SELECT b.space_id, s.name AS space_name, b.plan, b.status, b.seat_quantity,
          b.billing_provider, b.current_period_end, b.cancel_at_period_end, b.grace_until, b.updated_at
        FROM data.space_billing_subscriptions b LEFT JOIN data.spaces s USING (space_id)
        ORDER BY b.updated_at DESC, b.space_id LIMIT $1`,
      values: [bound + 1],
      maxRows: bound + 1,
    });
    const webhooks = await transaction.query<WebhookRow>({
      name: "postgres_admin_operations_webhooks_v1",
      text: `SELECT space_id, event_type, outcome, processed_at
        FROM data.space_billing_webhook_events WHERE processed_at >= $1
        ORDER BY processed_at DESC, provider_event_id LIMIT $2`,
      values: [since, WEBHOOK_ROWS],
      maxRows: WEBHOOK_ROWS,
    });
    const webhookOutcomes = await transaction.query<StatusRow>({
      name: "postgres_admin_operations_webhook_outcomes_v1",
      text: `SELECT outcome AS status, COUNT(*) AS total FROM data.space_billing_webhook_events
        WHERE processed_at >= $1 GROUP BY outcome ORDER BY outcome LIMIT 20`,
      values: [since],
      maxRows: 20,
    });

    const paidCalls = await transaction.query<AdminPaidCallRow>({
      name: "postgres_admin_operations_paid_calls_v1",
      text: `SELECT kind, status, outcome, COUNT(*) AS calls,
          COALESCE(SUM(COALESCE(actual_units, reserved_units)), 0) AS units,
          COALESCE(SUM(COALESCE(actual_credits, reserved_credits)), 0) AS credits
        FROM data.paid_call_receipts WHERE created_at >= $1
        GROUP BY kind, status, outcome ORDER BY kind LIMIT 500`,
      values: [since],
      maxRows: 500,
    });

    const truncated: string[] = [];
    if (machines.length > bound) truncated.push("machines");
    if (subscriptions.length > bound) truncated.push("subscriptions");
    if (harnesses.length >= HARNESS_OWNER_ROWS) truncated.push("harnesses");
    return {
      machines: machines.slice(0, bound),
      machinesByStatus: statusCounts(machineStatuses),
      harnesses,
      harnessSpaces,
      activeRuns: adminCount(runTotals?.active),
      runsByStatus: statusCounts(runStatuses),
      runDays,
      automations: {
        total: adminCount(automations?.total),
        enabled: adminCount(automations?.enabled),
        withError: adminCount(automations?.with_error),
        overdue: adminCount(overdue?.overdue),
      },
      occurrencesByStatus: statusCounts(occurrences),
      outbox,
      subscriptions: subscriptions.slice(0, bound).map((row) => {
        const currentPeriodEnd = adminOptionalIso(row.current_period_end);
        const graceUntil = adminOptionalIso(row.grace_until);
        return {
          spaceId: row.space_id,
          spaceName: row.space_name ?? row.space_id,
          plan: row.plan,
          status: row.status,
          seats: row.seat_quantity,
          ...(row.billing_provider ? { provider: row.billing_provider } : {}),
          ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
          cancelAtPeriodEnd: row.cancel_at_period_end === true,
          ...(graceUntil ? { graceUntil } : {}),
          updatedAt: adminIso(row.updated_at),
        };
      }),
      webhookEvents: webhooks.map((row) => ({
        spaceId: row.space_id,
        eventType: row.event_type,
        outcome: row.outcome,
        processedAt: adminIso(row.processed_at),
      })),
      webhooksByOutcome: statusCounts(webhookOutcomes),
      paidCalls,
      truncated,
    };
  });
}

/** Agents bound to, and Runs active on, each listed Machine, from one shard. */
async function readMachineCounts(
  database: AuthorityDatabase,
  shardId: string,
  machineIds: readonly string[],
): Promise<{ agents: readonly MachineCountRow[]; runs: readonly MachineCountRow[] }> {
  if (machineIds.length === 0) return { agents: [], runs: [] };
  return database.transaction({
    requestId: `admin-operations-machines:${shardId}`.slice(0, 200),
    operation: "admin.operations.machines.read",
  }, async (transaction) => ({
    agents: await transaction.query<MachineCountRow>({
      name: "postgres_admin_operations_machine_agents_v1",
      text: `SELECT machine_id, COUNT(*) AS total FROM data.space_agent_registrations
        WHERE machine_id = ANY($1::text[]) GROUP BY machine_id LIMIT $2`,
      values: [machineIds, machineIds.length],
      maxRows: machineIds.length,
    }),
    runs: await transaction.query<MachineCountRow>({
      name: "postgres_admin_operations_machine_runs_v1",
      text: `SELECT workspace_machine_id AS machine_id, COUNT(*) AS total FROM data.runs
        WHERE workspace_machine_id = ANY($1::text[]) AND status = ANY($2::text[])
        GROUP BY workspace_machine_id LIMIT $3`,
      values: [machineIds, [...ACTIVE_RUN_STATUSES], machineIds.length],
      maxRows: machineIds.length,
    }),
  }));
}

export async function readPostgresAdminOperationsFromFleet(
  fleet: Pick<PostgresAuthorityFleet, "defaultShardId" | "physicalShards">,
  now: string,
): Promise<AdminOperations> {
  const nowDate = new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error("admin operations now is invalid");
  const parts = await Promise.all(fleet.physicalShards.map(({ shardId, database }) =>
    readShard(database, shardId, nowDate, shardId === fleet.defaultShardId)));
  const machineRows = parts.flatMap((part) => part.machines);
  const machineIds = machineRows.map((row) => row.machine_id);
  const machineCounts = await Promise.all(fleet.physicalShards.map(({ shardId, database }) =>
    readMachineCounts(database, shardId, machineIds)));
  const agentsByMachine = new Map<string, number>();
  const runsByMachine = new Map<string, number>();
  for (const shard of machineCounts) {
    for (const row of shard.agents) {
      agentsByMachine.set(row.machine_id, (agentsByMachine.get(row.machine_id) ?? 0) + adminCount(row.total));
    }
    for (const row of shard.runs) {
      runsByMachine.set(row.machine_id, (runsByMachine.get(row.machine_id) ?? 0) + adminCount(row.total));
    }
  }

  const harnesses = new Map<string, { agents: number; spaces: number; owners: Set<string> }>();
  for (const row of parts.flatMap((part) => part.harnesses)) {
    const current = harnesses.get(row.harness) ?? { agents: 0, spaces: 0, owners: new Set<string>() };
    current.agents += adminCount(row.agents);
    current.owners.add(row.owner_user_id);
    harnesses.set(row.harness, current);
  }
  // A Space lives on one shard, so per-shard distinct Spaces add up exactly.
  for (const row of parts.flatMap((part) => part.harnessSpaces)) {
    const current = harnesses.get(row.harness);
    if (current) current.spaces += adminCount(row.spaces);
  }

  const window = adminActivityUtcWindow(nowDate.getTime(), ADMIN_OPERATIONS_DAYS);
  const runDays = new Map<string, { started: number; failed: number }>();
  for (let day = new Date(window.since).getTime(); day < new Date(window.before).getTime(); day += 86_400_000) {
    runDays.set(new Date(day).toISOString().slice(0, 10), { started: 0, failed: 0 });
  }
  for (const row of parts.flatMap((part) => part.runDays)) {
    const current = runDays.get(row.day);
    if (!current) continue;
    current.started += adminCount(row.started);
    current.failed += adminCount(row.failed);
  }

  const outbox: AdminOperations["outbox"] = { byStatus: {}, maxAttempts: 0 };
  for (const row of parts.flatMap((part) => part.outbox)) {
    outbox.byStatus[row.status] = (outbox.byStatus[row.status] ?? 0) + adminCount(row.total);
    outbox.maxAttempts = Math.max(outbox.maxAttempts, adminCount(row.max_attempts));
    const oldest = adminOptionalIso(row.oldest_pending_at);
    if (oldest && (!outbox.oldestPendingAt || oldest < outbox.oldestPendingAt)) outbox.oldestPendingAt = oldest;
  }

  const merged: AdminOperations = {
    generatedAt: now,
    days: ADMIN_OPERATIONS_DAYS,
    machines: machineRows.map((row) => ({
      machineId: row.machine_id,
      ownerUserId: row.owner_user_id,
      ...(row.owner_email ? { ownerEmail: row.owner_email } : {}),
      status: row.status,
      agents: agentsByMachine.get(row.machine_id) ?? 0,
      activeRuns: runsByMachine.get(row.machine_id) ?? 0,
      enrolledAt: adminIso(row.created_at),
      lastSeenAt: adminIso(row.updated_at),
    })),
    machinesByStatus: {},
    harnesses: [...harnesses].map(([harness, value]) => ({
      harness, agents: value.agents, spaces: value.spaces, owners: value.owners.size,
    })).sort((left, right) => right.agents - left.agents || left.harness.localeCompare(right.harness)),
    runs: {
      active: 0,
      byStatus: {},
      daily: [...runDays].map(([date, value]) => ({ date, ...value })),
    },
    automations: { total: 0, enabled: 0, withError: 0, occurrencesByStatus: {}, overdue: 0 },
    outbox,
    billing: {
      subscriptions: parts.flatMap((part) => part.subscriptions)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      byStatus: {},
      webhookEvents: parts.flatMap((part) => part.webhookEvents)
        .sort((left, right) => right.processedAt.localeCompare(left.processedAt))
        .slice(0, WEBHOOK_ROWS),
      webhooksByOutcome: {},
    },
    paidCalls: adminPaidCallKinds(parts.flatMap((part) => part.paidCalls)),
    truncated: [...new Set(parts.flatMap((part) => part.truncated))],
  };
  for (const part of parts) {
    addAdminCounts(merged.machinesByStatus, part.machinesByStatus);
    merged.runs.active += part.activeRuns;
    addAdminCounts(merged.runs.byStatus, part.runsByStatus);
    merged.automations.total += part.automations.total;
    merged.automations.enabled += part.automations.enabled;
    merged.automations.withError += part.automations.withError;
    merged.automations.overdue += part.automations.overdue;
    addAdminCounts(merged.automations.occurrencesByStatus, part.occurrencesByStatus);
    addAdminCounts(merged.billing.webhooksByOutcome, part.webhooksByOutcome);
    for (const subscription of part.subscriptions) {
      merged.billing.byStatus[subscription.status] = (merged.billing.byStatus[subscription.status] ?? 0) + 1;
    }
  }
  return merged;
}

export function readPostgresAdminOperations(env: Env, now: string): Promise<AdminOperations> {
  const fleet = createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-admin-operations",
    statementTimeoutMs: 8_000,
    transactionTimeoutMs: 20_000,
    lockTimeoutMs: 2_000,
  });
  return readPostgresAdminOperationsFromFleet(fleet, now);
}
