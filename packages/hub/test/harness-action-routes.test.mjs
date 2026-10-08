import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { registerHarnessActionRoutes } from "../src/index-routes-harness-actions.ts";
import { ControlError, readHarnessActionStatus, readRecentHarnessActions } from "@xmatrix/db";
import { HARNESS_ACTION_CLAIM_TTL_MS, HARNESS_ACTION_SETTLE_MS, HARNESS_ACTION_TIMEOUT_MS } from "@xmatrix/protocol";

const daemon = { id: "daemon:a", email: "owner@example.test", machineId: "machine:a", hostId: "host-a", status: "online" };

function route(user, { daemons = [daemon], refusal, status } = {}) {
  const calls = [], app = new Hono();
  registerHarnessActionRoutes(app, { authenticate: async () => user,
    daemons: async () => daemons,
    issue: async (_env, input) => { calls.push({ name: "issue", input });
      if (refusal) throw refusal;
      return { ok: true }; },
    status: async (_env, ownerUserId, controlId) => { calls.push({ name: "status", input: { ownerUserId, controlId } });
      return status ?? { controlId, presetId: "claude", action: "update", status: "running" }; },
    recent: async (_env, ownerUserId, machineId) => { calls.push({ name: "recent", input: { ownerUserId, machineId } });
      return [{ controlId: "harness:00000000-0000-4000-8000-000000000000", presetId: "codex", action: "install",
        status: "expired", error: "gone" }]; } });
  return { calls,
    post: body => app.request("/api/machine-daemons/harness-actions",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, {}),
    get: id => app.request(`/api/machine-daemons/harness-actions/${encodeURIComponent(id)}`, {}, {}),
    list: query => app.request(`/api/machine-daemons/harness-actions${query}`, {}, {}) };
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
    query: async (query) => { queries.push(query); return query.name === "machine_harness_action_status_v2" ? [{
      payload_json: { type: "machine_harness_action", requestId: controlId, presetId: "goose", action: "install" },
      command_id: controlId, status: "pending", result_json: null, completed_at: null, expired: false,
      created_at: new Date("2026-10-07T10:09:00Z") }] : []; } }) };
  assert.deepEqual(await readHarnessActionStatus(database, { requestId: "read", ownerUserId: "owner", controlId }),
    { controlId, presetId: "goose", action: "install", status: "queued", requestedAt: "2026-10-07T10:09:00.000Z" });
  assert.deepEqual(queries[0].values, [controlId, "owner", HARNESS_ACTION_SETTLE_MS]);
});

function statusDatabase(row) {
  return { cacheMode: "disabled", transaction: async (_context, callback) => callback({
    query: async () => [{ command_id: "harness:00000000-0000-4000-8000-000000000000",
      payload_json: { type: "machine_harness_action", requestId: "harness:00000000-0000-4000-8000-000000000000",
        presetId: "codex", action: "install" }, result_json: null, completed_at: null, expired: false, abandoned: false,
      created_at: new Date("2026-10-07T10:09:00Z"), ...row }] }) };
}

test("an action the daemon stopped answering settles as expired instead of running forever", async () => {
  const read = row => readHarnessActionStatus(statusDatabase(row), { requestId: "read", ownerUserId: "owner",
    controlId: "harness:00000000-0000-4000-8000-000000000000" });
  assert.equal((await read({ status: "leased" })).status, "running");
  const abandoned = await read({ status: "leased", abandoned: true });
  assert.equal(abandoned.status, "expired");
  assert.match(abandoned.error, /stopped responding before it reported a result/u);
  const unclaimed = await read({ status: "pending", expired: true });
  assert.equal(unclaimed.status, "expired");
  assert.match(unclaimed.error, /did not pick up the action/u);
  // A result that arrives late still wins over the settled reading.
  const late = await read({ status: "completed", abandoned: true, result_json: { result: {
    presetId: "codex", action: "install", status: "succeeded", item: { id: "codex", installed: false, probeStatus: "missing" } } } });
  assert.equal(late.status, "succeeded");
  assert.equal(HARNESS_ACTION_SETTLE_MS > HARNESS_ACTION_CLAIM_TTL_MS + HARNESS_ACTION_TIMEOUT_MS, true);
});

test("recent actions are read for one of the caller's Machines, newest per preset", async () => {
  const owner = route({ id: "owner" });
  const response = await owner.list("?machineId=machine%3Aa");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.json()).actions[0].status, "expired");
  assert.deepEqual(owner.calls.at(-1), { name: "recent", input: { ownerUserId: "owner", machineId: "machine:a" } });
  assert.equal((await owner.list("")).status, 400);
  const agent = route({ id: "agent-run:run", agentRun: { runId: "run", ownerUserId: "owner" } });
  assert.equal((await agent.list("?machineId=machine%3Aa")).status, 403);
  assert.deepEqual(agent.calls, []);

  const queries = [];
  const database = { cacheMode: "disabled", transaction: async (_context, callback) => callback({
    query: async (query) => { queries.push(query); return []; } }) };
  assert.deepEqual(await readRecentHarnessActions(database, { requestId: "r", ownerUserId: "owner", machineId: "machine:a" }), []);
  assert.deepEqual(queries[0].values.slice(0, 2), ["owner", "machine:a"]);
  assert.equal(queries[0].values[2].includes("release"), false, "Hub's own release notices are not the owner's actions");
  assert.equal(queries[0].values[2].some(action => action.startsWith("login")), false);
  assert.match(queries[0].text, /DISTINCT ON \(payload_json->>'presetId'\)/u);
});

test("only login_finish carries the code the owner pasted", async () => {
  const owner = route({ id: "owner" });
  const response = await owner.post({ machineId: "machine:a", presetId: "claude", action: "login_finish", code: "  pasted#code  " });
  assert.equal(response.status, 202);
  const issued = owner.calls.find(call => call.name === "issue").input;
  assert.deepEqual({ ...issued.payload, requestId: "x" },
    { type: "machine_harness_action", requestId: "x", presetId: "claude", action: "login_finish", code: "pasted#code" });
  for (const body of [{ action: "login_start", code: "abc" }, { action: "update", code: "abc" },
    { action: "login_finish", code: "a\nb" }, { action: "login_finish", code: "" }, { action: "login_finish", code: 7 }]) {
    assert.equal((await owner.post({ machineId: "machine:a", presetId: "claude", ...body })).status, 400, JSON.stringify(body));
  }
  assert.equal(owner.calls.filter(call => call.name === "issue").length, 1);
});
