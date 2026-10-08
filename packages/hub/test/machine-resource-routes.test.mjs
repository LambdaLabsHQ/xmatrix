import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { maintainMachineResourceHistoryOnSchedule, registerMachineResourceRoutes } from "../src/index-routes-machine-resources.ts";

const ENV = { RELAY_POSTGRES: { connectionString: "postgres://unused" }, RELAY_POSTGRES_SHARD_ID: "shard" };
const NOW = Date.parse("2026-10-07T12:30:00Z");

/** Answers each named query from `rows` and records it. */
function database(rows = {}, queries = []) {
  const transaction = { query: async (query) => (queries.push(query), rows[query.name] ?? []) };
  return { cacheMode: "disabled", transaction: (_context, callback) => callback(transaction) };
}

function route(user, rows) {
  const app = new Hono(), queries = [];
  registerMachineResourceRoutes(app, { now: () => NOW, database: database(rows, queries), authenticate: async () => user });
  const request = (query = "") => app.request(`/api/machines/machine%3Aa/resource-history${query}`, {}, ENV);
  return { queries, request };
}

test("load history is read for the authenticated owner's Machine at the range's resolution", async () => {
  const owner = route({ id: "owner" }, {
    machine_resource_history_owner_v1: [{ "?column?": 1 }],
    machine_resource_history_minutes_v1: [{ at: "2026-10-07T12:20:00Z", cpu: 42.04, load: null, memory: 61.25, disk: 40 }],
  });
  const response = await owner.request("?range=1h");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { machineId: "machine:a", range: "1h", resolution: "minute",
    from: "2026-10-07T11:30:00.000Z", to: "2026-10-07T12:30:00.000Z",
    points: [{ at: "2026-10-07T12:20:00.000Z", cpuPercent: 42, memoryPercent: 61.3, diskPercent: 40, loadAverage1m: null }] });
  assert.deepEqual(owner.queries[0].values, ["owner", "machine:a"]);
  assert.deepEqual(owner.queries[1].values.slice(0, 2), ["owner", "machine:a"]);

  const long = route({ id: "owner" }, { machine_resource_history_owner_v1: [{}] });
  assert.equal((await (await long.request("?range=30d")).json()).resolution, "hour");
  assert.equal(long.queries[1].name, "machine_resource_history_hours_v1");
});

test("load history refuses Agent Runs, other owners' Machines and unknown ranges", async () => {
  const agent = route({ id: "owner", agentRun: { ownerUserId: "owner" } }, {});
  assert.equal((await agent.request()).status, 403);
  assert.equal(agent.queries.length, 0);

  const stranger = route({ id: "stranger" }, {});
  const missing = await stranger.request("?range=24h");
  assert.equal(missing.status, 404);
  assert.equal(stranger.queries.length, 1, "nothing is read past the ownership check");

  const owner = route({ id: "owner" }, { machine_resource_history_owner_v1: [{}] });
  const invalid = await owner.request("?range=1y");
  assert.equal(invalid.status, 400);
  assert.equal(owner.queries.length, 0);
});

test("scheduled maintenance runs once an hour, at its minute", async () => {
  const queries = [];
  await maintainMachineResourceHistoryOnSchedule(ENV, Date.parse("2026-10-07T12:06:00Z"), database({}, queries));
  assert.equal(queries.length, 0);
  await maintainMachineResourceHistoryOnSchedule(ENV, Date.parse("2026-10-07T12:07:00Z"), database({}, queries));
  assert.deepEqual(queries.map(query => query.name), ["machine_resource_history_rollup_v2",
    "machine_resource_history_prune_samples_v2", "machine_resource_history_prune_hours_v2"]);
  // The Hub's database client refuses a query that may answer more than 10000 rows.
  assert.ok(queries.every(query => query.maxRows >= 0 && query.maxRows <= 10_000));
  assert.equal(queries[0].values[0], "2026-10-07T12:07:00.000Z");
});
