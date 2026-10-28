import assert from "node:assert/strict";
import test from "node:test";

import { readPostgresAdminOverviewFromFleet } from "../src/postgres-admin-overview.ts";
import { withSignups } from "../src/admin-overview-merge.ts";
import { adminActivitySettledThrough } from "../src/postgres-admin-activity-rollup.ts";
import { adminQueryDatabase } from "./support/admin-query-database.mjs";

const SETTLED_THROUGH = "2026-08-29";

function database(results, { settledThrough = SETTLED_THROUGH, seen = [] } = {}) {
  const sections = {
    totals: "postgres_admin_totals_v4", spaces: "postgres_admin_spaces_v3",
    users: "postgres_admin_users_v4", user_days: "postgres_admin_user_days_v1",
    activity: "postgres_admin_activity_v3",
    storage: "postgres_admin_storage_v2", machines: "postgres_admin_machines_v3",
  };
  const overview = (query) => [{
    settled_through: results.settled_through === undefined ? settledThrough : results.settled_through,
    ...Object.fromEntries(Object.entries(sections).map(([section, name]) => [
      section, typeof results[name] === "function" ? results[name](query) : results[name] ?? [],
    ])),
  }];
  return adminQueryDatabase({
    postgres_admin_overview_state_v1: [{ settled_through: settledThrough }],
    postgres_admin_overview_v2: overview,
    postgres_admin_overview_unrolled_v1: overview,
  }, (query) => seen.push(query));
}

function readTwoShards(shard0, shard1) {
  return readPostgresAdminOverviewFromFleet({
    defaultShardId: "shard-0",
    physicalShards: [
      { shardId: "shard-0", database: shard0 },
      { shardId: "shard-1", database: shard1 },
    ],
  }, { now: "2026-08-31T03:00:00.000Z", spaceLimit: 20, userLimit: 20, activityDays: 14 });
}

const ZERO_ACTIVITY = {
  ownMessages: 0, activeSpaces: 0, runsStarted: 0,
  activeUsers: 0, activeUsers7d: 0, activeUsers30d: 0,
};

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

  const overview = await readTwoShards(shard0, shard1);

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
    date: "2026-08-30", messages: 2, humanMessages: 2, agentMessages: 0, ...ZERO_ACTIVITY,
  }, {
    date: "2026-08-31", messages: 1, humanMessages: 1, agentMessages: 0, ...ZERO_ACTIVITY,
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

  assert.equal(activityQuery.values[1], "2026-08-31");
  assert.deepEqual(activityQuery.values.slice(3, 5), ["2026-08-18", "2026-08-31"]);
  assert.equal(activityQuery.maxRows, 1);
  assert.match(activityQuery.text, /generate_series/u);
  assert.match(activityQuery.text, /LEFT JOIN daily_counts/u);
  assert.match(activityQuery.text, /day >= \$4::date AND day <= \$5::date/u);
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

  const query = observed.get("postgres_admin_overview_v2");
  assert.equal(query.maxRows, 1);
  assert.match(query.text, /COUNT\(\*\) OVER \(\) AS total_count/u);
  assert.match(query.text, /LIMIT 10000/u);
  assert.match(query.text, /LIMIT 1001/u);
  assert.match(query.text, /WHERE \$6::boolean/u);
  assert.match(query.text, /AS MATERIALIZED/u);
  assert.equal(query.values[5], true);
  assert.equal(query.values[2], 21);
  assert.equal(query.values[6], "2026-08-30T00:00:00.000Z", "live messages start the day after the settled one");
  assert.match(query.text, /FROM data\.admin_activity_days WHERE day <= \(SELECT settled_through/u);
  assert.match(query.text, /message\.sent_at >= \$7 AND message\.sent_at >= \(\(SELECT settled_through/u);
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
    [{ postgres_admin_user_days_v1: [{ user_id: "u", days: [1], total_count: 10001 }] }, /active-user bound/],
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

test("a shard reads every message until its first roll-up", async () => {
  const seen = [];
  await readPostgresAdminOverviewFromFleet({
    defaultShardId: "shard-0",
    physicalShards: [{ shardId: "shard-0", database: database({ postgres_admin_totals_v4: totals() },
      { settledThrough: null, seen }) }],
  }, { now: "2026-08-31T03:00:00.000Z", spaceLimit: 20, userLimit: 20, activityDays: 14 });

  const query = seen.find((entry) => entry.name === "postgres_admin_overview_unrolled_v1");
  assert.ok(query, "the unrolled aggregate is read");
  assert.equal(query.values.length, 6);
  assert.doesNotMatch(query.text, /admin_activity_days/u);
  assert.equal(seen.some((entry) => entry.name === "postgres_admin_overview_v2"), false);
});

test("roll-up state missing from the aggregate's snapshot fails the read", async () => {
  await assert.rejects(readPostgresAdminOverviewFromFleet({
    defaultShardId: "shard-0",
    physicalShards: [{ shardId: "shard-0", database: database({
      postgres_admin_totals_v4: totals(), settled_through: null,
    }) }],
  }, { now: "2026-08-31T03:00:00.000Z", spaceLimit: 20, userLimit: 20, activityDays: 14 }),
  /state disappeared/u);
});

test("a day settles two days after it began", () => {
  assert.equal(adminActivitySettledThrough(Date.parse("2026-08-31T00:00:00.000Z")), "2026-08-29");
  assert.equal(adminActivitySettledThrough(Date.parse("2026-08-31T23:59:59.999Z")), "2026-08-29");
  assert.equal(adminActivitySettledThrough(Date.parse("2026-09-01T00:00:00.000Z")), "2026-08-30");
});

test("active people are counted once across shards over 1, 7 and 30 days", async () => {
  const day = (date) => Math.round(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000);
  const activity = (query) => Array.from({ length: 14 }, (_, offset) => ({
    day: new Date(Date.UTC(2026, 7, 18 + offset)).toISOString().slice(0, 10),
    messages: 0, human_messages: 0, agent_messages: 0,
  }));
  const shard0 = database({
    postgres_admin_totals_v4: totals(),
    postgres_admin_users_v4: [{ user_id: "both", spaces: 1, owned_spaces: 1, agent_registrations: 0,
      messages: 2, first_seen_at: "2026-07-01T00:00:00.000Z", last_message_at: null }],
    // Active before the series starts: still inside the 7- and 30-day windows.
    postgres_admin_user_days_v1: [{ user_id: "both", days: [day("2026-08-12"), day("2026-08-30")] }],
    postgres_admin_activity_v3: activity,
  });
  const shard1 = database({
    postgres_admin_totals_v4: totals(),
    postgres_admin_user_days_v1: [
      { user_id: "both", days: [day("2026-08-30")] },
      { user_id: "left-every-space", days: [day("2026-08-31")] },
    ],
    postgres_admin_activity_v3: activity,
  });

  const overview = await readTwoShards(shard0, shard1);

  const point = (date) => overview.activity.find((entry) => entry.date === date);
  assert.deepEqual([point("2026-08-18").activeUsers, point("2026-08-18").activeUsers7d,
    point("2026-08-18").activeUsers30d], [0, 1, 1]);
  assert.deepEqual([point("2026-08-19").activeUsers7d, point("2026-08-19").activeUsers30d], [0, 1]);
  assert.deepEqual([point("2026-08-30").activeUsers, point("2026-08-30").activeUsers7d], [1, 1]);
  assert.deepEqual([point("2026-08-31").activeUsers, point("2026-08-31").activeUsers7d,
    point("2026-08-31").activeUsers30d], [1, 2, 2]);
  const both = overview.users.find((user) => user.userId === "both");
  assert.deepEqual(both.activeDays, [day("2026-08-30")], "only days inside the series are listed");
  const left = overview.users.find((user) => user.userId === "left-every-space");
  assert.deepEqual(left, { userId: "left-every-space", spaces: 0, ownedSpaces: 0, agentRegistrations: 0,
    machines: 0, messages: 0, activeDays: [day("2026-08-31")] });
  assert.equal(overview.totals.users, 2);
});

test("signups come from a complete registered-user inventory only", () => {
  const base = {
    generatedAt: "2026-08-31T03:00:00.000Z", activityDays: 2, totals: {}, spaces: [], storage: [],
    activity: [{ date: "2026-08-30", messages: 0, humanMessages: 0, agentMessages: 0 },
      { date: "2026-08-31", messages: 0, humanMessages: 0, agentMessages: 0 }],
    users: [{ userId: "a", registeredAt: "2026-08-30T23:59:00.000Z" },
      { userId: "b", registeredAt: "2026-08-31T00:01:00.000Z" }, { userId: "c" }],
    userAccess: { registeredUsers: 3 },
    truncated: { spaces: false, users: false },
  };
  assert.deepEqual(withSignups(base).activity.map((point) => point.signups), [1, 1]);
  assert.equal(withSignups({ ...base, truncated: { spaces: false, users: true } }).activity[0].signups, undefined);
  assert.equal(withSignups({ ...base, userAccess: undefined }).activity[0].signups, undefined);
});
