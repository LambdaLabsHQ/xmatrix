import assert from "node:assert/strict";
import test from "node:test";

import { readPostgresAdminUserDetailFromFleet } from "../src/postgres-admin-user-detail.ts";
import { listAdminAudit, recordAdminAudit } from "../src/admin-audit.ts";

/* Columns that hold user content or private detail. No operator query may name them. */
const CONTENT_COLUMNS = [
  /\bbody\b/u, /\bmetadata_json\b/u, /\bconfiguration_json\b/u, /\bsecret_refs_json\b/u,
  /\bencrypted_value_json\b/u, /\bcapabilities_json\b/u, /\berror\b/u, /\bhostname\b/u,
  /\bip_address\b/u, /\buser_agent\b/u, /\btitle\b/u, /\btoken\b/u,
];

function assertMetadataOnly(query) {
  for (const column of CONTENT_COLUMNS) {
    assert.doesNotMatch(query.text, column, `${query.name} must not read ${column}`);
  }
}

function database(resultByQuery, seen = []) {
  return {
    cacheMode: "disabled",
    async transaction(_context, callback) {
      return callback({
        async query(query) {
          if (!Number.isSafeInteger(query.maxRows) || query.maxRows < 0 || query.maxRows > 10_000) {
            throw new Error("query.maxRows must be between 0 and 10000");
          }
          assertMetadataOnly(query);
          seen.push(query);
          if (!(query.name in resultByQuery)) throw new Error(`unexpected query ${query.name}`);
          const result = resultByQuery[query.name];
          return typeof result === "function" ? result(query) : result;
        },
      });
    },
  };
}

const NOW = "2026-09-30T12:00:00.000Z";

function shardResults(overrides = {}) {
  return {
    postgres_admin_user_spaces_v1: [],
    postgres_admin_user_agents_v1: [],
    postgres_admin_user_machines_v1: [],
    postgres_admin_user_connectors_v1: [],
    postgres_admin_user_runs_v1: [],
    postgres_admin_user_messages_v1: [{ total: 0, last_7d: 0, last_30d: 0, last_message_at: null }],
    postgres_admin_user_activity_v1: [],
    postgres_admin_user_pages_v1: [{ pages: 0 }],
    ...overrides,
  };
}

test("admin user detail merges shards, reads Machines once, and fills a 30-day series", async () => {
  const seen0 = [];
  const seen1 = [];
  const shard0 = database(shardResults({
    postgres_admin_user_spaces_v1: [{
      space_id: "space-0", name: "Zero", role: "owner", owner_user_id: "user-1",
      joined_at: "2026-08-01T00:00:00.000Z", members: 3, messages: 5,
      plan: "pro", billing_status: "active", seat_quantity: 3,
      current_period_end: "2026-10-01T00:00:00.000Z", cancel_at_period_end: false, grace_until: null,
    }],
    postgres_admin_user_machines_v1: [{
      machine_id: "machine-1", status: "online",
      created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-09-30T11:00:00.000Z",
    }],
    postgres_admin_user_runs_v1: [
      { status: "finished", runs: 4, last_30d: 2, last_run_at: "2026-09-20T00:00:00.000Z" },
      { status: "running", runs: 1, last_30d: 1, last_run_at: "2026-09-30T10:00:00.000Z" },
    ],
    postgres_admin_user_messages_v1: [{
      total: 5, last_7d: 2, last_30d: 4, last_message_at: "2026-09-29T00:00:00.000Z",
    }],
    postgres_admin_user_activity_v1: [{ day: "2026-09-29", messages: 2 }],
    postgres_admin_user_pages_v1: [{ pages: 2 }],
  }), seen0);
  const shard1 = database(shardResults({
    postgres_admin_user_spaces_v1: [{
      space_id: "space-1", name: "One", role: "member", owner_user_id: "user-2",
      joined_at: "2026-09-01T00:00:00.000Z", members: 2, messages: 1,
      plan: null, billing_status: null, seat_quantity: null,
      current_period_end: null, cancel_at_period_end: null, grace_until: null,
    }],
    postgres_admin_user_connectors_v1: [{
      space_id: "space-1", provider_id: "github", provider_name: "GitHub", status: "configured",
      created_at: "2026-09-02T00:00:00.000Z", last_checked_at: null,
    }],
    postgres_admin_user_runs_v1: [
      { status: "finished", runs: 1, last_30d: 1, last_run_at: "2026-09-25T00:00:00.000Z" },
    ],
    postgres_admin_user_messages_v1: [{
      total: 1, last_7d: 1, last_30d: 1, last_message_at: "2026-09-30T09:00:00.000Z",
    }],
    postgres_admin_user_activity_v1: [{ day: "2026-09-29", messages: 1 }],
    postgres_admin_user_pages_v1: [{ pages: 1 }],
  }), seen1);

  const detail = await readPostgresAdminUserDetailFromFleet({
    defaultShardId: "shard-0",
    physicalShards: [
      { shardId: "shard-0", database: shard0 },
      { shardId: "shard-1", database: shard1 },
    ],
  }, "user-1", NOW);

  assert.equal(seen1.some((query) => query.name === "postgres_admin_user_machines_v1"), false);
  assert.deepEqual(detail.spaces.map((space) => space.spaceId), ["space-0", "space-1"]);
  assert.deepEqual(detail.spaces[0].billing, {
    plan: "pro", status: "active", seats: 3,
    currentPeriodEnd: "2026-10-01T00:00:00.000Z", cancelAtPeriodEnd: false,
  });
  assert.equal(detail.spaces[1].billing, undefined);
  assert.equal(detail.machines.length, 1);
  assert.equal(detail.connectors[0].providerName, "GitHub");
  assert.deepEqual(detail.runs, {
    total: 6, active: 1, last30d: 4,
    byStatus: { finished: 5, running: 1 },
    lastRunAt: "2026-09-30T10:00:00.000Z",
  });
  assert.deepEqual(detail.messages, {
    total: 6, last7d: 3, last30d: 5, lastMessageAt: "2026-09-30T09:00:00.000Z",
  });
  assert.equal(detail.pagesCreated, 3);
  assert.equal(detail.activity.length, 30);
  assert.equal(detail.activity.at(-1).date, "2026-09-30");
  assert.equal(detail.activity.find((point) => point.date === "2026-09-29").messages, 3);
  assert.deepEqual(detail.truncated, []);
});

test("admin user detail skips message scans for a user in no Space and reports truncated lists", async () => {
  const many = Array.from({ length: 101 }, (_, index) => ({
    space_id: `space-${index}`, machine_id: "machine-1", harness: "claude", display_name: "claude",
    created_at: NOW, updated_at: NOW,
  }));
  const seen = [];
  const detail = await readPostgresAdminUserDetailFromFleet({
    defaultShardId: "shard-0",
    physicalShards: [{ shardId: "shard-0", database: database(shardResults({
      postgres_admin_user_agents_v1: many,
    }), seen) }],
  }, "user-1", NOW);
  assert.equal(seen.some((query) => query.name === "postgres_admin_user_messages_v1"), false);
  assert.equal(detail.agents.length, 100);
  assert.deepEqual(detail.truncated, ["agents"]);
  assert.equal(detail.messages.total, 0);
});

test("admin audit records metadata only and lists newest first", async () => {
  const inserted = [];
  const db = database({
    admin_audit_record_v1: (query) => { inserted.push(query.values); return []; },
    admin_audit_list_v1: [{
      event_id: "event-1", actor_user_id: "admin-1", actor_email: "admin@example.com",
      action: "user.read", target_kind: "user", target_id: "user-1",
      created_at: "2026-09-30T12:00:00.000Z",
    }],
  });
  await recordAdminAudit({}, {
    actorUserId: "admin-1", actorEmail: "admin@example.com", action: "user.read",
    targetKind: "user", targetId: "user-1",
  }, db);
  assert.equal(inserted.length, 1);
  assert.deepEqual(inserted[0].slice(1), ["admin-1", "admin@example.com", "user.read", "user", "user-1"]);
  assert.deepEqual(await listAdminAudit({}, 10_000, db), [{
    eventId: "event-1", actorUserId: "admin-1", actorEmail: "admin@example.com",
    action: "user.read", targetKind: "user", targetId: "user-1",
    createdAt: "2026-09-30T12:00:00.000Z",
  }]);
});
