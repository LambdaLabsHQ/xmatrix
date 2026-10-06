import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { registerMachineRetirementRoutes } from "../src/index-routes-machine-retirement.ts";

const ENV = { RELAY_POSTGRES: { connectionString: "postgres://unused" }, RELAY_POSTGRES_SHARD_ID: "shard" };
const retiredAt = "2026-10-02T07:00:00.000Z";

function route(user, rows = {}, wake = async () => 2) {
  const queries = [], woken = [], app = new Hono();
  registerMachineRetirementRoutes(app, {
    authenticate: async () => user,
    database: { cacheMode: "disabled", transaction: async (_context, callback) => callback({
      query: async query => { queries.push(query); return rows[query.name] ?? []; } }) },
    wakeRegistrationChannels: async (_env, _database, scope) => { woken.push(scope); return wake(); },
  });
  return { queries, woken, request: (method, path) => app.request(path, { method }, ENV) };
}

test("retiring a Machine retires only the owner's, then wakes its Channels to stop its Runs", async () => {
  const owner = route({ id: "owner" }, { machine_retire_v1: [{ retired_at: new Date(retiredAt) }] });
  const retired = await owner.request("DELETE", "/api/machines/machine%3Aa");
  assert.equal(retired.status, 200);
  assert.equal(retired.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await retired.json(), { machineId: "machine:a", retiredAt, stoppingChannels: 2 });
  assert.deepEqual(owner.queries.find(query => query.name === "machine_retire_v1").values, ["owner", "machine:a"]);
  assert.deepEqual(owner.woken, [{ ownerUserId: "owner", machineId: "machine:a" }]);

  // Another owner's Machine is not found and nothing is woken.
  const intruder = route({ id: "intruder" });
  const missing = await intruder.request("DELETE", "/api/machines/machine%3Aa");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "machine_not_found");
  assert.deepEqual(intruder.woken, []);

  // A Channel that could not be told fails the request so its retry tells it again.
  const unwoken = route({ id: "owner" }, { machine_retire_v1: [{ retired_at: new Date(retiredAt) }] },
    async () => { throw new Error("A Channel affected by this authority change could not be told"); });
  assert.equal((await unwoken.request("DELETE", "/api/machines/machine%3Aa")).status, 500);
});

test("rejoining brings back the owner's Machine", async () => {
  const owner = route({ id: "owner" }, { machine_rejoin_v1: [{ machine_id: "machine:a" }] });
  const rejoined = await owner.request("POST", "/api/machines/machine%3Aa/rejoin");
  assert.deepEqual(await rejoined.json(), { machineId: "machine:a", rejoined: true });
  assert.deepEqual(owner.woken, []);
});

test("an Agent run can neither remove nor rejoin a Machine", async () => {
  for (const [method, path] of [["DELETE", "/api/machines/machine%3Aa"], ["POST", "/api/machines/machine%3Aa/rejoin"]]) {
    const agent = route({ id: "owner", agentRun: { runId: "run" } });
    assert.equal((await agent.request(method, path)).status, 403);
    assert.deepEqual(agent.queries, []);
  }
});
