import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { registerMachineNameRoutes } from "../src/index-routes-machine-name.ts";
import { adoptLegacyMachineIds } from "@xmatrix/db";
import { stableMachineDaemonId } from "@xmatrix/protocol";
import { machineDaemonCommand } from "../src/machines.ts";

const ENV = { RELAY_POSTGRES: { connectionString: "postgres://unused" }, RELAY_POSTGRES_SHARD_ID: "shard" };

function database(rows = {}, queries = []) {
  return { cacheMode: "disabled", transaction: async (_context, callback) => callback({
    query: async (query) => { queries.push(query); return rows[query.name] ?? []; } }) };
}

function route(user, rows) {
  const queries = [], app = new Hono();
  registerMachineNameRoutes(app, { authenticate: async () => user, database: database(rows, queries) });
  return { queries, request: (body, method = "PUT", machineId = "machine%3Aa") => app.request(
    `/api/machines/${machineId}/name`, { method, headers: { "content-type": "application/json" }, body }, ENV) };
}

const derived = `machine:${"b".repeat(64)}`;

test("creation and name lookup use the authenticated owner and refuse Agent tokens", async () => {
  const owner = route({ id: "owner" }, { machine_name_set_v1: [{ name: "Studio" }] });
  const created = await owner.request(JSON.stringify({ name: " Studio ", ownerUserId: "other" }), "POST",
    encodeURIComponent(derived));
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { machineId: derived, name: "Studio" });
  assert.deepEqual(owner.queries.find(query => query.name === "machine_name_set_v1").values, ["owner", derived, "Studio"]);
  const read = await owner.request(undefined, "GET", encodeURIComponent(derived));
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { machineId: derived, name: null });
  assert.deepEqual(owner.queries.find(query => query.name === "machine_name_get_v1").values, ["owner", derived]);

  const legacy = await owner.request(JSON.stringify({ name: "Studio" }), "POST");
  assert.equal(legacy.status, 400);
  assert.equal((await legacy.json()).code, "invalid_machine_identity");

  const agent = route({ id: "owner", agentRun: { runId: "run" } });
  for (const method of ["POST", "GET"]) assert.equal((await agent.request(
    method === "POST" ? JSON.stringify({ name: "Studio" }) : undefined, method)).status, 403);
  assert.deepEqual(agent.queries, []);
});

test("renaming touches only the owner's Machine, reports a taken name and never serves an Agent run", async () => {
  const owner = route({ id: "owner" }, { machine_rename_v1: [{ name: "Studio" }] });
  const response = await owner.request(JSON.stringify({ name: " Studio " }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { machineId: "machine:a", name: "Studio" });
  assert.deepEqual(owner.queries.find(query => query.name === "machine_rename_v1").values, ["owner", "machine:a", "Studio"]);
  assert.equal((await owner.request("{")).status, 400);

  const taken = await route({ id: "owner" }, { machine_rename_taken_v1: [{ machine_id: "machine:b" }] })
    .request(JSON.stringify({ name: "Laptop" }));
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).code, "machine_name_taken");

  const agent = route({ id: "owner", agentRun: { runId: "run" } });
  assert.equal((await agent.request(JSON.stringify({ name: "Studio" }))).status, 403);
  assert.deepEqual(agent.queries, []);
});

test("PostgreSQL adopts legacy Machine ids only into a derived id", async () => {
  const database = { cacheMode: "disabled", transaction: async (_context, callback) => callback({ query: async () => [] }) };
  const derivedId = `machine:${"a".repeat(64)}`;
  const legacy = "machine:11111111-1111-4111-8111-111111111111";
  const adopt = (machineId) => adoptLegacyMachineIds(database, { requestId: "adopt", ownerUserId: "owner",
    machineId, legacyMachineIds: [legacy], daemonId: stableMachineDaemonId });

  // Nothing of the owner spells the legacy id, so nothing is adopted.
  assert.deepEqual(await adopt(derivedId), { machineId: derivedId, adopted: [], reused: [] });
  await assert.rejects(adopt(legacy), { code: "invalid_machine_identity", status: 400 });
});

test("the serving Hub enforces chosen naming even if a caller sends a false gate", async () => {
  const env = { MACHINE_NAME_REQUIRED: "true",
    RELAY_POSTGRES: { connectionString: "postgres://unused" }, RELAY_POSTGRES_SHARD_ID: "shard" };
  const queries = [];
  const database = { cacheMode: "disabled", transaction: async (_context, callback) => callback({
    query: async query => { queries.push(query); return []; },
  }) };
  await assert.rejects(machineDaemonCommand(env, { action: "enroll", commandId: "enroll",
    ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: `machine:${"d".repeat(64)}`, hostId: "hostname",
    principal: { kind: "user", id: "owner" }, payload: {}, requireMachineName: false }, { database }),
  { status: 409, code: "machine_name_required" });
  assert.equal(queries.some(query=>query.text.includes("INSERT") || query.text.includes("UPDATE")),false);
});
