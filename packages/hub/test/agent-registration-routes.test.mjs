import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  registerAgentRegistrationRoutes,
} from "../src/index-routes-agent-registration.ts";
import { ControlError } from "@xmatrix/db";
import { getAgentRegistration, refreshAgentRegistrationQuota } from "../src/agent-registrations.ts";
const key = { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" };
const body = { action: "offer", key, commandId: "offer", displayName: "codex" };

function fixture(user = { id: "owner" }) {
  const calls = [], app = new Hono();
  const record = name => async (_env, input) => { calls.push({ name, input }); return { key }; };
  registerAgentRegistrationRoutes(app, { authenticate: async () => user,
    control: record("control"), get: record("get"),
    changeEnvironment: record("changeEnvironment"), getEnvironment: record("getEnvironment") });
  return { calls, request: (payload = body, action = "commands", physical = false) => app.request(
    `${physical ? "/api/agent-environments" : "/api/spaces/space/agent-registrations"}/${action}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, {}) };
}

test("registration HTTP commands bind the authenticated human and structured Space key", async () => {
  const route = fixture();
  const response = await route.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(route.calls, [{ name: "control", input: { actorUserId: "owner", command: body, byAgent: false } }]);
  assert.equal((await route.request(key, "query")).status, 200);
  assert.deepEqual(route.calls[1], { name: "get", input: { actorUserId: "owner", key } });
});

test("physical environment endpoints are owned by the authenticated machine owner, not Space administration", async () => {
  const { spaceId: _spaceId, ...physicalKey } = key;
  const command = { key: physicalKey, commandId: "environment", expectedVersion: 0, expectedMachineVersion: 0,
    machineMaxConcurrent: 1, environment: { schemaVersion: 1, enabled: true, models: ["model"], description: "",
      availability: "interactive", maxConcurrent: 1, capabilities: [] } };
  const owner = fixture();
  assert.equal((await owner.request(command, "commands", true)).status, 200);
  assert.equal(owner.calls[0].name, "changeEnvironment");
  assert.equal(owner.calls[0].input.actorUserId, "owner");
  assert.equal((await owner.request(physicalKey, "query", true)).status, 200);
  const admin = fixture({ id: "space-admin" });
  assert.equal((await admin.request(command, "commands", true)).status, 404);
  assert.equal((await admin.request(physicalKey, "query", true)).status, 404);
  assert.equal(admin.calls.length, 0);
  assert.equal((await owner.request({ ...command, key }, "commands", true)).status, 400);
});

test("an Agent Run adds an Agent for its owner on its own Machine in its own Space, and nothing else", async () => {
  const run = { ownerUserId: "owner", spaceId: "space", machineId: "machine" };
  const create = { action: "create", key, commandId: "create", displayName: "codex", environment: {
    schemaVersion: 1, enabled: true, models: [], description: "", availability: "unknown", capabilities: [],
    launch: { runtime: "codex", runtimeArgs: [], sandboxMode: "off", requestReviewer: "low-risk-auto" } } };
  const agent = fixture({ id: "agent-run:run", agentRun: run });
  const added = await agent.request(create);
  assert.equal(added.status, 200, await added.clone().text());
  assert.deepEqual([agent.calls[0].input.actorUserId, agent.calls[0].input.byAgent], ["owner", true],
    "it acts as its owner, without an admin's creation exception");
  for (const [payload, why] of [[body, "only adding"], [{ ...create, key: { ...key, machineId: "other" } }, "only its Machine"],
    [{ ...create, key: { ...key, ownerUserId: "someone" } }, "only for its owner"]]) {
    assert.equal((await agent.request(payload)).status, 403, why);
  }
  assert.equal((await agent.request(key, "query")).status, 403, "registration queries stay with people");
  assert.equal(agent.calls.length, 1);
  const elsewhere = fixture({ id: "agent-run:run", agentRun: { ...run, spaceId: "other" } });
  assert.equal((await elsewhere.request(create)).status, 403, "only in its own Space");
});

test("Agent Runs, spoofed principals, oversized input and cross-Space selections never reach authority", async () => {
  const agent = fixture({ id: "owner", agentRun: { ownerUserId: "owner", spaceId: "space", machineId: "machine" } });
  assert.equal((await agent.request()).status, 403);
  assert.equal(agent.calls.length, 0);
  const route = fixture();
  for (const [payload, status] of [[{ ...body, principal: { kind: "user", id: "admin" } }, 400],
    [{ ...body, key: { ...key, spaceId: "other" } }, 404],
    [{ ...body, displayName: "x".repeat(40_000) }, 413],
    [{ ...body, key: { ...key, profileId: "old-id" } }, 400]]) {
    assert.equal((await route.request(payload)).status, status);
  }
  assert.equal(route.calls.length, 0);
});

test("registration query resolves current placement and closes its request session", async () => {
  const contexts = [];
  let closed = 0;
  const database = { cacheMode: "disabled", openSession() { return { ...this, close: async () => { closed++; } }; },
    transaction: async (context, callback) => {
      contexts.push(context);
      return callback({ query: async ({ name }) => {
        if (name === "space_placement_resolve_v1") return [{ space_id: "space", shard_id: "shard-1",
          placement_epoch: 7, state: "active", target_shard_id: null, plan_class: "default" }];
        if (name === "registration_authority_active_v1") return [{ mode: "composite" }];
        if (name === "registration_get_visibility_v1") return [{}];
        if (name === "registration_control_member_v1") return [{ role: "member" }];
        if (name === "registration_control_get_v3") return [{ display_name: "codex", version: 1,
          configuration_json: { workspaceReferences: ["do-not-expose"] } }];
        assert.fail(name);
      } });
    } };
  const registration = await getAgentRegistration({}, { actorUserId: "member", key }, { database });
  assert.equal(registration.configuration, undefined);
  assert.equal(contexts[0].placement, undefined);
  assert.equal(contexts[1].placement.shardId, "shard-1");
  assert.equal(contexts[1].placement.placementEpoch, 7);
  assert.equal(closed, 1);
});

test("the Agents page catalog read asks for a quota refresh after answering; other reads do not", async () => {
  const calls = [], waited = [], app = new Hono();
  registerAgentRegistrationRoutes(app, { authenticate: async () => ({ id: "member" }),
    list: async () => ({ registrations: [], cursor: null }),
    refreshQuota: async (_env, input) => { calls.push(input); return { issued: 1 }; } });
  const read = path => app.request(path, {}, {}, { waitUntil: task => waited.push(task), passThroughOnException() {} });
  assert.equal((await read("/api/spaces/space/agent-registrations")).status, 200);
  assert.deepEqual(calls, []);
  assert.equal((await read("/api/spaces/space/agent-registrations?quota=refresh")).status, 200);
  await Promise.all(waited);
  assert.deepEqual(calls, [{ actorUserId: "member", spaceId: "space" }]);
});

function refreshDatabase({ role = "member", daemons }) {
  const seen = [];
  const database = { cacheMode: "disabled", openSession() { return { ...this, close: async () => {} }; },
    transaction: async (_context, callback) => callback({ query: async ({ name, values }) => {
      seen.push({ name, values });
      if (name === "space_placement_resolve_v1") return [{ space_id: "space", shard_id: "shard-1",
        placement_epoch: 7, state: "active", target_shard_id: null, plan_class: "default" }];
      if (name === "registration_control_member_v1") return role ? [{ role }] : [];
      if (name === "registration_quota_probe_registrations_v1") return [{ owner_user_id: "owner",
        machine_id: "machine", harness: "claude" }];
      if (name === "registration_quota_probe_daemons_v5") return daemons;
      assert.fail(name);
    } }) };
  return { database, seen };
}

const refresh = (actorUserId, database, quotaProbes) =>
  refreshAgentRegistrationQuota({}, { actorUserId, spaceId: "space" }, { database, quotaProbes });
const daemonRow = patch => ({ owner: "owner", machine: "machine", harness: "claude", environment_version: 3,
  quota_pool_id: "pool", hostname: "host", connection_epoch: 5, recently_probed: false, ...patch });
const quotaProbes = issued => ({
  machines: { getDaemon: async () => ({ daemon: { id: "daemon", email: "o@example.test", status: "online",
    capabilities: ["machine_quota_probe_v2"] } }) },
  issue: async (command) => { issued.push(command); return {}; } });

test("a Space member's quota refresh probes each daemon at most once a minute, asking for window names", async () => {
  const issued = [];
  const { database, seen } = refreshDatabase({ daemons: [daemonRow()] });
  assert.deepEqual(await refresh("member", database, quotaProbes(issued)), { issued: 1 });
  assert.equal(issued[0].payload.probe.windowLabels, true);
  assert.deepEqual(issued[0].payload.probe.targets.map(target => target.targetId), ["registration:claude"]);
  assert.equal(seen.find(query => query.name === "registration_quota_probe_daemons_v5").values[1], 60_000);

  const again = [];
  const recent = refreshDatabase({ daemons: [daemonRow({ recently_probed: true })] });
  assert.deepEqual(await refresh("member", recent.database, quotaProbes(again)), { issued: 0 });
  assert.equal(again.length, 0);

  // Two online hosts stay ambiguous even when one was just probed.
  const ambiguous = refreshDatabase({ daemons: [daemonRow({ recently_probed: true }), daemonRow({ hostname: "host-2" })] });
  assert.deepEqual(await refresh("member", ambiguous.database, quotaProbes(again)), { issued: 0 });
});

test("only a Space member may refresh its quota", async () => {
  const issued = [];
  const { database, seen } = refreshDatabase({ role: null, daemons: [daemonRow()] });
  await assert.rejects(refresh("outsider", database, quotaProbes(issued)),
    error => error instanceof ControlError && error.status >= 400 && error.status < 500);
  assert.equal(issued.length, 0);
  assert.equal(seen.some(query => query.name.startsWith("registration_quota_probe")), false);
});
