import assert from "node:assert/strict";
import test from "node:test";

import { readPostgresAdminOperationsFromFleet } from "../src/postgres-admin-operations.ts";
import { readPostgresAdminSpaceDetailFromFleet } from "../src/postgres-admin-space-detail.ts";
import { ADMIN_CONTENT_COLUMNS, adminQueryDatabase } from "./support/admin-query-database.mjs";

/* Beyond the shared content columns: payloads, provider ids, digests, and error text. */
const CONTENT_COLUMNS = [
  ...ADMIN_CONTENT_COLUMNS, /\berror_message\b/u, /\bpayload_json\b/u, /\bpayload_digest\b/u,
  /\bprovider_customer_id\b/u, /\bprovider_subscription_id\b/u, /\btoken_hash\b/u, /\bscopes_json\b/u,
  /\brequest_digest\b/u, /\ballocation_json\b/u, /\bnotice_json\b/u, /\blast_error\b(?! IS NOT NULL)/u,
  /\bdisplay_name FROM data\.machine_daemons/u,
];

function database(resultByQuery, seen = []) {
  return adminQueryDatabase(resultByQuery, (query) => {
    for (const column of CONTENT_COLUMNS) {
      assert.doesNotMatch(query.text, column, `${query.name} must not read ${column}`);
    }
    seen.push(query.name);
  });
}

const NOW = "2026-09-30T12:00:00.000Z";

function operationsResults(overrides = {}) {
  return {
    postgres_admin_operations_machines_v1: [],
    postgres_admin_operations_machine_statuses_v1: [],
    postgres_admin_operations_harnesses_v1: [],
    postgres_admin_operations_harness_spaces_v1: [],
    postgres_admin_operations_active_runs_v1: [{ active: 0 }],
    postgres_admin_operations_run_statuses_v1: [],
    postgres_admin_operations_run_days_v1: [],
    postgres_admin_operations_automations_v1: [{ total: 0, enabled: 0, with_error: 0 }],
    postgres_admin_operations_occurrences_v1: [],
    postgres_admin_operations_overdue_v1: [{ overdue: 0 }],
    postgres_admin_operations_outbox_v1: [],
    postgres_admin_operations_subscriptions_v1: [],
    postgres_admin_operations_webhooks_v1: [],
    postgres_admin_operations_webhook_outcomes_v1: [],
    postgres_admin_operations_paid_calls_v1: [],
    postgres_admin_operations_machine_agents_v1: [],
    postgres_admin_operations_machine_runs_v1: [],
    ...overrides,
  };
}

test("admin operations merge shards, read Machines once, and count per-Machine work everywhere", async () => {
  const seen1 = [];
  const shard0 = database(operationsResults({
    postgres_admin_operations_machines_v1: [{
      machine_id: "machine-1", owner_user_id: "user-1", owner_email: "one@example.com", status: "online",
      created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-09-30T11:00:00.000Z",
    }],
    postgres_admin_operations_machine_statuses_v1: [{ status: "online", total: 1 }],
    postgres_admin_operations_harnesses_v1: [{ harness: "claude", owner_user_id: "user-1", agents: 2 }],
    postgres_admin_operations_harness_spaces_v1: [{ harness: "claude", spaces: 1 }],
    postgres_admin_operations_active_runs_v1: [{ active: 1 }],
    postgres_admin_operations_run_statuses_v1: [{ status: "failed", total: 1 }, { status: "running", total: 1 }],
    postgres_admin_operations_run_days_v1: [{ day: "2026-09-30", started: 2, failed: 1 }],
    postgres_admin_operations_outbox_v1: [
      { status: "pending", total: 3, oldest_pending_at: "2026-09-30T10:00:00.000Z", max_attempts: 2 },
      { status: "delivered", total: 9, oldest_pending_at: null, max_attempts: null },
    ],
    postgres_admin_operations_paid_calls_v1: [
      { kind: "jev", status: "settled", outcome: "ok", calls: 3, units: 30, credits: 300 },
      { kind: "jev", status: "reserved", outcome: null, calls: 1, units: 10, credits: 100 },
    ],
    postgres_admin_operations_machine_agents_v1: [{ machine_id: "machine-1", total: 2 }],
    postgres_admin_operations_machine_runs_v1: [{ machine_id: "machine-1", total: 1 }],
  }));
  const shard1 = database(operationsResults({
    postgres_admin_operations_harnesses_v1: [
      { harness: "claude", owner_user_id: "user-1", agents: 1 },
      { harness: "codex", owner_user_id: "user-2", agents: 1 },
    ],
    postgres_admin_operations_harness_spaces_v1: [{ harness: "claude", spaces: 1 }, { harness: "codex", spaces: 1 }],
    postgres_admin_operations_run_statuses_v1: [{ status: "failed", total: 2 }],
    postgres_admin_operations_outbox_v1: [
      { status: "pending", total: 1, oldest_pending_at: "2026-09-30T09:00:00.000Z", max_attempts: 5 },
    ],
    postgres_admin_operations_subscriptions_v1: [{
      space_id: "space-1", space_name: "One", plan: "pro", status: "past_due", seat_quantity: 3,
      billing_provider: "stripe", current_period_end: null, cancel_at_period_end: false,
      grace_until: "2026-10-03T00:00:00.000Z", updated_at: "2026-09-29T00:00:00.000Z",
    }],
    postgres_admin_operations_paid_calls_v1: [
      { kind: "jev", status: "settled", outcome: "rejected", calls: 1, units: 0, credits: 0 },
    ],
    postgres_admin_operations_machine_agents_v1: [{ machine_id: "machine-1", total: 1 }],
  }), seen1);

  const operations = await readPostgresAdminOperationsFromFleet({
    defaultShardId: "shard-0",
    physicalShards: [{ shardId: "shard-0", database: shard0 }, { shardId: "shard-1", database: shard1 }],
  }, NOW);

  assert.equal(seen1.includes("postgres_admin_operations_machines_v1"), false, "Machines are read once");
  assert.deepEqual(operations.machines.map(({ machineId, agents, activeRuns }) => ({ machineId, agents, activeRuns })),
    [{ machineId: "machine-1", agents: 3, activeRuns: 1 }]);
  assert.deepEqual(operations.harnesses, [
    { harness: "claude", agents: 3, spaces: 2, owners: 1 },
    { harness: "codex", agents: 1, spaces: 1, owners: 1 },
  ]);
  assert.deepEqual(operations.runs.byStatus, { failed: 3, running: 1 });
  assert.equal(operations.runs.daily.length, 30);
  assert.deepEqual(operations.runs.daily.at(-1), { date: "2026-09-30", started: 2, failed: 1 });
  assert.deepEqual(operations.outbox, {
    byStatus: { pending: 4, delivered: 9 }, oldestPendingAt: "2026-09-30T09:00:00.000Z", maxAttempts: 5,
  });
  assert.deepEqual(operations.billing.byStatus, { past_due: 1 });
  assert.equal(operations.billing.subscriptions[0].provider, "stripe");
  assert.deepEqual(operations.paidCalls, [{
    kind: "jev", calls: 5, byOutcome: { ok: 3, reserved: 1, rejected: 1 }, units: 40, credits: 400,
  }]);
  assert.deepEqual(operations.truncated, []);
});

function spaceResults(overrides = {}) {
  return {
    postgres_admin_space_v1: [],
    postgres_admin_space_totals_v1: [{
      members: 2, channels: 3, agents: 1, pages: 4, storage_logical_bytes: 1024, active_invites: 1,
      pending_join_requests: 0, free_messages: 7, messages: 10, messages_last_7d: 4, messages_last_30d: 8,
      human_messages: 6, agent_messages: 4, last_message_at: "2026-09-30T10:00:00.000Z",
    }],
    postgres_admin_space_members_v1: [
      { user_id: "user-1", email: "one@example.com", role: "owner", created_at: "2026-08-01T00:00:00.000Z", messages: 5 },
      { user_id: "user-2", email: null, role: "member", created_at: "2026-08-02T00:00:00.000Z", messages: 1 },
    ],
    postgres_admin_space_agents_v1: [],
    postgres_admin_space_connectors_v1: [],
    postgres_admin_space_automations_v1: [{ total: 2, enabled: 1, with_error: 1, run_count: 9, last_run_at: null }],
    postgres_admin_space_occurrences_v1: [{ status: "dispatched", total: 4 }, { status: "failed", total: 1 }],
    postgres_admin_space_runs_v1: [{ status: "completed", total: 3, last_at: "2026-09-29T00:00:00.000Z" }],
    postgres_admin_space_billing_v1: [],
    postgres_admin_space_webhooks_v1: [],
    postgres_admin_space_paid_calls_v1: [],
    postgres_admin_space_storage_v1: [],
    postgres_admin_space_activity_v1: [{ day: "2026-09-30", messages: 3, human_messages: 2, agent_messages: 1 }],
    ...overrides,
  };
}

test("admin Space detail answers from the shard that holds the Space, metadata only", async () => {
  const empty = database({ postgres_admin_space_v1: [] });
  const holder = database(spaceResults({
    postgres_admin_space_v1: [{
      space_id: "space-1", name: "One", owner_user_id: "user-1", created_at: "2026-08-01T00:00:00.000Z",
    }],
  }));
  const detail = await readPostgresAdminSpaceDetailFromFleet({
    physicalShards: [{ shardId: "shard-0", database: empty }, { shardId: "shard-1", database: holder }],
  }, "space-1", NOW);

  assert.equal(detail.space.name, "One");
  assert.equal(detail.space.ownerEmail, "one@example.com");
  assert.equal(detail.totals.storageLogicalBytes, 1024);
  assert.equal(detail.freeMessages, 7);
  assert.deepEqual(detail.members[1], { userId: "user-2", role: "member", joinedAt: "2026-08-02T00:00:00.000Z", messages: 1 });
  assert.deepEqual(detail.automations.occurrencesByStatus, { dispatched: 4, failed: 1 });
  assert.equal(detail.automations.withError, 1);
  assert.deepEqual(detail.runs, { total: 3, byStatus: { completed: 3 }, lastRunAt: "2026-09-29T00:00:00.000Z" });
  assert.equal(detail.billing, undefined);
  assert.equal(detail.activity.length, 30);
  assert.deepEqual(detail.activity.at(-1), { date: "2026-09-30", messages: 3, humanMessages: 2, agentMessages: 1 });

  assert.equal(await readPostgresAdminSpaceDetailFromFleet({
    physicalShards: [{ shardId: "shard-0", database: empty }],
  }, "absent", NOW), null);
});
