import assert from "node:assert/strict";
import test from "node:test";

import { readPostgresAdminOverviewFromFleet } from "../src/postgres-admin-overview.ts";
import { adminQueryDatabase } from "./support/admin-query-database.mjs";

function database(results) {
  const sections = {
    totals: "postgres_admin_totals_v4", spaces: "postgres_admin_spaces_v3",
    users: "postgres_admin_users_v4", activity: "postgres_admin_activity_v3",
    storage: "postgres_admin_storage_v2", machines: "postgres_admin_machines_v3",
  };
  return adminQueryDatabase({ postgres_admin_overview_v1(query) {
    return [Object.fromEntries(Object.entries(sections).map(([section, name]) => [
      section, typeof results[name] === "function" ? results[name](query) : results[name] ?? [],
    ]))];
  } });
}

function totals(overrides = {}) {
  return [{
    spaces: 0,
    channels: 0, active_channels: 0,
    messages: 0, messages_last_24h: 0, messages_last_7d: 0,
    human_messages: 0, agent_messages: 0, agent_registrations: 0,
    runs: 0, active_runs: 0, agent_instances: 0,
    automations: 0, enabled_automations: 0, storage_logical_bytes: 0,
    ...overrides,
  }];
}

test("PostgreSQL admin overview merges placed facts and reads global Machines once", async () => {
  const shard0 = database({
    postgres_admin_totals_v4: totals({
      spaces: 1, channels: 1, active_channels: 1,
      messages: 1, messages_last_24h: 1, messages_last_7d: 1,
      human_messages: 1, runs: 1, active_runs: 1, agent_instances: 1,
      storage_logical_bytes: 100,
    }),
    postgres_admin_spaces_v3: [{
      id: "space-0", name: "Zero", owner_user_id: "user-1",
      members: 1, channels: 1, active_channels: 1, agent_registrations: 0,
      messages: 1, messages_last_7d: 1, created_at: "2026-08-30T00:00:00.000Z",
      last_message_at: "2026-08-30T02:00:00.000Z",
    }],
    postgres_admin_users_v4: [{
      user_id: "user-1", email: null, spaces: 1, owned_spaces: 1,
      agent_registrations: 0, messages: 1, first_seen_at: "2026-08-29T00:00:00.000Z",
      last_message_at: "2026-08-30T02:00:00.000Z",
    }],
    postgres_admin_activity_v3: [{
      day: "2026-08-30", messages: 1, human_messages: 1, agent_messages: 0,
    }],
    postgres_admin_storage_v2: [{
      category: "messages", rows: 1, logical_bytes: 100,
      updated_at: "2026-08-30T02:00:00.000Z",
    }],
    postgres_admin_machines_v3: [{
      owner_user_id: "user-2", email: "two-machine@example.com", machines: 1, online_machines: 1,
    }, {
      owner_user_id: "machine-only", email: "machine-only@example.com", machines: 2,
      online_machines: 0,
    }],
  });
  const shard1 = database({
    postgres_admin_totals_v4: totals({
      spaces: 1, channels: 1, active_channels: 1,
      messages: 2, messages_last_24h: 1, messages_last_7d: 2,
      human_messages: 2, agent_registrations: 1, automations: 1,
      enabled_automations: 1, storage_logical_bytes: 250,
    }),
    postgres_admin_spaces_v3: [{
      id: "space-1", name: "One", owner_user_id: "user-1",
      members: 2, channels: 1, active_channels: 1, agent_registrations: 1,
      messages: 2, messages_last_7d: 2, created_at: "2026-08-31T00:00:00.000Z",
      last_message_at: "2026-08-31T02:00:00.000Z",
    }],
    postgres_admin_users_v4: [{
      user_id: "user-1", email: null, spaces: 1, owned_spaces: 1,
      agent_registrations: 1, messages: 1, first_seen_at: "2026-08-30T00:00:00.000Z",
      last_message_at: "2026-08-31T01:00:00.000Z",
    }, {
      user_id: "user-2", email: "two@example.com", spaces: 1, owned_spaces: 0,
      agent_registrations: 0, messages: 1, first_seen_at: "2026-08-31T00:00:00.000Z",
      last_message_at: "2026-08-31T02:00:00.000Z",
    }],
    postgres_admin_activity_v3: [{
      day: "2026-08-30", messages: 1, human_messages: 1, agent_messages: 0,
    }, {
      day: "2026-08-31", messages: 1, human_messages: 1, agent_messages: 0,
    }],
    postgres_admin_storage_v2: [{
      category: "messages", rows: 2, logical_bytes: 250,
      updated_at: "2026-08-31T02:00:00.000Z",
    }],
  });

  const overview = await readPostgresAdminOverviewFromFleet({
    defaultShardId: "shard-0",
    physicalShards: [
      { shardId: "shard-0", database: shard0 },
      { shardId: "shard-1", database: shard1 },
    ],
  }, { now: "2026-08-31T03:00:00.000Z", spaceLimit: 20, userLimit: 20, activityDays: 14 });

  assert.equal(overview.totals.users, 2);
  assert.equal(overview.totals.spaces, 2);
  assert.equal(overview.totals.messages, 3);
  assert.equal(overview.totals.machines, 3);
  assert.equal(overview.totals.onlineMachines, 1);
  assert.equal(overview.totals.storageLogicalBytes, 350);
  assert.deepEqual(overview.spaces.map((space) => space.id), ["space-1", "space-0"]);
  assert.deepEqual(overview.users[0], {
    userId: "user-1", spaces: 2, ownedSpaces: 2,
    agentRegistrations: 1, machines: 0, messages: 2,
    firstSeenAt: "2026-08-29T00:00:00.000Z",
    lastMessageAt: "2026-08-31T01:00:00.000Z",
  });
  assert.equal(overview.users[1].email, "two@example.com");
  assert.equal(overview.users[1].machines, 1);
  assert.equal(overview.users.some((user) => user.userId === "machine-only"), false);
  assert.deepEqual(overview.activity, [{
    date: "2026-08-30", messages: 2, humanMessages: 2, agentMessages: 0,
  }, {
    date: "2026-08-31", messages: 1, humanMessages: 1, agentMessages: 0,
  }]);
  assert.deepEqual(overview.storage, [{
    category: "messages", rows: 3, logicalBytes: 350,
    updatedAt: "2026-08-31T02:00:00.000Z",
  }]);
});

test("PostgreSQL admin activity uses exactly the requested UTC calendar days", async () => {
  let activityQuery;
  const resultByQuery = {
    postgres_admin_totals_v4: totals(),
    postgres_admin_spaces_v3: [],
    postgres_admin_users_v4: [],
    postgres_admin_activity_v3(query) {
      activityQuery = query;
      return Array.from({ length: 14 }, (_, offset) => ({
        day: new Date(Date.UTC(2026, 7, 18 + offset)).toISOString().slice(0, 10),
        messages: 1,
        human_messages: 1,
        agent_messages: 0,
      }));
    },
    postgres_admin_storage_v2: [],
    postgres_admin_machines_v3: [],
  };

  const overview = await readPostgresAdminOverviewFromFleet({
    defaultShardId: "shard-0",
    physicalShards: [{ shardId: "shard-0", database: database(resultByQuery) }],
  }, { now: "2026-08-31T03:00:00.000Z", spaceLimit: 20, userLimit: 20, activityDays: 14 });

  assert.deepEqual(activityQuery.values.slice(3, 5), [
    "2026-08-18T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z",
  ]);
  assert.equal(activityQuery.maxRows, 1);
  assert.match(activityQuery.text, /generate_series/u);
  assert.match(activityQuery.text, /LEFT JOIN daily_counts/u);
  assert.match(activityQuery.text, /created_at >= \$4 AND created_at < \$5/u);
  assert.equal(overview.activity.length, 14);
  assert.equal(overview.activity[0].date, "2026-08-18");
  assert.equal(overview.activity.at(-1).date, "2026-08-31");
});

test("PostgreSQL admin complete inventories reserve one overflow sentinel row", async () => {
  const observed = new Map();
  const inspect = (query) => {
    observed.set(query.name, query);
    return [];
  };
  await readPostgresAdminOverviewFromFleet({
    defaultShardId: "shard-0",
    physicalShards: [{ shardId: "shard-0", database: database({
      postgres_admin_totals_v4: totals(),
      postgres_admin_spaces_v3: [],
      postgres_admin_users_v4: inspect,
      postgres_admin_activity_v3: [],
      postgres_admin_storage_v2: inspect,
      postgres_admin_machines_v3: inspect,
    }) }],
  }, { now: "2026-08-31T03:00:00.000Z", spaceLimit: 20, userLimit: 20, activityDays: 14 });

  const query = observed.get("postgres_admin_overview_v1");
  assert.equal(query.maxRows, 1);
  assert.match(query.text, /COUNT\(\*\) OVER \(\) AS total_count/u);
  assert.match(query.text, /LIMIT 10000/u);
  assert.match(query.text, /LIMIT 1001/u);
  assert.match(query.text, /WHERE \$6::boolean/u);
  assert.match(query.text, /AS MATERIALIZED/u);
  assert.equal(query.text.match(/FROM data\.messages\b/gu).length, 1);
  assert.equal(query.values[5], true);
  assert.equal(query.values[2], 21);
  assert.doesNotMatch(query.text, /\b(body|metadata_json|content|preview)\b/u);

});

test("PostgreSQL admin complete inventories reject a proven overflow", async () => {
  await assert.rejects(readPostgresAdminOverviewFromFleet({
    defaultShardId: "shard-0",
    physicalShards: [{ shardId: "shard-0", database: database({
      postgres_admin_totals_v4: totals(),
      postgres_admin_spaces_v3: [],
      postgres_admin_users_v4: [{ total_count: 10_001 }],
    }) }],
  }, { now: "2026-08-31T03:00:00.000Z", spaceLimit: 20, userLimit: 20, activityDays: 14 }),
  /user bound was reached/u);
});

test("JSON-envelope inventories fail closed on nested overflow or invalid counts", async () => {
  const input = { now: "2026-08-31T03:00:00.000Z", spaceLimit: 20, userLimit: 20, activityDays: 14 };
  for (const [overrides, expected] of [
    [{ postgres_admin_spaces_v3: Array(22).fill({}) }, /result bound/],
    [{ postgres_admin_activity_v3: Array(15).fill({}) }, /result bound/],
    [{ postgres_admin_storage_v2: Array(1001).fill({}) }, /storage-category bound/],
    [{ postgres_admin_machines_v3: [{ total_count: 10001 }] }, /machine-owner bound/],
    [{ postgres_admin_totals_v4: totals({ messages: Number.MAX_SAFE_INTEGER + 1 }) }, /invalid count/],
  ]) {
    await assert.rejects(readPostgresAdminOverviewFromFleet({
      defaultShardId: "shard-0",
      physicalShards: [{ shardId: "shard-0", database: database({
        postgres_admin_totals_v4: totals(), ...overrides,
      }) }],
    }, input), expected);
  }
});
