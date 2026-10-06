import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { registerHarnessActionRoutes } from "../src/index-routes-harness-actions.ts";
import { ControlError, readHarnessActionStatus } from "@xmatrix/db";

const daemon = { id: "daemon:a", email: "owner@example.test", machineId: "machine:a", hostId: "host-a", status: "online" };

function route(user, { daemons = [daemon], refusal, status } = {}) {
  const calls = [], app = new Hono();
  registerHarnessActionRoutes(app, { authenticate: async () => user,
    daemons: async () => daemons,
    issue: async (_env, input) => { calls.push({ name: "issue", input });
      if (refusal) throw refusal;
      return { ok: true }; },
    status: async (_env, ownerUserId, controlId) => { calls.push({ name: "status", input: { ownerUserId, controlId } });
      return status ?? { controlId, presetId: "claude", action: "update", status: "running" }; } });
  return { calls,
    post: body => app.request("/api/machine-daemons/harness-actions",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, {}),
    get: id => app.request(`/api/machine-daemons/harness-actions/${encodeURIComponent(id)}`, {}, {}) };
}

test("the owner issues a preset and action only; the Hub never carries a command", async () => {
  const owner = route({ id: "owner" });
  const response = await owner.post({ machineId: "machine:a", presetId: "claude", action: "update", command: "rm -rf /" });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.match(body.controlId, /^harness:[0-9a-f-]{36}$/u);
  assert.deepEqual({ ...body, controlId: "x" }, { controlId: "x", presetId: "claude", action: "update", status: "queued" });
  const issued = owner.calls.find(call => call.name === "issue").input;
  assert.deepEqual(issued.payload, { type: "machine_harness_action", requestId: body.controlId, presetId: "claude", action: "update" });
  assert.deepEqual([issued.ownerUserId, issued.machineId, issued.hostId, issued.daemonId, issued.action, issued.commandType],
    ["owner", "machine:a", "host-a", "daemon:a", "issue", "harness_action"]);
  assert.deepEqual(issued.principal, { kind: "user", id: "owner" });
});

test("Agent runs, bad input and offline Machines are refused before anything is issued", async () => {
  const agent = route({ id: "agent-run:run", agentRun: { runId: "run", ownerUserId: "owner" } });
  assert.equal((await agent.post({ machineId: "machine:a", presetId: "claude", action: "update" })).status, 403);
  assert.deepEqual(agent.calls, []);
  // It follows its owner's harness actions, as the owner reads them.
  await agent.get("harness:00000000-0000-4000-8000-000000000000");
  assert.deepEqual(agent.calls.map(call => call.input.ownerUserId), ["owner"]);

  const owner = route({ id: "owner" });
  for (const body of [{ machineId: "machine:a", presetId: "claude", action: "purge" },
    { machineId: "machine:a", presetId: "../x", action: "update" }, { presetId: "claude", action: "update" },
    { machineId: "machine:a", hostId: 3, presetId: "claude", action: "update" }]) {
    assert.equal((await owner.post(body)).status, 400);
  }
  const offline = route({ id: "owner" }, { daemons: [{ ...daemon, status: "offline" }] });
  assert.equal((await offline.post({ machineId: "machine:a", presetId: "claude", action: "install" })).status, 409);
  const twoHosts = route({ id: "owner" }, { daemons: [daemon, { ...daemon, id: "daemon:b", hostId: "host-b" }] });
  assert.equal((await twoHosts.post({ machineId: "machine:a", presetId: "claude", action: "install" })).status, 409);
  assert.equal((await twoHosts.post({ machineId: "machine:a", hostId: "host-b", presetId: "claude", action: "install" })).status, 409);
  assert.equal(twoHosts.calls.some(call => call.name === "issue"), false,
    "a hostname never disambiguates Machine identity");
  for (const caller of [owner, offline]) assert.equal(caller.calls.some(call => call.name === "issue"), false);
});

test("an authority refusal is forwarded and status reads are owner-scoped", async () => {
  const refused = route({ id: "owner" }, { refusal: new ControlError("harness_action_unavailable", 409, "unavailable") });
  const refusal = await refused.post({ machineId: "machine:a", presetId: "claude", action: "update" });
  assert.equal(refusal.status, 409);
  assert.equal((await refusal.json()).code, "harness_action_unavailable");

  const owner = route({ id: "owner" });
  const id = "harness:00000000-0000-4000-8000-000000000000";
  const read = await owner.get(id);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).status, "running");
  assert.deepEqual(owner.calls.at(-1), { name: "status", input: { ownerUserId: "owner", controlId: id } });
  assert.equal((await owner.get("quota:1")).status, 404);
  const missing = route({ id: "owner" }, { status: { controlId: id, status: "missing" } });
  assert.equal((await missing.get(id)).status, 404);
});

test("harness action status is read within its owner", async () => {
  const queries = [];
  const controlId = "harness:00000000-0000-4000-8000-000000000000";
  const database = { cacheMode: "disabled", transaction: async (_context, callback) => callback({
    query: async (query) => { queries.push(query); return query.name === "machine_harness_action_status_v1" ? [{
      payload_json: { type: "machine_harness_action", requestId: controlId, presetId: "goose", action: "install" },
      status: "pending", result_json: null, completed_at: null, expired: false }] : []; } }) };
  assert.deepEqual(await readHarnessActionStatus(database, { requestId: "read", ownerUserId: "owner", controlId }),
    { controlId, presetId: "goose", action: "install", status: "queued" });
  assert.deepEqual(queries[0].values, [controlId, "owner"]);
});
